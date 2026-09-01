import { X509Certificate } from "node:crypto";
import { z } from "zod";
import {
  connectRemoteSandbox,
  registerSshHost,
  deleteSandbox,
  getSandboxState,
  revealSandboxApiKey,
  setSandboxesEnabled,
  updateSandbox,
} from "../services/sandboxes";
import {
  idParam,
  json,
  jsonError,
  noContent,
  notFound,
  parseJsonBody,
} from "./_helpers";
import { HTTP_BAD_REQUEST } from "~/shared/http-status";
import { MAX_TCP_PORT } from "~/shared/tcp-port";
import { isElectronLocalApiRequest } from "../request-runtime";

// Sandboxes are a local-desktop feature; hosted (web) requests get a disabled,
// empty state and cannot mutate.
const DISABLED_STATE = { sandboxes: [], enabled: false } as const;

const updateBody = z
  .object({
    name: z.string().min(1).max(60),
    color: z.string().max(32).nullable(),
    imageTag: z.string().nullable(),
    dockerfilePath: z.string().nullable(),
    gitAuthMode: z.enum(["none", "copy-host", "generate"]),
    buildArgs: z.record(z.string(), z.string()).nullable(),
    declaredPorts: z.array(z.number().int().min(1).max(MAX_TCP_PORT)).nullable(),
  })
  .partial();

const enabledBody = z.object({ enabled: z.boolean() });

const sshHostBody = z.object({
  // The alias is a name from the user's own SSH config, and it reaches an
  // `ssh` argument list, so it is shape-checked before anything else.
  alias: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(60),
  prefix: z.string().trim().min(1).max(4096),
  platform: z.enum(["linux", "darwin"]),
  apiKey: z.string().min(1).max(512),
  // The port the host's runtime actually listens on. Recorded per host rather
  // than read from this client's global setting, because a runtime adopted
  // from another Mission Control chose its own — and a tunnel forwarding to
  // the wrong port fails in a way that looks like the host is down.
  agentPort: z.number().int().min(1).max(65535).optional(),
  // Absolute POSIX path on the host. Bounded, and never interpolated into a
  // script — it is written into the unit as an Environment value.
  workspaceRoot: z.string().trim().min(1).max(4096).startsWith("/").optional(),
});

const connectBody = z.object({
  name: z.string().trim().min(1).max(60),
  agentUrl: z.string().min(1).max(2048),
  apiKey: z.string().min(1).max(512),
  agentCa: z.string().max(20_000).nullable().optional(),
});

function localOnly(request: Request): Response | null {
  return isElectronLocalApiRequest(request)
    ? null
    : jsonError(HTTP_BAD_REQUEST, "Sandboxes are only available in the desktop app.");
}

export async function list(request: Request): Promise<Response> {
  if (!isElectronLocalApiRequest(request)) return json(DISABLED_STATE);
  return json(getSandboxState());
}

/**
 * The pasted CA is pinned as the sole trust anchor for that sandbox's TLS
 * connection with hostname checks relaxed (electron/sandbox-agent-client.ts),
 * so only the shape that pinning is designed for is accepted: exactly one
 * self-signed certificate — the agent's own cert. Chains, intermediates, and
 * stray private keys are rejected rather than silently weakening verification.
 */
function agentCaError(pem: string): string | null {
  if (pem.includes("PRIVATE KEY")) {
    return "CA certificate must not contain a private key — paste only the certificate.";
  }
  if ((pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0) !== 1) {
    return "CA certificate must be a single PEM certificate (the agent's self-signed cert, not a chain).";
  }
  try {
    const cert = new X509Certificate(pem);
    if (!cert.verify(cert.publicKey)) {
      return "CA certificate must be the agent's self-signed certificate.";
    }
  } catch {
    return "CA certificate must be a valid PEM certificate.";
  }
  return null;
}

/**
 * Record an SSH host Mission Control has just provisioned. Unlike `connect`
 * there is no URL or certificate to validate: the transport is the user's own
 * SSH, and the runtime is reachable only through the forward.
 */
export async function registerSsh(request: Request): Promise<Response> {
  const blocked = localOnly(request);
  if (blocked) return blocked;
  const parsed = await parseJsonBody(request, sshHostBody);
  if (!parsed.ok) return parsed.response;
  return json({ sandbox: registerSshHost(parsed.data) });
}

/** Register an externally-provisioned remote sandbox (manual agent URL + key). */
export async function connect(request: Request): Promise<Response> {
  const blocked = localOnly(request);
  if (blocked) return blocked;
  const parsed = await parseJsonBody(request, connectBody);
  if (!parsed.ok) return parsed.response;
  const agentCa = parsed.data.agentCa?.trim();
  if (agentCa) {
    const caError = agentCaError(agentCa);
    if (caError) return jsonError(HTTP_BAD_REQUEST, caError);
  }
  const sandbox = connectRemoteSandbox(parsed.data);
  if (!sandbox) {
    return jsonError(
      HTTP_BAD_REQUEST,
      "Agent URL must be wss:// — plain ws:// is only allowed for localhost, and the URL cannot carry credentials or a query string.",
    );
  }
  return json({ sandbox });
}

export async function update(rawId: string, request: Request): Promise<Response> {
  const blocked = localOnly(request);
  if (blocked) return blocked;
  const id = idParam.safeParse(rawId);
  if (!id.success) return notFound();
  const parsed = await parseJsonBody(request, updateBody);
  if (!parsed.ok) return parsed.response;
  const sandbox = updateSandbox(id.data, parsed.data);
  return sandbox ? json({ sandbox }) : notFound();
}

export async function revealApiKey(rawId: string, request: Request): Promise<Response> {
  const blocked = localOnly(request);
  if (blocked) return blocked;
  const id = idParam.safeParse(rawId);
  if (!id.success) return notFound();
  const apiKey = revealSandboxApiKey(id.data);
  return apiKey ? json({ apiKey }) : notFound();
}

export async function remove(rawId: string, request: Request): Promise<Response> {
  const blocked = localOnly(request);
  if (blocked) return blocked;
  const id = idParam.safeParse(rawId);
  if (!id.success) return notFound();
  return deleteSandbox(id.data) ? noContent() : notFound();
}

export async function setEnabled(request: Request): Promise<Response> {
  const blocked = localOnly(request);
  if (blocked) return blocked;
  const parsed = await parseJsonBody(request, enabledBody);
  if (!parsed.ok) return parsed.response;
  setSandboxesEnabled(parsed.data.enabled);
  return json({ enabled: true });
}
