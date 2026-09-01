import { describe, expect, it } from "vitest";
import { describeSshBinary, resolveSshBinary, type ResolveSshBinaryInput } from "../ssh-binary";
import { classifySshFailure } from "../ssh-transport";

const WINDOWS_SSH = "C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe";

function input(overrides: Partial<ResolveSshBinaryInput> = {}): ResolveSshBinaryInput {
  return {
    platform: "win32",
    env: { SystemRoot: "C:\\WINDOWS" },
    exists: () => true,
    ...overrides,
  };
}

describe("resolveSshBinary", () => {
  it("runs the ssh Windows ships, not whichever one PATH sorts first", () => {
    // The whole point: Git for Windows usually wins PATH, and its MSYS build
    // refuses keys the system build accepts and cannot reach the Windows agent.
    expect(resolveSshBinary(input())).toEqual({ command: WINDOWS_SSH, source: "system" });
  });

  it("falls back to PATH when Windows has no OpenSSH client installed", () => {
    expect(resolveSshBinary(input({ exists: () => false }))).toEqual({
      command: "ssh",
      source: "path",
    });
  });

  it("reads windir when SystemRoot is not set", () => {
    const choice = resolveSshBinary(input({ env: { windir: "D:\\Windows" } }));

    expect(choice.command).toBe("D:\\Windows\\System32\\OpenSSH\\ssh.exe");
  });

  it("falls back to PATH when Windows names no system root at all", () => {
    expect(resolveSshBinary(input({ env: {} }))).toEqual({ command: "ssh", source: "path" });
  });

  it("leaves POSIX alone, where PATH is the right answer", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(resolveSshBinary(input({ platform }))).toEqual({ command: "ssh", source: "path" });
    }
  });
});

describe("overrides", () => {
  it("prefers a stored preference over the system binary", () => {
    const choice = resolveSshBinary(input({ override: "/opt/openssh/bin/ssh" }));

    expect(choice).toEqual({ command: "/opt/openssh/bin/ssh", source: "override" });
  });

  it("takes the environment when nothing is stored", () => {
    const choice = resolveSshBinary(
      input({ env: { SystemRoot: "C:\\WINDOWS", MC_SSH_PATH: "C:\\tools\\ssh.exe" } }),
    );

    expect(choice).toEqual({ command: "C:\\tools\\ssh.exe", source: "override" });
  });

  it("lets a stored preference beat the environment", () => {
    const choice = resolveSshBinary(
      input({ override: "/first/ssh", env: { MC_SSH_PATH: "/second/ssh" } }),
    );

    expect(choice.command).toBe("/first/ssh");
  });

  it("honors an override that does not exist rather than silently substituting", () => {
    // Naming a missing binary should surface as "that binary is missing", not
    // as a different ssh quietly doing something else.
    const choice = resolveSshBinary(input({ override: "/nope/ssh", exists: () => false }));

    expect(choice).toEqual({ command: "/nope/ssh", source: "override" });
  });

  it("ignores blank overrides", () => {
    expect(resolveSshBinary(input({ override: "   " })).source).toBe("system");
    expect(resolveSshBinary(input({ env: { SystemRoot: "C:\\WINDOWS", MC_SSH_PATH: "  " } })).source).toBe(
      "system",
    );
  });
});

describe("describeSshBinary", () => {
  it("names the binary when there is a path to name", () => {
    expect(describeSshBinary({ command: WINDOWS_SSH, source: "system" })).toBe(WINDOWS_SSH);
  });

  it("says where a PATH lookup came from, since the path is the ambiguity", () => {
    expect(describeSshBinary({ command: "ssh", source: "path" })).toBe("ssh (from PATH)");
  });
});

describe("classifying a host that wanted a password", () => {
  it("names the real problem instead of blaming the user's key", () => {
    // The exact line an OpenSSH 9.x host produces when it offered a password
    // and BatchMode refused to be asked.
    const failure = classifySshFailure(
      "admin@192.168.7.67: Permission denied (publickey,password,keyboard-interactive).\n",
      255,
    );

    expect(failure.kind).toBe("auth");
    expect(failure.message).toMatch(/asked for a password/i);
    expect(failure.message).toMatch(/ssh-copy-id/);
    expect(failure.message).not.toMatch(/Check the key or agent/);
  });

  it("still blames the key when the key really was the only method", () => {
    const failure = classifySshFailure("git@host: Permission denied (publickey).\n", 255);

    expect(failure.message).toMatch(/Check the key or agent/);
    expect(failure.message).not.toMatch(/asked for a password/i);
  });

  it("treats keyboard-interactive alone as an unaskable prompt too", () => {
    const failure = classifySshFailure(
      "u@host: Permission denied (keyboard-interactive).\n",
      255,
    );

    expect(failure.message).toMatch(/asked for a password/i);
  });
});
