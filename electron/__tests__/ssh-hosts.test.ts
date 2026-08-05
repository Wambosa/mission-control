import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSshHostAliases } from "../ssh-hosts";

describe("readSshHostAliases", () => {
  let homeDir = "";

  afterEach(() => {
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
    homeDir = "";
  });

  function home(files: Record<string, string>): string {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ssh-hosts-"));
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(homeDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    return homeDir;
  }

  it("reads the aliases the user's SSH config defines", () => {
    const dir = home({ ".ssh/config": "Host workshop\n  HostName 10.0.0.4\n\nHost attic\n" });
    expect(readSshHostAliases(dir)).toEqual(["workshop", "attic"]);
  });

  it("returns an empty list when there is no SSH config", () => {
    expect(readSshHostAliases(home({}))).toEqual([]);
  });

  it("returns an empty list when the config cannot be read", () => {
    const dir = home({ ".ssh/config/not-a-file": "Host workshop\n" });
    expect(readSshHostAliases(dir)).toEqual([]);
  });

  it("resolves a relative Include against the .ssh directory", () => {
    const dir = home({
      ".ssh/config": "Include work.conf\n\nHost attic\n",
      ".ssh/work.conf": "Host office\n",
    });
    expect(readSshHostAliases(dir)).toEqual(["office", "attic"]);
  });

  it("expands a globbed Include in sorted order and skips directories", () => {
    const dir = home({
      ".ssh/config": "Include conf.d/*.conf\n",
      ".ssh/conf.d/20-second.conf": "Host second\n",
      ".ssh/conf.d/10-first.conf": "Host first\n",
      ".ssh/conf.d/notes.txt": "Host ignored\n",
      ".ssh/conf.d/nested.conf/inner": "Host nested\n",
    });
    expect(readSshHostAliases(dir)).toEqual(["first", "second"]);
  });

  it("honors absolute and home-relative Include paths", () => {
    const dir = home({
      ".ssh/hosts-a": "Host from-home\n",
      ".ssh/hosts-b": "Host from-absolute\n",
    });
    fs.writeFileSync(
      path.join(dir, ".ssh/config"),
      `Include ~/.ssh/hosts-a\nInclude ${path.join(dir, ".ssh/hosts-b")}\n`,
    );
    expect(readSshHostAliases(dir)).toEqual(["from-home", "from-absolute"]);
  });

  it("ignores an Include naming a file that does not exist", () => {
    const dir = home({ ".ssh/config": "Include missing.conf\nHost workshop\n" });
    expect(readSshHostAliases(dir)).toEqual(["workshop"]);
  });
});
