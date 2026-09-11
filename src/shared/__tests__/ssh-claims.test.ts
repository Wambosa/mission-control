import { describe, expect, it } from "vitest";
import {
  describeRetainedHost,
  isValidSshClientId,
  otherSshClaims,
  parseSshClaimList,
  parseSshRemainingClaims,
  renderSshClaim,
  parseSshClaim,
  sshClaimPath,
  sshClaimScript,
  sshClaimsDir,
  sshListClaimsScript,
  sshUnclaimScript,
  type SshClaim,
} from "../ssh-claims";

const CLIENT = "a3f1c8d20b4e5f67";
const OTHER = "9b2e04ff1c3d5a78";

function claim(overrides: Partial<SshClaim> = {}): SshClaim {
  return {
    clientId: CLIENT,
    clientVersion: "0.49.0",
    agentVersion: "1.2.3",
    claimedAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

describe("client ids", () => {
  it("accepts generated hex ids", () => {
    expect(isValidSshClientId(CLIENT)).toBe(true);
  });

  it("rejects anything that could mean something to a shell or a path", () => {
    for (const bad of [
      "",
      "short",
      "../../etc/passwd",
      "id with space",
      "id;rm -rf /",
      "id$(whoami)",
      "'quoted'",
      "UPPERCASE1234567",
      "-leading-dash-1234",
    ]) {
      expect(isValidSshClientId(bad), bad).toBe(false);
    }
  });

  it("refuses to build a path from an invalid id", () => {
    expect(() => sshClaimPath("/home/sam/.chaos-wrangler", "../escape")).toThrow();
  });
});

describe("claim paths", () => {
  it("puts claims under the prefix the host already owns", () => {
    expect(sshClaimsDir("/home/sam/.chaos-wrangler")).toBe(
      "/home/sam/.chaos-wrangler/service/clients",
    );
    expect(sshClaimPath("/home/sam/.chaos-wrangler/", CLIENT)).toBe(
      `/home/sam/.chaos-wrangler/service/clients/${CLIENT}.json`,
    );
  });
});

describe("claim round trip", () => {
  it("parses what it renders", () => {
    expect(parseSshClaim(renderSshClaim(claim()))).toEqual(claim());
  });

  it("treats unreadable or foreign JSON as no claim", () => {
    expect(parseSshClaim("not json")).toBeNull();
    expect(parseSshClaim("[]")).toBeNull();
    expect(parseSshClaim('{"clientId":"../escape"}')).toBeNull();
  });
});

describe("claiming", () => {
  it("writes whole then moves, so a reader never sees half a claim", () => {
    const script = sshClaimScript("/home/sam/.chaos-wrangler", claim());
    const file = `/home/sam/.chaos-wrangler/service/clients/${CLIENT}.json`;
    expect(script).toContain(`mkdir -p '/home/sam/.chaos-wrangler/service/clients'`);
    expect(script).toContain(`cat > '${file}'.tmp`);
    expect(script).toContain(`mv '${file}'.tmp '${file}'`);
    expect(script.indexOf("cat >")).toBeLessThan(script.indexOf("mv "));
  });

  it("carries the versions a human would need to read a stale claim", () => {
    const script = sshClaimScript("/home/sam/.chaos-wrangler", claim());
    expect(script).toContain(`"clientVersion": "0.49.0"`);
    expect(script).toContain(`"agentVersion": "1.2.3"`);
  });
});

describe("unclaiming", () => {
  it("deletes this client's file before counting what is left", () => {
    const script = sshUnclaimScript("/home/sam/.chaos-wrangler", CLIENT);
    expect(script.indexOf("rm -f")).toBeLessThan(script.indexOf("remaining="));
  });

  it("reports zero for a prefix that was never claimed", () => {
    expect(sshUnclaimScript("/home/sam/.chaos-wrangler", CLIENT)).toContain("remaining=0");
  });

  it("reads the count back", () => {
    expect(parseSshRemainingClaims("remaining=0\n")).toBe(0);
    expect(parseSshRemainingClaims("noise\nremaining=2\n")).toBe(2);
  });

  it("returns null rather than guessing when the host said nothing useful", () => {
    expect(parseSshRemainingClaims("")).toBeNull();
    expect(parseSshRemainingClaims("remaining=lots")).toBeNull();
  });
});

describe("listing claims", () => {
  it("survives a prefix with no claims directory", () => {
    expect(sshListClaimsScript("/home/sam/.chaos-wrangler")).toContain("if [ -d");
  });

  it("parses one claim per line and skips what it cannot read", () => {
    const stdout = [
      JSON.stringify(claim()),
      "half a line {",
      JSON.stringify(claim({ clientId: OTHER })),
      "",
    ].join("\n");
    expect(parseSshClaimList(stdout).map((c) => c.clientId)).toEqual([CLIENT, OTHER]);
  });
});

describe("deciding whether a host may be torn down", () => {
  it("ignores this client's own claim", () => {
    const claims = [claim(), claim({ clientId: OTHER })];
    expect(otherSshClaims(claims, CLIENT).map((c) => c.clientId)).toEqual([OTHER]);
  });

  it("says nothing when this client was the last one out", () => {
    expect(describeRetainedHost(0)).toBeNull();
  });

  it("explains what it left behind, and why", () => {
    expect(describeRetainedHost(1)).toContain("another Chaos Wrangler");
    expect(describeRetainedHost(2)).toContain("2 other Chaos Wranglers");
  });

  it("treats an unanswerable host as still claimed rather than as empty", () => {
    // Refusing to delete something that might be in use is recoverable;
    // deleting it is not.
    expect(describeRetainedHost(null)).toContain("could not tell");
  });
});
