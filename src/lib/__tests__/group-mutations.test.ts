import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("~/lib/api", () => ({
  api: { createGroup: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "~/lib/api";
import { queryKeys } from "~/queries";
import type { Group } from "~/db/schema";
import { createGroup } from "../group-mutations";

const createGroupRequest = vi.mocked(api.createGroup);
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
