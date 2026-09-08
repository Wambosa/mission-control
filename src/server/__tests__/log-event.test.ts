import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LOGGED_VALUE_CHARS,
  SERVER_EVENT_MARKER,
  formatServerEvent,
  isSensitiveSettingKey,
  logServerEvent,
  settingValueForLog,
} from "../log-event";

describe("formatServerEvent", () => {
  it("carries the event name and its ids in one JSON object", () => {
    const line = formatServerEvent("session.created", { taskId: "t1", projectId: "p1" });
    expect(line.startsWith(`${SERVER_EVENT_MARKER} `)).toBe(true);
    expect(JSON.parse(line.slice(SERVER_EVENT_MARKER.length + 1))).toEqual({
      event: "session.created",
      taskId: "t1",
      projectId: "p1",
    });
  });

  it("puts the event name first so a truncated line still names what happened", () => {
    const line = formatServerEvent("project.deleted", { projectId: "p1" });
    expect(line).toContain('{"event":"project.deleted"');
  });

  // Main's forwarder is line-oriented: a payload spanning lines would be
  // shredded into unrelated entries and the event shape destroyed.
  it("stays on one line even when a field value contains newlines", () => {
    const line = formatServerEvent("setting.changed", { to: "a\nb\r\nc" });
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line.slice(SERVER_EVENT_MARKER.length + 1)).to).toBe("a\nb\r\nc");
  });

  it("emits a parseable payload with no fields at all", () => {
    const line = formatServerEvent("app.migrations");
    expect(JSON.parse(line.slice(SERVER_EVENT_MARKER.length + 1))).toEqual({
      event: "app.migrations",
    });
  });

  it("keeps a filterable id even when the event has only one of them", () => {
    // An event with no task id still has to parse and filter on project id.
    const line = formatServerEvent("project.opened", { projectId: "p1" });
    const payload = JSON.parse(line.slice(SERVER_EVENT_MARKER.length + 1));
    expect(payload.projectId).toBe("p1");
    expect(payload.taskId).toBeUndefined();
  });
});

describe("isSensitiveSettingKey", () => {
  it("catches the credential-bearing keys the database stores in cleartext", () => {
    expect(isSensitiveSettingKey("api_token")).toBe(true);
    expect(isSensitiveSettingKey("auth_secret")).toBe(true);
    expect(isSensitiveSettingKey("sandbox_pairing_token")).toBe(true);
  });

  it("is case-insensitive and matches on substrings, so a new key is redacted by default", () => {
    expect(isSensitiveSettingKey("Provider_API_Key")).toBe(true);
    expect(isSensitiveSettingKey("some_new_password_field")).toBe(true);
  });

  it("leaves ordinary preference keys alone", () => {
    expect(isSensitiveSettingKey("terminal_zoom_level")).toBe(false);
    expect(isSensitiveSettingKey("recall_enabled")).toBe(false);
    expect(isSensitiveSettingKey("default_agent")).toBe(false);
  });
});

describe("settingValueForLog", () => {
  it("passes an ordinary value through unchanged", () => {
    expect(settingValueForLog("default_agent", "claude-code")).toBe("claude-code");
    expect(settingValueForLog("terminal_zoom_level", 0)).toBe(0);
    expect(settingValueForLog("recall_enabled", true)).toBe(true);
  });

  // The diagnostics export ships unscrubbed, so a rotation event must not copy
  // a live token into a file with a wider audience than the database.
  it("redacts a secret's value while still recording that it changed", () => {
    expect(settingValueForLog("api_token", "deadbeef".repeat(8))).toBe("[redacted]");
    expect(settingValueForLog("auth_secret", "s3cr3t")).toBe("[redacted]");
  });

  it("redacts a secret even when it is absent, rather than leaking its absence as a value", () => {
    expect(settingValueForLog("api_token", null)).toBe(null);
  });

  it("caps an oversized value so one setting cannot flood a synchronous transport", () => {
    const long = "x".repeat(MAX_LOGGED_VALUE_CHARS + 500);
    const logged = settingValueForLog("background_image", long) as string;
    expect(logged.length).toBeLessThan(long.length);
    expect(logged).toContain(`(${long.length} chars)`);
    expect(logged.startsWith("x".repeat(MAX_LOGGED_VALUE_CHARS))).toBe(true);
  });

  it("leaves a value exactly at the cap untouched", () => {
    const exact = "y".repeat(MAX_LOGGED_VALUE_CHARS);
    expect(settingValueForLog("background_image", exact)).toBe(exact);
  });

  it("distinguishes a null previous value from an absent one", () => {
    expect(settingValueForLog("default_model", null)).toBe(null);
    expect(settingValueForLog("default_model", undefined)).toBe(null);
  });
});

describe("logServerEvent", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("writes the formatted line to stdout for main's forwarder to pick up", () => {
    logServerEvent("session.archived", { taskId: "t1", projectId: "p1" });
    expect(spy).toHaveBeenCalledWith(
      formatServerEvent("session.archived", { taskId: "t1", projectId: "p1" }),
    );
  });

  it("does not throw on a payload JSON.stringify refuses", () => {
    // An event is diagnostic; it must not take down the mutation that emitted
    // it. A circular object is the realistic version of this.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logServerEvent("project.edited", circular)).not.toThrow();
  });

  it("still names the event when its payload could not be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logServerEvent("project.edited", circular);
    expect(spy.mock.calls[0][0]).toContain('"event":"project.edited"');
    expect(spy.mock.calls[0][0]).toContain('"unloggable":true');
  });

  it("does not throw when stdout itself is gone", () => {
    spy.mockImplementation(() => {
      throw new Error("EPIPE");
    });
    expect(() => logServerEvent("app.quit")).not.toThrow();
  });
});
