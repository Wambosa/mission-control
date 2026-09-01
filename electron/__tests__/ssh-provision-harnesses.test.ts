import { describe, expect, it, vi } from "vitest";
import { installSshHarnesses, sshHarnessInstalls } from "../ssh-provision-harnesses";
import type { SshExec } from "../ssh-exec";
import type { SshProvisionPlan, SshProvisionStep } from "../../src/shared/ssh-provision";
import { TASK_AGENTS, type TaskAgent } from "../../src/shared/domain";

const PREFIX = "/home/sam/.mission-control";

function plan(missing: readonly TaskAgent[]): SshProvisionPlan {
  const steps: SshProvisionStep[] = missing.map((agent) => ({ kind: "harness", agent }));
  return { ok: true, platform: "linux", arch: "x64", prefix: PREFIX, steps };
}

function exec(failFor: readonly string[] = []): { run: SshExec; scripts: string[] } {
  const scripts: string[] = [];
  const run: SshExec = async (_args, stdin) => {
    scripts.push(stdin);
    const failing = failFor.find((needle) => stdin.includes(needle));
    return failing
      ? { code: 1, stdout: "", stderr: `npm error 404 Not Found - ${failing}\n` }
      : { code: 0, stdout: "", stderr: "" };
  };
  return { run, scripts };
}

describe("sshHarnessInstalls", () => {
  it("installs only the harnesses the host is missing (AE2)", () => {
    const installs = sshHarnessInstalls(plan(["codex", "opencode"]));

    expect(installs.map((i) => i.agent)).toEqual(["codex", "opencode"]);
    const codex = installs.find((i) => i.agent === "codex")!;
    expect(codex.kind).toBe("install");
    expect(codex.kind === "install" && codex.script).toContain("@openai/codex");
  });

  it("generates nothing for a host that already has every harness", () => {
    expect(sshHarnessInstalls(plan([]))).toEqual([]);
  });

  it("targets the prefix rather than a global location", () => {
    const installs = sshHarnessInstalls(plan(TASK_AGENTS));

    const scripts = installs.flatMap((i) => (i.kind === "install" ? [i.script] : []));
    expect(scripts).not.toHaveLength(0);
    for (const script of scripts) {
      expect(script).toContain(`MC_PREFIX='${PREFIX}'`);
      for (const install of script.match(/npm install[^\n]*/g) ?? []) {
        expect(install).toContain(`--prefix "$MC_PREFIX"`);
      }
      expect(script).not.toMatch(/\bsudo\b/);
      expect(script).not.toMatch(/\/usr\/local\/(lib|bin)/);
      expect(script).not.toMatch(/\.(bashrc|zshrc|profile|bash_profile|zprofile)\b/);
    }
  });

  it("redirects a shell installer's HOME so its tree lands inside the prefix", () => {
    // cursor-cli ships no npm package, and its installer places everything
    // relative to $HOME. Giving it a $HOME under the prefix is what keeps
    // "removing the host is rm -rf on one directory" true.
    const cursor = sshHarnessInstalls(plan(["cursor-cli"]))[0];

    expect(cursor.kind).toBe("install");
    const script = cursor.kind === "install" ? cursor.script : "";
    expect(script).toContain('mc_home="$MC_PREFIX/cursor"');
    expect(script).toMatch(/HOME="\$mc_home" bash/);
  });

  it("leaves nothing of a shell-installed harness outside the prefix", () => {
    const script = sshHarnessInstalls(plan(["cursor-cli"]))[0];
    const text = script.kind === "install" ? script.script : "";

    // Every path it writes or links is anchored to the prefix.
    expect(text).not.toMatch(/(^|[^/\w])~\/\.local/);
    expect(text).not.toMatch(/\$HOME\/\.local/);
    expect(text).not.toMatch(/\.(bashrc|zshrc|profile|bash_profile|zprofile)/);
  });

  it("links the harness into the prefix bin the service PATH already searches", () => {
    const script = sshHarnessInstalls(plan(["cursor-cli"]))[0];
    const text = script.kind === "install" ? script.script : "";

    expect(text).toContain('"$MC_PREFIX/bin/cursor-agent"');
    // The installer's own exit status is not the question; the binary is.
    expect(text).toMatch(/if \[ ! -e "\$MC_PREFIX\/bin\/cursor-agent" \]/);
  });

  it("can install every harness it manages, so a connected host has them all", () => {
    // The connect-and-go property: nothing is left for the user to go and set
    // up by hand after adding a host.
    const installs = sshHarnessInstalls(plan(TASK_AGENTS));

    expect(installs.every((i) => i.kind === "install")).toBe(true);
  });
});

describe("installSshHarnesses", () => {
  it("reports each harness it installed", async () => {
    const { run, scripts } = exec();

    const results = await installSshHarnesses("workshop", plan(["codex", "opencode"]), {
      exec: run,
    });

    expect(results).toEqual([
      { agent: "codex", status: "installed" },
      { agent: "opencode", status: "installed" },
    ]);
    expect(scripts).toHaveLength(2);
  });

  it("keeps going when one harness fails, so the connect still succeeds", async () => {
    const { run } = exec(["@openai/codex"]);

    const results = await installSshHarnesses("workshop", plan(["codex", "opencode"]), {
      exec: run,
    });

    expect(results[0]).toMatchObject({ agent: "codex", status: "failed" });
    expect(results[0]).toHaveProperty("error", expect.stringMatching(/404 Not Found/));
    expect(results[1]).toEqual({ agent: "opencode", status: "installed" });
  });

  it("surfaces an SSH refusal in SSH's terms rather than as an install failure", async () => {
    const run: SshExec = async () => ({
      code: 255,
      stdout: "",
      stderr: "Host key verification failed.\n",
    });

    const [result] = await installSshHarnesses("workshop", plan(["codex"]), { exec: run });

    expect(result).toMatchObject({ agent: "codex", status: "failed" });
    expect(result).toHaveProperty(
      "error",
      expect.stringMatching(/will not accept a host key on your behalf/i),
    );
  });

  it("installs a shell-distributed harness rather than handing it to the user", async () => {
    const { run, scripts } = exec();

    const results = await installSshHarnesses("workshop", plan(["cursor-cli"]), { exec: run });

    expect(results[0]).toMatchObject({ agent: "cursor-cli", status: "installed" });
    expect(scripts[0]).toContain("cursor.com/install");
  });

  it("never touches the host when every harness is already present", async () => {
    const run = vi.fn<SshExec>(async () => ({ code: 0, stdout: "", stderr: "" }));

    const results = await installSshHarnesses("workshop", plan([]), { exec: run });

    expect(results).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports progress for each harness as it goes", async () => {
    const { run } = exec(["@openai/codex"]);
    const seen: string[] = [];

    await installSshHarnesses("workshop", plan(["codex", "opencode"]), {
      exec: run,
      onProgress: (progress) => seen.push(`${progress.agent}:${progress.status}`),
    });

    expect(seen).toEqual([
      "codex:running",
      "codex:failed",
      "opencode:running",
      "opencode:installed",
    ]);
  });
});
