import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Redirect the data directory BEFORE the database client loads, or these
// tests would write to the developer's own application data.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-groups-controller-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const groupsController = await import("../groups.controller");
const { createGroup } = await import("../../services/groups");
const { getDb } = await import("~/db/client");
const { groups } = await import("~/db/schema");

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

function patch(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/groups/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: string };
  return body.error ?? "";
}

beforeEach(() => {
  getDb().delete(groups).run();
});

describe("groups controller — update", () => {
  it("renames a group and returns it", async () => {
    const alpha = createGroup({ name: "Alpha" });

    const response = await groupsController.update(alpha.id, patch(alpha.id, { name: "Gamma" }));

    expect(response.status).toBe(HTTP_OK);
    const body = (await response.json()) as { group: { name: string } };
    expect(body.group.name).toBe("Gamma");
  });

  it("answers a duplicate name with 400 and the reason, not a 500", async () => {
    const alpha = createGroup({ name: "Alpha" });
    createGroup({ name: "Beta" });

    const response = await groupsController.update(alpha.id, patch(alpha.id, { name: "Beta" }));

    expect(response.status).toBe(HTTP_BAD_REQUEST);
    expect(await errorOf(response)).toContain("Beta");
  });

  it("answers a whitespace-only name with 400 and the reason", async () => {
    const alpha = createGroup({ name: "Alpha" });

    const response = await groupsController.update(alpha.id, patch(alpha.id, { name: "   " }));

    expect(response.status).toBe(HTTP_BAD_REQUEST);
    expect(await errorOf(response)).toBeTruthy();
  });
});

describe("groups controller — create", () => {
  it("answers a duplicate name with 400 and the reason", async () => {
    createGroup({ name: "Alpha" });

    const response = await groupsController.create(
      new Request("http://localhost/api/groups", {
        method: "POST",
        body: JSON.stringify({ name: "Alpha" }),
      }),
    );

    expect(response.status).toBe(HTTP_BAD_REQUEST);
    expect(await errorOf(response)).toContain("Alpha");
  });
});
