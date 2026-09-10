import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OPENCODE_MISSION_CONTROL_PLUGIN_MARKER,
  OPENCODE_MISSION_CONTROL_PLUGIN_SEGMENTS,
  opencodeMissionControlPluginPath,
  opencodeMissionControlPluginSource,
  writeOpencodeMissionControlPlugin,
} from "../opencode-mission-control-plugin";

describe("opencode mission control plugin", () => {
  it("posts lifecycle hooks to the OpenCode hooks endpoint", () => {
    const source = opencodeMissionControlPluginSource();
    expect(source).toContain(OPENCODE_MISSION_CONTROL_PLUGIN_MARKER);
    expect(source).toContain("/api/hooks/opencode");
    expect(source).toContain("session.status");
    expect(source).toContain("session.idle");
    expect(source).toContain('postMissionControlHook("Stop"');
    expect(source).toContain('postMissionControlHook("UserPromptSubmit"');
    expect(source).toContain('postMissionControlHook("SessionStart"');
    expect(source).toContain('"PermissionRequest"');
    expect(source).toContain("MC_TASK_ID");
    expect(source).toContain('"shell.env"');
    expect(source).toContain('"chat.message"');
    expect(source).toContain('"tool.execute.before"');
    expect(source).toContain("question.asked");
    expect(source).toContain('"QuestionRequest"');
    expect(source).toContain("electron-local");
    expect(source).toContain("export const MissionControlStatus");
  });

  it("writes the managed plugin into .opencode/plugins", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mc-opencode-plugin-"));
    writeOpencodeMissionControlPlugin(cwd);

    const file = opencodeMissionControlPluginPath(cwd);
    expect(fs.existsSync(file)).toBe(true);
    const contents = fs.readFileSync(file, "utf8");
    expect(contents).toContain(OPENCODE_MISSION_CONTROL_PLUGIN_MARKER);
    expect(contents).toContain("MissionControlStatus");
  });
});

describe("machine-readable identifiers survive the rename (R20, KD7)", () => {
  it("keeps the plugin filename the app writes and looks for", () => {
    // The app recognizes its own installed plugin by this path. Renaming it
    // makes the app stop seeing what it wrote and leave a duplicate behind in
    // the user's project.
    expect([...OPENCODE_MISSION_CONTROL_PLUGIN_SEGMENTS]).toEqual([
      ".opencode",
      "plugins",
      "mission-control.js",
    ]);
  });

  it("keeps the managed marker the app matches on", () => {
    expect(OPENCODE_MISSION_CONTROL_PLUGIN_MARKER).toBe("@mission-control-managed");
    expect(opencodeMissionControlPluginSource()).toContain(
      OPENCODE_MISSION_CONTROL_PLUGIN_MARKER,
    );
  });

  it("keeps the exported symbol that marks the plugin as managed", () => {
    expect(opencodeMissionControlPluginSource()).toContain("export const MissionControlStatus");
  });

  it("keeps the hook event names the plugin posts", () => {
    const source = opencodeMissionControlPluginSource();
    for (const event of ["UserPromptSubmit", "Stop"]) {
      expect(source).toContain(event);
    }
  });

  it("renames only the prose a person reads", () => {
    const source = opencodeMissionControlPluginSource();
    expect(source).toContain("Chaos Wrangler");
    // The identifiers above still carry the previous token; the prose does not.
    expect(source).not.toContain("Mission Control");
  });
});
