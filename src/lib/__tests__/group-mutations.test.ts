import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("~/lib/api", () => ({
  api: {
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "~/lib/api";
import { queryKeys } from "~/queries";
import type { Group } from "~/db/schema";
import {
  createGroup,
  deleteGroup,
  isOptimisticGroupId,
  recolorGroup,
  renameGroup,
} from "../group-mutations";

const createGroupRequest = vi.mocked(api.createGroup);
const updateGroupRequest = vi.mocked(api.updateGroup);
const deleteGroupRequest = vi.mocked(api.deleteGroup);
const toastError = vi.mocked(toast.error);

function group(id: string, name: string, color = "#ff5a1f"): Group {
  return { id, name, color, sortOrder: 0, createdAt: 0 };
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
  vi.clearAllMocks();
});

const read = () => queryClient.getQueryData<Group[]>(queryKeys.groups);

describe("createGroup", () => {
  it("shows the new group before the request resolves", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);
    let seenDuringRequest: Group[] | undefined;
    createGroupRequest.mockImplementation(async () => {
      seenDuringRequest = read();
      return { group: group("g-real", "Gamma") };
    });

    await createGroup(queryClient, "Gamma");

    expect(seenDuringRequest?.map((g) => g.name)).toEqual(["Alpha", "Gamma"]);
  });

  it("replaces the optimistic row with the server's row on success", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);
    createGroupRequest.mockResolvedValue({ group: group("g-real", "Gamma", "#34d399") });

    const created = await createGroup(queryClient, "Gamma");

    expect(created?.id).toBe("g-real");
    expect(read()).toEqual([group("g-alpha", "Alpha"), group("g-real", "Gamma", "#34d399")]);
  });

  it("sends the trimmed name", async () => {
    queryClient.setQueryData(queryKeys.groups, []);
    createGroupRequest.mockResolvedValue({ group: group("g-real", "Gamma") });

    await createGroup(queryClient, "  Gamma  ");

    expect(createGroupRequest).toHaveBeenCalledWith({ name: "Gamma" });
  });

  it("restores the previous list and reports the failure", async () => {
    const before = [group("g-alpha", "Alpha")];
    queryClient.setQueryData(queryKeys.groups, before);
    createGroupRequest.mockRejectedValue(new Error("server said no"));

    const created = await createGroup(queryClient, "Gamma");

    expect(created).toBeNull();
    expect(read()).toEqual(before);
    expect(toastError).toHaveBeenCalledWith("server said no");
  });

  it("leaves no optimistic row behind when the create fails from empty", async () => {
    queryClient.setQueryData(queryKeys.groups, []);
    createGroupRequest.mockRejectedValue(new Error("nope"));

    await createGroup(queryClient, "Gamma");

    expect(read()).toEqual([]);
  });

  it("rejects a blank name without calling the server", async () => {
    queryClient.setQueryData(queryKeys.groups, []);

    const created = await createGroup(queryClient, "   ");

    expect(created).toBeNull();
    expect(createGroupRequest).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it("rejects a duplicate name without calling the server", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);

    const created = await createGroup(queryClient, "Alpha");

    expect(created).toBeNull();
    expect(createGroupRequest).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Alpha"));
  });
});

describe("renameGroup", () => {
  it("shows the new name before the request resolves", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);
    let seenDuringRequest: Group[] | undefined;
    updateGroupRequest.mockImplementation(async () => {
      seenDuringRequest = read();
      return { group: group("g-alpha", "Gamma") };
    });

    await renameGroup(queryClient, "g-alpha", "Gamma");

    expect(seenDuringRequest?.[0]?.name).toBe("Gamma");
  });

  it("sends the trimmed name", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);
    updateGroupRequest.mockResolvedValue({ group: group("g-alpha", "Gamma") });

    await renameGroup(queryClient, "g-alpha", "  Gamma  ");

    expect(updateGroupRequest).toHaveBeenCalledWith("g-alpha", { name: "Gamma" });
  });

  it("restores the previous name and reports a failure", async () => {
    const before = [group("g-alpha", "Alpha")];
    queryClient.setQueryData(queryKeys.groups, before);
    updateGroupRequest.mockRejectedValue(new Error("server said no"));

    const renamed = await renameGroup(queryClient, "g-alpha", "Gamma");

    expect(renamed).toBeNull();
    expect(read()).toEqual(before);
    expect(toastError).toHaveBeenCalledWith("server said no");
  });

  it("refuses a blank name without calling the server", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);

    expect(await renameGroup(queryClient, "g-alpha", "   ")).toBeNull();
    expect(updateGroupRequest).not.toHaveBeenCalled();
    expect(read()?.[0]?.name).toBe("Alpha");
  });

  it("refuses a rename onto another group's name without calling the server", async () => {
    queryClient.setQueryData(queryKeys.groups, [
      group("g-alpha", "Alpha"),
      group("g-beta", "Beta"),
    ]);

    expect(await renameGroup(queryClient, "g-alpha", "Beta")).toBeNull();
    expect(updateGroupRequest).not.toHaveBeenCalled();
  });

  it("lets a group keep its own name", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);
    updateGroupRequest.mockResolvedValue({ group: group("g-alpha", "Alpha") });

    expect(await renameGroup(queryClient, "g-alpha", "Alpha")).not.toBeNull();
  });
});

