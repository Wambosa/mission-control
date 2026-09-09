import * as path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The lint rule is the durable half of the un-blocking work.
 *
 * Converting today's call sites to asynchronous filesystem calls is a one-time
 * fix; without an enforced invariant the next scaffolding helper reintroduces
 * the freeze. This asserts the rule actually fires on the modules that run
 * against a session's working directory — and, just as importantly, that it
 * does not fire everywhere else.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

const CWD_SCOPED_MODULES = [
  "electron/session-scaffolding.ts",
  "electron/ensure-diagram-skill.ts",
  "electron/ensure-recall-skill.ts",
  "electron/ensure-recall-mcp.ts",
  "electron/agent-memory-brief.ts",
  "src/shared/agent-memory-file.ts",
];

const SYNC_CALL = `
import * as fs from "node:fs";
export function sneakyHelper(cwd: string): string {
  return fs.readFileSync(cwd + "/.gitignore", "utf8");
}
`;

async function lintAs(filePath: string, source: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(source, {
    filePath: path.join(repoRoot, filePath),
  });
  return result.messages.filter((message) => message.ruleId === "no-restricted-syntax");
}

describe("synchronous filesystem calls in session-scaffolding code", () => {
  it.each(CWD_SCOPED_MODULES)("is rejected in %s", async (filePath) => {
    const messages = await lintAs(filePath, SYNC_CALL);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.map((m) => m.message).join("\n")).toMatch(/session-scaffolding|ScaffoldingFs/);
  });

  it("is still allowed outside the cwd-scoped modules", async () => {
    expect(await lintAs("electron/pty-manager.ts", SYNC_CALL)).toEqual([]);
  });

  it("passes the modules as they are actually written", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles(CWD_SCOPED_MODULES.map((f) => path.join(repoRoot, f)));
    const offences = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === "no-restricted-syntax")
        .map((message) => `${result.filePath}:${message.line} ${message.message}`),
    );
    expect(offences).toEqual([]);
  });
});
