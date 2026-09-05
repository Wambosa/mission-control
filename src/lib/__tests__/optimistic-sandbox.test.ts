import { describe, expect, it } from "vitest";
import {
  buildOptimisticRemoteVmSandbox,
  buildOptimisticRemoteVmSandboxFromDeployJob,
  markSandboxStoppedInCache,
  markSandboxStoppingInCache,
  mergeServerSandboxesPreservingPending,
  removeSandboxFromCache,
  restoreSandboxesCache,
  updateSandboxRemoteStatusInCache,
  upsertSandboxInCache,
  type SandboxesQueryData,
} from "../optimistic-sandbox";
import { queryKeys } from "~/queries";
import type { RemoteVmDeployJobSnapshot } from "~/shared/electron-contract";
import type { SandboxPublicView } from "~/shared/sandbox";

function createQueryClientStub() {
  const cache = new Map<string, unknown>();
  return {
    setQueryData: <T,>(key: readonly unknown[], updater: T | ((current: T | undefined) => T)) => {
      const current = cache.get(JSON.stringify(key)) as T | undefined;
      const next = typeof updater === "function" ? (updater as (c: T | undefined) => T)(current) : updater;
      cache.set(JSON.stringify(key), next);
      return next;
    },
    getQueryData: <T,>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined,
  };
}