describe("recolorGroup", () => {
  it("shows the new color before the request resolves", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha", "#ff5a1f")]);
    let seenDuringRequest: Group[] | undefined;
    updateGroupRequest.mockImplementation(async () => {
      seenDuringRequest = read();
      return { group: group("g-alpha", "Alpha", "#34d399") };
    });

    await recolorGroup(queryClient, "g-alpha", "#34d399");

    expect(seenDuringRequest?.[0]?.color).toBe("#34d399");
  });

  it("restores the previous color when the request fails", async () => {
    const before = [group("g-alpha", "Alpha", "#ff5a1f")];
    queryClient.setQueryData(queryKeys.groups, before);
    updateGroupRequest.mockRejectedValue(new Error("nope"));

    expect(await recolorGroup(queryClient, "g-alpha", "#34d399")).toBeNull();
    expect(read()).toEqual(before);
    expect(toastError).toHaveBeenCalled();
  });
});

describe("deleteGroup", () => {
  it("writes nothing optimistically, so a failed delete leaves the scope untouched", async () => {
    const before = [group("g-alpha", "Alpha"), group("g-beta", "Beta")];
    queryClient.setQueryData(queryKeys.groups, before);
    let seenDuringRequest: Group[] | undefined;
    deleteGroupRequest.mockImplementation(async () => {
      seenDuringRequest = read();
      throw new Error("nope");
    });

    expect(await deleteGroup(queryClient, "g-alpha")).toBe(false);
    expect(seenDuringRequest).toEqual(before);
    expect(read()).toEqual(before);
    expect(toastError).toHaveBeenCalled();
  });

  it("invalidates the projects cache as well as the groups cache", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);
    deleteGroupRequest.mockResolvedValue(undefined);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(await deleteGroup(queryClient, "g-alpha")).toBe(true);

    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.groups));
    expect(keys).toContain(JSON.stringify(queryKeys.projects));
  });

  it("does not invalidate when the delete failed", async () => {
    queryClient.setQueryData(queryKeys.groups, [group("g-alpha", "Alpha")]);
    deleteGroupRequest.mockRejectedValue(new Error("nope"));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await deleteGroup(queryClient, "g-alpha");

    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("isOptimisticGroupId", () => {
  it("recognizes the row a create writes before the server answers", async () => {
    queryClient.setQueryData(queryKeys.groups, []);
    let idDuringRequest: string | undefined;
    createGroupRequest.mockImplementation(async () => {
      idDuringRequest = read()?.[0]?.id;
      return { group: group("g-real", "Gamma") };
    });

    await createGroup(queryClient, "Gamma");

    expect(idDuringRequest).toBeDefined();
    expect(isOptimisticGroupId(idDuringRequest!)).toBe(true);
  });

  it("does not mistake a server id for an optimistic one", () => {
    expect(isOptimisticGroupId("g-real")).toBe(false);
  });

  it("stops recognizing the row once the server row replaces it", async () => {
    queryClient.setQueryData(queryKeys.groups, []);
    createGroupRequest.mockResolvedValue({ group: group("g-real", "Gamma") });

    await createGroup(queryClient, "Gamma");

    expect(read()?.every((g) => !isOptimisticGroupId(g.id))).toBe(true);
  });
});
