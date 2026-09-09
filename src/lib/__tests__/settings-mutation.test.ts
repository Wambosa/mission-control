import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("~/lib/api", () => ({
  api: { updateSettings: vi.fn() },
}));

import { QueryClient } from "@tanstack/react-query";
import { api, type AppSettings } from "~/lib/api";
import { queryKeys } from "~/queries";
import { writeSettings } from "../settings-mutation";

const updateSettings = vi.mocked(api.updateSettings);

/** Only the fields these tests read; the writer never inspects the rest. */
function cached(overrides: Partial<AppSettings> = {}) {
  return {
    accentColor: "terracotta",
    themeStyle: "painted",
    minimalTheme: false,
    spellcheckEnabled: true,
    ...overrides,
  } as unknown as AppSettings;
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
  vi.clearAllMocks();
});

const read = () => queryClient.getQueryData<AppSettings>(queryKeys.settings);

describe("writeSettings", () => {
  it("writes the patch optimistically before the request resolves", async () => {
    queryClient.setQueryData(queryKeys.settings, cached());
    let seenDuringRequest: AppSettings | undefined;
    updateSettings.mockImplementation(async () => {
      seenDuringRequest = read();
      return cached({ accentColor: "teal" });
    });

    await writeSettings(queryClient, { accentColor: "teal" });

    expect(seenDuringRequest?.accentColor).toBe("teal");
    expect(read()?.accentColor).toBe("teal");
  });

  it("merges the server response over the optimistic value", async () => {
    queryClient.setQueryData(queryKeys.settings, cached());
    // The server pins some fields regardless of what was asked for.
    updateSettings.mockResolvedValue(cached({ themeStyle: "flat", minimalTheme: true }));

    await writeSettings(queryClient, { themeStyle: "flat" });

    expect(read()?.minimalTheme).toBe(true);
  });

  it("applies derived fields optimistically without sending them", async () => {
    queryClient.setQueryData(queryKeys.settings, cached());
    let seenDuringRequest: AppSettings | undefined;
    updateSettings.mockImplementation(async () => {
      seenDuringRequest = read();
      return cached({ themeStyle: "flat", minimalTheme: true });
    });

    await writeSettings(
      queryClient,
      { themeStyle: "flat" },
      { derived: { minimalTheme: true } },
    );

    expect(seenDuringRequest?.minimalTheme).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith({ themeStyle: "flat" });
  });

  it("restores the snapshot and rethrows when the request fails", async () => {
    queryClient.setQueryData(queryKeys.settings, cached());
    updateSettings.mockRejectedValue(new Error("offline"));

    await expect(
      writeSettings(queryClient, { accentColor: "teal" }),
    ).rejects.toThrow("offline");
    expect(read()?.accentColor).toBe("terracotta");
  });

  it("hands the restored settings to rollback so side effects rewind", async () => {
    queryClient.setQueryData(queryKeys.settings, cached({ accentColor: "terracotta" }));
    updateSettings.mockRejectedValue(new Error("offline"));
    const rollback = vi.fn();

    await expect(
      writeSettings(queryClient, { accentColor: "teal" }, { rollback }),
    ).rejects.toThrow();
    expect(rollback).toHaveBeenCalledWith(
      expect.objectContaining({ accentColor: "terracotta" }),
    );
  });

  it("skips the optimistic write when nothing is cached, seeding from the response", async () => {
    let seenDuringRequest: AppSettings | undefined;
    updateSettings.mockImplementation(async () => {
      seenDuringRequest = read();
      return cached({ spellcheckEnabled: false });
    });

    await writeSettings(queryClient, { spellcheckEnabled: false });

    // A partial AppSettings must never reach the cache.
    expect(seenDuringRequest).toBeUndefined();
    expect(read()?.spellcheckEnabled).toBe(false);
  });

  it("does not call rollback when there was no snapshot to restore", async () => {
    updateSettings.mockRejectedValue(new Error("offline"));
    const rollback = vi.fn();

    await expect(
      writeSettings(queryClient, { spellcheckEnabled: false }, { rollback }),
    ).rejects.toThrow();
    expect(rollback).not.toHaveBeenCalled();
    expect(read()).toBeUndefined();
  });
});