describe("optimistic-sandbox", () => {
  it("builds a remote VM placeholder before deploy persistence finishes", () => {
    const sandbox = buildOptimisticRemoteVmSandbox({
      id: "sb-pending",
      name: "AWS Dev",
      createdAt: 123,
    });

    expect(sandbox).toMatchObject({
      id: "sb-pending",
      name: "AWS Dev",
      kind: "remote-vm",
      remoteAgentUrl: null,
      hasApiKey: false,
      createdAt: 123,
    });
  });

  it("marks managed cloud deploys as provisioning with a provider label", () => {
    const sandbox = buildOptimisticRemoteVmSandbox({
      id: "sb-aws",
      name: "AWS Dev",
      remoteProvider: "aws",
      hasApiKey: true,
    });

    expect(sandbox).toMatchObject({
      remoteProvider: "aws",
      remoteProviderName: "AWS EC2",
      remoteStatus: "provisioning",
      hasApiKey: true,
    });
  });

  it("builds deploy-job placeholders with the owning project id", () => {
    const job = {
      id: "job-1",
      input: {
        provider: "aws",
        sandboxId: "sb-project",
        name: "Project Dev",
        region: "us-east-1",
        projectId: "p-project",
      },
      status: "running",
      createdAt: 123,
      startedAt: 124,
      updatedAt: 125,
      finishedAt: null,
      nextSeq: 1,
    } satisfies RemoteVmDeployJobSnapshot;

    const sandbox = buildOptimisticRemoteVmSandboxFromDeployJob(job);

    expect(sandbox).toMatchObject({
      id: "sb-project",
      name: "Project Dev",
      remoteProvider: "aws",
      remoteStatus: "provisioning",
      projectId: "p-project",
    });
  });

  it("preserves an existing owning project id when replaying a deploy job without one", () => {
    const existing = buildOptimisticRemoteVmSandbox({
      id: "sb-existing",
      name: "Existing",
      projectId: "p-project",
    });
    const job = {
      id: "job-1",
      input: {
        provider: "aws",
        sandboxId: "sb-existing",
        name: "Existing",
        region: "us-east-1",
      },
      status: "queued",
      createdAt: 123,
      startedAt: null,
      updatedAt: 123,
      finishedAt: null,
      nextSeq: 1,
    } satisfies RemoteVmDeployJobSnapshot;

    const sandbox = buildOptimisticRemoteVmSandboxFromDeployJob(job, existing);

    expect(sandbox?.projectId).toBe("p-project");
  });

  it("adds an optimistic sandbox to the shared query cache", () => {
    const qc = createQueryClientStub();
    const sandbox = buildOptimisticRemoteVmSandbox({ id: "sb-pending", name: "AWS Dev" });

    upsertSandboxInCache(qc as never, sandbox);

    const state = qc.getQueryData<{
      sandboxes: SandboxPublicView[];
      enabled: boolean;
    }>(queryKeys.sandboxes)!;
    expect(state.enabled).toBe(true);
    expect(state.sandboxes.map((item) => item.id)).toEqual(["sb-pending"]);
  });

  it("merges managed provider onto an existing row without dropping a saved agent URL", () => {
    const qc = createQueryClientStub();
    const persisted = {
      ...buildOptimisticRemoteVmSandbox({ id: "sb-real", name: "Persisted" }),
      remoteAgentUrl: "wss://agent.example.com/",
      hasApiKey: true,
    } satisfies SandboxPublicView;
    qc.setQueryData(queryKeys.sandboxes, { sandboxes: [persisted], enabled: true });

    upsertSandboxInCache(
      qc as never,
      buildOptimisticRemoteVmSandbox({
        id: "sb-real",
        name: "Pending",
        remoteProvider: "aws",
        hasApiKey: true,
      }),
    );

    const state = qc.getQueryData<{ sandboxes: SandboxPublicView[] }>(queryKeys.sandboxes)!;
    expect(state.sandboxes[0]).toMatchObject({
      remoteProvider: "aws",
      remoteAgentUrl: "wss://agent.example.com/",
      hasApiKey: true,
    });
  });

  it("preserves a persisted sandbox when the optimistic row is replayed", () => {
    const qc = createQueryClientStub();
    const persisted = {
      ...buildOptimisticRemoteVmSandbox({ id: "sb-real", name: "Persisted" }),
      remoteAgentUrl: "wss://agent.example.com/",
      hasApiKey: true,
    } satisfies SandboxPublicView;
    qc.setQueryData(queryKeys.sandboxes, { sandboxes: [persisted], enabled: true });

    upsertSandboxInCache(
      qc as never,
      buildOptimisticRemoteVmSandbox({ id: "sb-real", name: "Pending" }),
    );

    const state = qc.getQueryData<{
      sandboxes: SandboxPublicView[];
      enabled: boolean;
    }>(queryKeys.sandboxes)!;
    expect(state.sandboxes[0]).toMatchObject({
      remoteAgentUrl: "wss://agent.example.com/",
      hasApiKey: true,
    });
  });

  it("marks a sandbox as stopping", () => {
    const qc = createQueryClientStub();
    qc.setQueryData(queryKeys.sandboxes, {
      sandboxes: [
        buildOptimisticRemoteVmSandbox({
          id: "sb-stopping",
          name: "Stopping",
          remoteProvider: "aws",
          remoteStatus: "ready",
        }),
      ],
      enabled: true,
    });

    markSandboxStoppingInCache(qc as never, "sb-stopping");

    const state = qc.getQueryData<SandboxesQueryData>(queryKeys.sandboxes)!;
    expect(state.sandboxes[0]).toMatchObject({
      remoteStatus: "pausing",
      remoteStatusMessage: null,
    });
  });

  it("updates a stopped sandbox status", () => {
    const qc = createQueryClientStub();
    qc.setQueryData(queryKeys.sandboxes, {
      sandboxes: [
        buildOptimisticRemoteVmSandbox({
          id: "sb-stopped",
          name: "Stopped",
          remoteProvider: "aws",
          remoteStatus: "pausing",
        }),
      ],
      enabled: true,
    });

    markSandboxStoppedInCache(qc as never, "sb-stopped");

    const state = qc.getQueryData<SandboxesQueryData>(queryKeys.sandboxes)!;
    expect(state.sandboxes[0]).toMatchObject({
      remoteStatus: "paused",
      remotePublicAddress: null,
    });
  });

  it("ignores remote status updates for missing sandbox rows", () => {
    const qc = createQueryClientStub();
    const previous: SandboxesQueryData = { sandboxes: [], enabled: true };
    qc.setQueryData(queryKeys.sandboxes, previous);

    updateSandboxRemoteStatusInCache(qc as never, "sb-missing", { remoteStatus: "pausing" });

    expect(qc.getQueryData(queryKeys.sandboxes)).toEqual(previous);
  });

  describe("mergeServerSandboxesPreservingPending", () => {
    const serverState = (sandboxes: SandboxPublicView[]): SandboxesQueryData => ({
      sandboxes,
      enabled: true,
    });

    it("keeps a pending deploy the server hasn't persisted yet", () => {
      const pending = buildOptimisticRemoteVmSandbox({
        id: "sb-pending",
        name: "AWS Dev",
        remoteProvider: "aws",
      });

      const merged = mergeServerSandboxesPreservingPending(serverState([]), [pending]);

      expect(merged.sandboxes.map((s) => s.id)).toEqual(["sb-pending"]);
      expect(merged.enabled).toBe(true);
    });

    it("lets the server row win once persisted while a deploy is still in flight", () => {
      const persisted: SandboxPublicView = {
        ...buildOptimisticRemoteVmSandbox({ id: "sb-pending", name: "AWS Dev", remoteProvider: "aws" }),
        remoteAgentUrl: "wss://1.2.3.4:8443/",
        remoteStatus: "provisioning",
      };
      const pending = buildOptimisticRemoteVmSandbox({
        id: "sb-pending",
        name: "AWS Dev",
        remoteProvider: "aws",
      });

      const merged = mergeServerSandboxesPreservingPending(serverState([persisted]), [pending]);

      expect(merged.sandboxes).toHaveLength(1);
      expect(merged.sandboxes[0].remoteAgentUrl).toBe("wss://1.2.3.4:8443/");
    });

    it("defers entirely to the server when nothing is pending", () => {
      const existing = buildOptimisticRemoteVmSandbox({ id: "sb-real", name: "Real" });
      const merged = mergeServerSandboxesPreservingPending(serverState([existing]), []);

      expect(merged.sandboxes.map((s) => s.id)).toEqual(["sb-real"]);
    });
  });

  it("removes a sandbox from the cache", () => {
    const qc = createQueryClientStub();
    qc.setQueryData(queryKeys.sandboxes, {
      sandboxes: [
        buildOptimisticRemoteVmSandbox({ id: "sb-delete", name: "Delete Me" }),
        buildOptimisticRemoteVmSandbox({ id: "sb-keep", name: "Keep Me" }),
      ],
      enabled: true,
    });

    removeSandboxFromCache(qc as never, "sb-delete");

    const state = qc.getQueryData<SandboxesQueryData>(queryKeys.sandboxes)!;
    expect(state.sandboxes.map((sandbox) => sandbox.id)).toEqual(["sb-keep"]);
  });

  it("restores the previous sandbox cache after a failed optimistic write", () => {
    const qc = createQueryClientStub();
    const previous = { sandboxes: [], enabled: true };
    qc.setQueryData(queryKeys.sandboxes, previous);

    upsertSandboxInCache(
      qc as never,
      buildOptimisticRemoteVmSandbox({ id: "sb-pending", name: "Pending" }),
    );
    restoreSandboxesCache(qc as never, previous);

    expect(qc.getQueryData(queryKeys.sandboxes)).toEqual(previous);
  });
});
