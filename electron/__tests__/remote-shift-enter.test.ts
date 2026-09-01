import { describe, expect, it } from "vitest";
import { ensureRemoteClaudeShiftEnterBinding, type RemoteFsRpc } from "../remote-shift-enter";

const HOME = "/Users/dev";
const SETTINGS = "/Users/dev/.claude/settings.json";

type Call = { method: string; params: Record<string, unknown> };

function recorder(readResult: unknown, writeResult: unknown = { ok: true, mtimeMs: 2 }) {
  const calls: Call[] = [];
  const rpc: RemoteFsRpc = async (method, params) => {
    calls.push({ method, params });
    return method === "fs.read" ? readResult : writeResult;
  };
  return { calls, rpc };
}

function written(calls: Call[]): Record<string, unknown> | null {
  const write = calls.find((c) => c.method === "fs.write");
  return write ? (JSON.parse(String(write.params.content)) as Record<string, unknown>) : null;
}

const textFile = (content: string, mtimeMs = 1) => ({ ok: true, kind: "text", content, mtimeMs });

describe("ensureRemoteClaudeShiftEnterBinding", () => {
  it("creates a settings file carrying the flag when the host has none", async () => {
    const { calls, rpc } = recorder({ ok: false, error: "not-found" });
    await ensureRemoteClaudeShiftEnterBinding(rpc, HOME);

    expect(calls.map((c) => c.method)).toEqual(["fs.read", "fs.write"]);
    expect(calls[0]!.params.path).toBe(SETTINGS);
    expect(calls[1]!.params.path).toBe(SETTINGS);
    // Nothing to preserve, so nothing to guard against.
    expect(calls[1]!.params.expectedMtimeMs).toBeNull();
    expect(written(calls)).toEqual({ shiftEnterKeyBindingInstalled: true });
  });

  it("does not rewrite a file that already has the flag", async () => {
    const { calls, rpc } = recorder(
      textFile(JSON.stringify({ shiftEnterKeyBindingInstalled: true, theme: "dark" })),
    );
    await ensureRemoteClaudeShiftEnterBinding(rpc, HOME);

    expect(calls.map((c) => c.method)).toEqual(["fs.read"]);
  });

  it("keeps the settings already in the file", async () => {
    const { calls, rpc } = recorder(
      textFile(JSON.stringify({ theme: "dark", permissions: { allow: ["Bash"] } }), 42),
    );
    await ensureRemoteClaudeShiftEnterBinding(rpc, HOME);

    expect(written(calls)).toEqual({
      theme: "dark",
      permissions: { allow: ["Bash"] },
      shiftEnterKeyBindingInstalled: true,
    });
    // The write is guarded against a change made since the read.
    expect(calls[1]!.params.expectedMtimeMs).toBe(42);
  });

  it("writes the flag into an empty file", async () => {
    const { calls, rpc } = recorder(textFile("   "));
    await ensureRemoteClaudeShiftEnterBinding(rpc, HOME);
    expect(written(calls)).toEqual({ shiftEnterKeyBindingInstalled: true });
  });

  // The file is the operator's, in a state we did not create. Rewriting it
  // would be destroying settings to fix a keybinding.
  it("leaves malformed JSON alone rather than overwriting it", async () => {
    const { calls, rpc } = recorder(textFile("{ this is not json"));
    await expect(ensureRemoteClaudeShiftEnterBinding(rpc, HOME)).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["fs.read"]);
  });

  it("leaves a file it could not read alone", async () => {
    const { calls, rpc } = recorder({ ok: false, error: "permission denied" });
    await ensureRemoteClaudeShiftEnterBinding(rpc, HOME);
    expect(calls.map((c) => c.method)).toEqual(["fs.read"]);
  });

  it("does not merge into a JSON value that is not an object", async () => {
    const { calls, rpc } = recorder(textFile("[1, 2, 3]"));
    await ensureRemoteClaudeShiftEnterBinding(rpc, HOME);
    expect(calls.map((c) => c.method)).toEqual(["fs.read"]);
  });

  // A session must never fail to start over a keybinding.
  it("swallows a read failure", async () => {
    const rpc: RemoteFsRpc = async () => {
      throw new Error("agent connection closed");
    };
    await expect(ensureRemoteClaudeShiftEnterBinding(rpc, HOME)).resolves.toBeUndefined();
  });

  it("swallows a write failure", async () => {
    const rpc: RemoteFsRpc = async (method) => {
      if (method === "fs.read") return textFile("{}");
      throw new Error("read-only filesystem");
    };
    await expect(ensureRemoteClaudeShiftEnterBinding(rpc, HOME)).resolves.toBeUndefined();
  });

  it("does nothing without a home directory to write into", async () => {
    const { calls, rpc } = recorder(textFile("{}"));
    await ensureRemoteClaudeShiftEnterBinding(rpc, "   ");
    expect(calls).toEqual([]);
  });

  it("tolerates a trailing slash on the home directory", async () => {
    const { calls, rpc } = recorder({ ok: false, error: "ENOENT: no such file" });
    await ensureRemoteClaudeShiftEnterBinding(rpc, "/Users/dev/");
    expect(calls[0]!.params.path).toBe(SETTINGS);
  });
});
