import { describe, expect, it } from "vitest";
import { parseSshHostAliases } from "../ssh-config";

describe("parseSshHostAliases", () => {
  it("yields each host block's alias in file order", () => {
    expect(
      parseSshHostAliases(
        [
          "Host workshop",
          "  HostName 10.0.0.4",
          "  User sam",
          "",
          "Host attic",
          "  HostName attic.local",
          "",
          "Host basement",
          "  HostName basement.local",
        ].join("\n"),
      ),
    ).toEqual(["workshop", "attic", "basement"]);
  });

  it("yields every alias a single Host line declares", () => {
    expect(parseSshHostAliases("Host workshop attic basement\n  User sam\n")).toEqual([
      "workshop",
      "attic",
      "basement",
    ]);
  });

  it("excludes wildcard patterns, which are defaults rather than machines", () => {
    expect(
      parseSshHostAliases(
        [
          "Host *",
          "  AddKeysToAgent yes",
          "",
          "Host *.internal",
          "  User sam",
          "",
          "Host build-?",
          "  User sam",
          "",
          "Host workshop !workshop.old",
          "  HostName 10.0.0.4",
        ].join("\n"),
      ),
    ).toEqual(["workshop"]);
  });

  it("pulls aliases from an included file at the point of inclusion", () => {
    const included: Record<string, string> = {
      "work/*": "Host office\n  HostName office.example.com\n",
    };
    expect(
      parseSshHostAliases(
        ["Host workshop", "  HostName 10.0.0.4", "", "Include work/*", "", "Host attic"].join("\n"),
        (pattern) => (included[pattern] ? [included[pattern]] : []),
      ),
    ).toEqual(["workshop", "office", "attic"]);
  });

  it("follows nested includes and stops rather than looping on a cycle", () => {
    const cyclic = "Host inner\nInclude loop\n";
    expect(parseSshHostAliases("Include loop\n", () => [cyclic])).toEqual(["inner"]);
  });

  it("ignores Include directives when no resolver is supplied", () => {
    expect(parseSshHostAliases("Include work/*\nHost workshop\n")).toEqual(["workshop"]);
  });

  it("returns an empty list for an empty or comment-only config", () => {
    expect(parseSshHostAliases("")).toEqual([]);
    expect(parseSshHostAliases("# nothing to see here\n\n   \n")).toEqual([]);
  });

  it("parses comments, indentation, equals separators, and quotes like canonical formatting", () => {
    const canonical = ["Host workshop", "  HostName 10.0.0.4", "", "Host attic"].join("\n");
    const messy = [
      "# my hosts",
      "\thost=workshop",
      "    HostName = 10.0.0.4",
      "   # a stray comment",
      "",
      'HOST  "attic"',
    ].join("\n");
    expect(parseSshHostAliases(messy)).toEqual(parseSshHostAliases(canonical));
  });

  it("lists an alias once even when several blocks name it", () => {
    expect(
      parseSshHostAliases("Host workshop\n  User sam\n\nHost workshop\n  Port 2222\n"),
    ).toEqual(["workshop"]);
  });
});
