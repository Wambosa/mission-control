# Mission Control — agent orientation

Electron desktop app for running AI coding agents across projects: git worktrees,
embedded terminals, agent sessions, and remote SSH/sandbox hosts.

Read this before grepping. It exists so you don't have to rediscover the layer
map on every session.

## Running it

```
pnpm dev          # Electron + vite dev server (scripts/dev-local.mjs)
pnpm dev:server   # vite only, no Electron — browser at :5173
pnpm typecheck    # tsc for both tsconfigs; run this before claiming done
pnpm test         # vitest run (2376 tests)
pnpm lint         # eslint
pnpm knip:gate    # dead files/deps/binaries — CI blocks on this
pnpm knip         # full report, including unused exports (246 known, not gated)
```

Node 24 is enforced by `scripts/require-node-24.mjs` on every script. The package
manager is pinned; `pnpm` may only be on PATH via corepack, in which case
`corepack pnpm@11.1.2 <cmd>` works but scripts that shell out to a bare `pnpm`
will fail — put a shim on PATH if you hit that.

The suite is green on every platform. It did not used to be: two tests in
`electron/__tests__/ssh-binary.test.ts` failed off Windows because the resolver
built its Windows path with `path.join`, which is the POSIX one everywhere
else. It uses `path.win32` now, so a red suite is a real regression — there is
no expected-failure baseline to wave away.

## The four layers

| Path | Runs in | Owns |
|---|---|---|
| `electron/` | Electron main process | Windows, PTYs, filesystem, SSH, sandboxes, IPC handlers |
| `src/server/` | Node (in-process HTTP API) | REST controllers, services, SQLite repositories |
| `src/` (rest) | Renderer | React UI, TanStack Router + Query |
| `src/shared/` | Both | Types and pure functions with no runtime deps |

`src/shared/` is the only directory both sides may import. If a type is needed on
both sides of the Electron boundary it belongs there — not in `src/lib/`.

### The server layer, in order

```
src/server/api-router.ts          route table → controller
src/server/controllers/*.controller.ts   HTTP shape, validation, status codes
src/server/services/*.ts          business logic
src/server/repositories/*.repo.ts SQL against better-sqlite3
src/db/schema.ts                  drizzle table definitions
```

Controllers never touch SQL directly; repositories never encode HTTP concepts.
`src/server/vite-api-plugin.ts` mounts this router into the vite dev server — it
looks unused to a naive grep because its only importer is `vite.config.ts`.

### The Electron boundary

Three files move in lockstep. Change one and you almost certainly change all three:

- `electron/ipc-channels.ts` — channel name constants
- `src/shared/electron-contract.ts` — the typed contract (627 lines)
- `electron/preload.ts` — the bridge exposed as `window.electronAPI` (610 lines)

Renderer code reaches Electron through `src/lib/electron.ts`, never
`window.electronAPI` directly.

## Adding a setting — read this before you start

This is the most expensive change shape in the repo. A single new setting is
threaded through, in order:

1. `src/lib/api.ts` — the `AppSettings` type (a ~56-field object)
2. `src/db/schema.ts` — the `app_settings` table
3. `src/server/repositories/app-settings.repo.ts`
4. `src/server/services/settings.ts`
5. `src/server/controllers/settings.controller.ts` (763 lines)
6. `src/lib/api.ts` — the `updateSettings` client call
7. `src/queries/index.ts` — `settingsQueryOptions` / `queryKeys.settings`
8. one of the 12 `*SettingsPage.tsx` files under `src/components/views/`
9. `src/shared/electron-contract.ts` + `electron/preload.ts`, if it crosses the boundary

**Known wart:** `AppSettings` is declared in `src/lib/api.ts` — a client HTTP
module — rather than `src/shared/`, where the rest of the domain types live. It
has not been moved because the pending plans touch these files; don't move it
casually mid-plan.

**Use the writer.** `src/lib/settings-mutation.ts` owns the
snapshot/optimistic-write/rollback dance. Settings pages call it instead of
hand-rolling `getQueryData` / `setQueryData` / try / rollback. If you find
yourself writing that block, you are duplicating something that already exists.

**Tripwire:** if adding one field to a feature touches more than four files, that
feature needs a registry before it needs anything else. Settings got to 130+
files this way.

## Conventions

- **Naming:** files are kebab-case (`settings-mutation.ts`); React components are
  PascalCase files under `src/components/`. Controllers end `.controller.ts`,
  repositories `.repo.ts`.
- **Imports:** `~/` maps to `src/`. Electron code reaches into `src/shared/` by
  relative path and must list the file in `electron/tsconfig.json`'s `include`.
- **Tests** live in a sibling `__tests__/` directory, named `<subject>.test.ts`.
  The suite is a real asset (227 files, ~21% test-to-code) — it is what makes
  aggressive refactoring safe here. Delete a file's tests when you delete the
  file; do not trim tests to hit a line target.
- **Dead code:** `pnpm knip:gate` runs in CI and fails on unused files,
  dependencies, and binaries. Some dependencies are only referenced from CSS
  (`@fontsource/*`, `tailwindcss`) or resolved at runtime by path
  (`@vscode/tree-sitter-wasm`); they are listed in `knip.json`'s
  `ignoreDependencies` and are **not** dead. Verify before deleting.

## Big files — know before you open

These are large enough that reading one costs real budget. Check whether you
actually need the whole file.

| File | Lines | Note |
|---|---|---|
| `src/routes/projects.$id.tsx` | 2,901 | Highest-churn file in the repo. Routing, session state, terminal wiring, layout — effectively the application. Carving it up is deferred (item 47 in `docs/refactor-plan.md`); pending plans put new surface in new files instead. |
| `src/components/views/SessionGrid.tsx` | 2,432 | |
| `src/server/services/provider-usage/all-adapters.ts` | 2,342 | ~57 provider adapters behind one `fetchProviderUsage(id)` switch. |
| `electron/main.ts` | 2,231 | |
| `electron/sandbox-manager.ts` | 1,877 | |

## Don't read these

- `dist/`, `dist-electron/` — build output
- `../chaos-wrangler-build/` — electron-builder output, deliberately a **sibling
  of the repo** so `find` / `ls -R` / `du` inside the working tree never walk it.
  CI overrides it back to `dist-electron-out/` for artifact upload.
- `public/` (23 MB), `designs/` — assets and the original HTML prototype
- `.dev-userdata/` — local dev SQLite + app state
- `docs/archive/` — superseded plans and specs kept only for history. They
  describe a codebase that no longer exists; reading one is worse than reading
  nothing.
- `node_modules/`, `pnpm-lock.yaml`

## Planning docs

- `docs/plans/` — the active plan set. `docs/plans/EXECUTION.md` is the runbook
  and carries the ordering constraints between them.
- `docs/refactor-plan.md` and `TODO.md` are **live backlogs** with deferred items
  that active plans cite. Not archive material.
- `PRODUCT.md` is the current product framing. The old `SPEC.md` is in
  `docs/archive/`.
