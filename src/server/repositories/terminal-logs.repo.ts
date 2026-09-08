import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "~/db/client";
import { terminalLogs } from "~/db/schema";

export type TerminalLogRow = {
  id: string;
  taskId: string;
  chunk: string;
  createdAt: number;
};

/**
 * Persist a batch of chunks in one transaction.
 *
 * One statement per chunk inside a single transaction rather than one
 * transaction per chunk: the writes arrive on the PTY batcher's flush cadence,
 * and a transaction per row would put an fsync on that path for no benefit.
 */
export function insertTerminalLogs(rows: readonly TerminalLogRow[]): void {
  if (rows.length === 0) return;
  getDb().transaction((tx) => {
    for (const row of rows) tx.insert(terminalLogs).values(row).run();
  });
}

export function findTerminalLogsByTaskId(taskId: string): TerminalLogRow[] {
  return getDb()
    .select()
    .from(terminalLogs)
    .where(eq(terminalLogs.taskId, taskId))
    .orderBy(asc(terminalLogs.createdAt), asc(terminalLogs.id))
    .all();
}

/**
 * Drop the oldest chunks until the task's retained output fits `budgetBytes`.
 *
 * Ordered by creation time, not by id: the id's encoded timestamp is base36 and
 * changes width, so it does not sort chronologically. `id` breaks ties within a
 * millisecond so the order is total and a trim is deterministic. The composite
 * `(task_id, created_at)` index is what keeps this from sorting the task's whole
 * row set.
 *
 * Returns how many rows it removed.
 */
export function trimTerminalLogsForTask(taskId: string, budgetBytes: number): number {
  // Newest first, so the accumulation below keeps the most recent output — the
  // part a postmortem actually reads.
  const rows = getDb()
    .select({ id: terminalLogs.id, chunk: terminalLogs.chunk })
    .from(terminalLogs)
    .where(eq(terminalLogs.taskId, taskId))
    .orderBy(asc(terminalLogs.createdAt), asc(terminalLogs.id))
    .all();

  let kept = 0;
  const doomed: string[] = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(rows[i].chunk, "utf8");
    if (kept + size > budgetBytes && kept > 0) {
      // Everything at or before this row is older than the budget allows.
      for (let j = i; j >= 0; j -= 1) doomed.push(rows[j].id);
      break;
    }
    kept += size;
  }
  if (doomed.length === 0) return 0;

  getDb().transaction((tx) => {
    // Chunked IN() lists so a long-lived session never exceeds SQLite's
    // variable limit, matching the code-graph repository's shape.
    for (const chunk of chunked(doomed, 400)) {
      tx.delete(terminalLogs)
        .where(and(eq(terminalLogs.taskId, taskId), inArray(terminalLogs.id, chunk)))
        .run();
    }
  });
  return doomed.length;
}

export function deleteTerminalLogsForTask(taskId: string): void {
  getDb().delete(terminalLogs).where(eq(terminalLogs.taskId, taskId)).run();
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
