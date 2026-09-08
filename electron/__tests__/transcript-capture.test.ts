import { describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("electron-log/main", () => ({ default: logMock }));

import { transcriptCaptureTarget } from "../pty-manager";
import { buildTaskApiUrl } from "../pty-hook-env";

const MC_ENV = { apiUrl: "http://127.0.0.1:41337", token: "tok-abc" };

function agentPty(over: Partial<{ shell: boolean; taskId: string }> = {}) {
  return { shell: false, taskId: "t-1", ...over };
}

describe("transcriptCaptureTarget", () => {
  it("targets the task's ingest endpoint for an agent session", () => {
    const target = transcriptCaptureTarget(agentPty(), MC_ENV, "output");
    expect(target).toEqual({
      url: "http://127.0.0.1:41337/api/tasks/t-1/terminal-output",
      token: "tok-abc",
    });
  });

  // KTD10. A shell or dashboard terminal's id belongs to a separate entity, and
  // the retention table's key is a foreign key to the task table — the insert
  // would be rejected, so the request never goes out.
  it("drops a shell terminal's output rather than posting an insert that must fail", () => {
    expect(transcriptCaptureTarget(agentPty({ shell: true }), MC_ENV, "output")).toBeNull();
  });

  it("drops an empty batch", () => {
    expect(transcriptCaptureTarget(agentPty(), MC_ENV, "")).toBeNull();
  });

  // The credentials come from the hook-environment accessor, not from the
  // per-PTY field: that field is populated only for agent-mode PTYs, so reading
  // it would silently skip sessions spawned without it. This asserts the shape
  // that accessor can return, including its absent case.
  it("drops the batch when no credentials are available yet", () => {
    expect(transcriptCaptureTarget(agentPty(), null, "output")).toBeNull();
    expect(transcriptCaptureTarget(agentPty(), undefined, "output")).toBeNull();
  });

  it("drops the batch when the credentials are incomplete", () => {
    expect(
      transcriptCaptureTarget(agentPty(), { apiUrl: "http://127.0.0.1:41337", token: "" }, "x"),
    ).toBeNull();
    expect(transcriptCaptureTarget(agentPty(), { apiUrl: "", token: "tok" }, "x")).toBeNull();
  });

  it("captures for an agent session regardless of how it was spawned", () => {
    // The per-PTY credential field is absent here; capture still resolves,
    // because the accessor supplied them.
    expect(transcriptCaptureTarget({ shell: false, taskId: "t-9" }, MC_ENV, "out")).not.toBeNull();
  });

  it("refuses a batch whose api URL is not a permitted local host", () => {
    expect(
      transcriptCaptureTarget(agentPty(), { apiUrl: "http://evil.example:80", token: "t" }, "x"),
    ).toBeNull();
  });

  it("refuses a non-http api URL", () => {
    expect(
      transcriptCaptureTarget(agentPty(), { apiUrl: "https://127.0.0.1:41337", token: "t" }, "x"),
    ).toBeNull();
  });

  it("refuses a task id that is not an id", () => {
    expect(transcriptCaptureTarget(agentPty({ taskId: "" }), MC_ENV, "x")).toBeNull();
    expect(transcriptCaptureTarget(agentPty({ taskId: "../../etc" }), MC_ENV, "x")).toBeNull();
  });
});

describe("buildTaskApiUrl", () => {
  it("builds a task-scoped API path", () => {
    expect(buildTaskApiUrl(MC_ENV, "t-1", "terminal-output")).toBe(
      "http://127.0.0.1:41337/api/tasks/t-1/terminal-output",
    );
  });

  it("accepts the sandbox host the hook URLs already allow", () => {
    expect(
      buildTaskApiUrl({ apiUrl: "http://host.docker.internal:41337", token: "t" }, "t-1", "terminal-output"),
    ).toBe("http://host.docker.internal:41337/api/tasks/t-1/terminal-output");
  });

  it("requires a port, so a bare host cannot be posted to", () => {
    expect(buildTaskApiUrl({ apiUrl: "http://127.0.0.1", token: "t" }, "t-1", "x")).toBeNull();
  });

  it("rejects an unparseable api URL", () => {
    expect(buildTaskApiUrl({ apiUrl: "not a url", token: "t" }, "t-1", "x")).toBeNull();
  });

  it("rejects a path segment that is not a plain slug", () => {
    expect(buildTaskApiUrl(MC_ENV, "t-1", "../secrets")).toBeNull();
    expect(buildTaskApiUrl(MC_ENV, "t-1", "Terminal-Output")).toBeNull();
  });

  it("percent-encodes the task id rather than letting it shape the path", () => {
    // The id is already validated, but the encoding is what makes that a
    // defence in depth rather than the only line.
    expect(buildTaskApiUrl(MC_ENV, "t-1:2", "terminal-output")).toBe(
      "http://127.0.0.1:41337/api/tasks/t-1%3A2/terminal-output",
    );
  });
});
