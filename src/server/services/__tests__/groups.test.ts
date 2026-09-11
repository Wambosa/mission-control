import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Redirect the data directory BEFORE anything pulls in the database client:
// `resolveUserDataDir()` otherwise falls back to the real application data
// directory and these tests would write to the developer's own database.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-groups-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { createGroup, deleteGroup, listGroups, updateGroup } = await import("../groups");
const { getDb } = await import("~/db/client");
const { groups, projects } = await import("~/db/schema");
const { ValidationError } = await import("../../errors");

function addProject(id: string, groupId: string | null) {
  getDb()
    .insert(projects)
    .values({
      id,
      name: id,
      path: `/tmp/${id}`,
      icon: "folder",
      iconColor: "#ff5a1f",
      groupId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

function storedName(id: string): string | undefined {
  return listGroups().find((g) => g.id === id)?.name;
}

beforeEach(() => {
  getDb().delete(projects).run();
  getDb().delete(groups).run();
});

describe("createGroup", () => {
  it("refuses a blank name as a caller-facing validation error", () => {
    expect(() => createGroup({ name: "" })).toThrow(ValidationError);
  });

  it("refuses a whitespace-only name", () => {
    expect(() => createGroup({ name: "   " })).toThrow(ValidationError);
  });

  it("refuses a name another group already has exactly", () => {
    createGroup({ name: "Alpha" });

    expect(() => createGroup({ name: "Alpha" })).toThrow(ValidationError);
  });

  it("stores a name with surrounding whitespace trimmed", () => {
    const created = createGroup({ name: "  Alpha  " });

    expect(created.name).toBe("Alpha");
  });

  it("assigns a color when none is supplied", () => {
    expect(createGroup({ name: "Alpha" }).color).toBeTruthy();
  });
});

describe("updateGroup", () => {
  it("refuses a whitespace-only rename and leaves the stored name unchanged", () => {
    const created = createGroup({ name: "Alpha" });

    expect(() => updateGroup(created.id, { name: "   " })).toThrow(ValidationError);
    expect(storedName(created.id)).toBe("Alpha");
  });

  it("refuses a rename onto another group's exact name", () => {
    const alpha = createGroup({ name: "Alpha" });
    createGroup({ name: "Beta" });

    expect(() => updateGroup(alpha.id, { name: "Beta" })).toThrow(ValidationError);
    expect(storedName(alpha.id)).toBe("Alpha");
  });

  it("lets a group keep its own name", () => {
    const alpha = createGroup({ name: "Alpha" });

    expect(updateGroup(alpha.id, { name: "Alpha" })?.name).toBe("Alpha");
  });

  it("stores a renamed value trimmed", () => {
    const alpha = createGroup({ name: "Alpha" });

    expect(updateGroup(alpha.id, { name: "  Gamma  " })?.name).toBe("Gamma");
    expect(storedName(alpha.id)).toBe("Gamma");
  });

  it("carries a reason the operator can read", () => {
    const alpha = createGroup({ name: "Alpha" });
    createGroup({ name: "Beta" });

    expect(() => updateGroup(alpha.id, { name: "Beta" })).toThrow(/Beta/);
  });

  it("still reports a missing group as null rather than throwing", () => {
    expect(updateGroup("g-nope", { name: "Alpha" })).toBeNull();
  });

  it("leaves a color-only patch alone", () => {
    const alpha = createGroup({ name: "Alpha" });

    expect(updateGroup(alpha.id, { color: "#34d399" })?.color).toBe("#34d399");
    expect(storedName(alpha.id)).toBe("Alpha");
  });
});

describe("deleteGroup", () => {
  it("keeps the group's projects and leaves them ungrouped", () => {
    const alpha = createGroup({ name: "Alpha" });
    addProject("p-one", alpha.id);
    addProject("p-two", alpha.id);

    expect(deleteGroup(alpha.id)).toBe(true);

    const rows = getDb().select().from(projects).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.groupId === null)).toBe(true);
  });

  it("leaves other groups' projects attached", () => {
    const alpha = createGroup({ name: "Alpha" });
    const beta = createGroup({ name: "Beta" });
    addProject("p-one", alpha.id);
    addProject("p-two", beta.id);

    deleteGroup(alpha.id);

    const rows = getDb().select().from(projects).all();
    expect(rows.find((r) => r.id === "p-two")?.groupId).toBe(beta.id);
  });

  it("frees the deleted group's name for reuse", () => {
    const alpha = createGroup({ name: "Alpha" });
    deleteGroup(alpha.id);

    expect(() => createGroup({ name: "Alpha" })).not.toThrow();
  });
});
