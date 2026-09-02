import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import { getElectron } from "./electron";
import { prefetchTerminalModules } from "./prefetch-terminal-modules";
import {
  discardUserTerminalWarmSlot,
  prepareUserTerminalWarmSlot,
  replenishUserTerminalWarmSlot,
  takeUserTerminalWarmSlot,
} from "./user-terminal-warm-pool";
import { isRemotePtyId } from "./pty-id";
import { isRemoteProjectRuntime } from "./sandbox-runtime";
import { terminalSurfaceCache } from "./terminal-surface-cache";
import type { UserTerminal } from "~/db/schema";
import { HOME_TERMINAL_PROJECT_ID } from "~/shared/home-terminal";
import { LOCAL_SCOPE_ID } from "~/shared/sandbox";
import { scopeKeyForProject, type ScopedProject } from "./scoped-project";
import { readJson, writeJson } from "./local-storage-json";

// Scope-key namespace for project-less "home" terminals (the dashboard
// terminals). A home terminal has no project and therefore no host: it runs on
// this machine, under the Local key (`__home__:local`). The key stays
// scope-shaped so buckets recorded against a sandbox before scope became a
// project property are still addressable — see closeHomeForScope. Sessions/
// focus/hidden/panel state live in the same per-scope records as project
// terminals, so they persist across navigation just like project terminals.
const HOME_SCOPE_PREFIX = `${HOME_TERMINAL_PROJECT_ID}:`;
function homeScopeKeyFor(scopeId: string): string {
  return `${HOME_SCOPE_PREFIX}${scopeId}`;
}

// Persisted UI state. Hoisted so the read (init) and write (effect) of each key
// can't drift apart.
const HIDDEN_IDS_STORAGE_KEY = "mc.userTerminalHiddenIds";
const PANEL_OPEN_STORAGE_KEY = "mc.userTerminalPanelOpen";
function isHomeScopeKey(key: string): boolean {
  return key.startsWith(HOME_SCOPE_PREFIX);
}

type Session = {
  terminal: UserTerminal;
  ptyId: string | null;
};

type Ctx = {
  project: ScopedProject | null;
  setProject: (project: ScopedProject | null) => void;
  /** Whether the project-less "home" (dashboard) terminal scope is active. */
  homeActive: boolean;
  setHomeActive: (active: boolean) => void;
  panelOpen: boolean;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  sessions: Session[];
  sessionsByScope: Record<string, Session[]>;
  runningProjectIds: Set<string>;
  runningWorktreeIds: Set<string>;
  focusedId: string | null;
  focusTerminal: (id: string) => void;
  createTerminal: (opts?: {
    name?: string;
    startCommand?: string | null;
    project?: ScopedProject;
    cwd?: string | null;
    /** Whether the new terminal should grab focus on open. Defaults to true. */
    focusOnCreate?: boolean;
  }) => Promise<UserTerminal | null>;
  /** Permanently close every user terminal for a project (kills PTYs). */
  closeForProject: (projectId: string) => Promise<void>;
  /** Permanently close dashboard home terminals for a sandbox/local scope. */
  closeHomeForScope: (scopeId: string) => Promise<void>;
  killTerminal: (id: string) => Promise<void>;
  hiddenIds: Set<string>;
  toggleHidden: (id: string) => void;
  renameTerminal: (id: string, name: string) => Promise<void>;
  setPtyId: (terminalId: string, ptyId: string | null) => void;
  cycleNext: () => void;
  cyclePrev: () => void;
};

const UserTerminalContext = createContext<Ctx | null>(null);

export function terminalScopeKeysForProject(
  buckets: Record<string, unknown>,
  projectId: string,
): string[] {
  return Object.keys(buckets).filter(
    (key) => key === projectId || key.startsWith(`${projectId}:`),
  );
}

/** Bucket-state updater that drops every scope key belonging to `projectId`. */
function dropProjectKeys<T>(projectId: string) {
  return (prev: Record<string, T>): Record<string, T> => {
    const keys = terminalScopeKeysForProject(prev, projectId);
    if (keys.length === 0) return prev;
    const next = { ...prev };
    for (const key of keys) delete next[key];
    return next;
  };
}

/** Bucket-state updater that drops a single key if present. */
function dropKey<T>(key: string) {
  return (prev: Record<string, T>): Record<string, T> => {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  };
}

export function UserTerminalProvider({ children }: { children: ReactNode }) {
  const [project, setProjectState] = useState<ScopedProject | null>(null);
  // The dashboard activates this so a project-less "home" terminal scope becomes
  // current. A real project always wins (see scopeKey) so a lingering home flag
  // can never shadow a project's terminals.
  const [homeActive, setHomeActive] = useState(false);
  // Sessions for every project visited this app run, keyed by projectId.
  // Sessions stay alive across project switches so PTYs are not killed when
  // the user navigates away and back.
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [focusedByProject, setFocusedByProject] = useState<Record<string, string | null>>({});
  const [hiddenIdsByProject, setHiddenIdsByProject] = useState<Record<string, string[]>>(() =>
    readJson<Record<string, string[]>>(HIDDEN_IDS_STORAGE_KEY, {}),
  );
  useEffect(() => {
    writeJson(HIDDEN_IDS_STORAGE_KEY, hiddenIdsByProject);
  }, [hiddenIdsByProject]);
  const [panelOpenByProject, setPanelOpenByProject] = useState<Record<string, boolean>>(() =>
    readJson<Record<string, boolean>>(PANEL_OPEN_STORAGE_KEY, {}),
  );
  useEffect(() => {
    writeJson(PANEL_OPEN_STORAGE_KEY, panelOpenByProject);
  }, [panelOpenByProject]);
  const loadedProjectsRef = useRef<Set<string>>(new Set());
  // Mirror of sessionsByProject. killTerminal reads this synchronously instead
  // of via a setState updater, since React 18 skips eager-state evaluation
  // when the fiber already has pending lanes (e.g. when the same click also
  // triggered a focus setState first), making closure mutation inside the
  // updater unreliable.
  const sessionsByProjectRef = useRef<Record<string, Session[]>>({});
  useEffect(() => {
    sessionsByProjectRef.current = sessionsByProject;
  }, [sessionsByProject]);

  // Active scope key: a real project takes precedence over the home flag, so a
  // stale homeActive can never shadow a project's terminals. Home is current only
  // when no project is selected.
  const scopeKey = project
    ? scopeKeyForProject(project)
    : homeActive
      ? homeScopeKeyFor(LOCAL_SCOPE_ID)
      : null;
  const panelOpen = scopeKey ? (panelOpenByProject[scopeKey] ?? false) : false;
  const setPanelOpen = useCallback(
    (open: boolean) => {
      if (!scopeKey) return;
      setPanelOpenByProject((prev) =>
        prev[scopeKey] === open ? prev : { ...prev, [scopeKey]: open }
      );
    },
    [scopeKey]
  );
  const togglePanel = useCallback(() => {
    if (!scopeKey) return;
    setPanelOpenByProject((prev) => ({ ...prev, [scopeKey]: !(prev[scopeKey] ?? true) }));
  }, [scopeKey]);

  const setProject = useCallback((next: ScopedProject | null) => {
    setProjectState((prev) =>
      prev?.id === next?.id &&
      prev?.activeWorktreeId === next?.activeWorktreeId &&
      prev?.activeRuntimeScopeId === next?.activeRuntimeScopeId
        ? prev
        : next
    );
  }, []);

  // Lazy-load each project's persisted terminals the first time we see it.
  // Existing buckets are left alone so live PTYs survive project switches.
  useEffect(() => {
    const id = project?.id;
    const key = project ? scopeKeyForProject(project) : null;
    if (!id || !key) return;
    if (loadedProjectsRef.current.has(key)) return;
    loadedProjectsRef.current.add(key);

    let cancelled = false;
    void (async () => {
      try {
        const { terminals } = await api.listUserTerminals(
          id,
          project.activeWorktreeId ?? null,
          project.activeRuntimeScopeId ?? LOCAL_SCOPE_ID,
        );
        if (cancelled) return;
        setSessionsByProject((prev) => {
          if (prev[key]) return prev; // a createTerminal call beat us to it
          return { ...prev, [key]: terminals.map((t) => ({ terminal: t, ptyId: null })) };
        });
        setFocusedByProject((prev) => {
          if (prev[key] !== undefined) return prev;
          return { ...prev, [key]: terminals[0]?.id ?? null };
        });
      } catch {
        loadedProjectsRef.current.delete(key);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Lazy-load persisted home terminals the first time each scope's home bucket is
  // active. Mirrors the per-project loader; home sessions then survive navigation
  // and scope switches in the same sessionsByProject bucket keyed per scope.
  useEffect(() => {
    if (!homeActive) return;
    const key = homeScopeKeyFor(LOCAL_SCOPE_ID);
    if (loadedProjectsRef.current.has(key)) return;
    loadedProjectsRef.current.add(key);

    let cancelled = false;
    void (async () => {
      try {
        const { terminals } = await api.listHomeTerminals();
        if (cancelled) return;
        setSessionsByProject((prev) => {
          if (prev[key]) return prev; // a createTerminal call beat us to it
          return { ...prev, [key]: terminals.map((t) => ({ terminal: t, ptyId: null })) };
        });
        setFocusedByProject((prev) => {
          if (prev[key] !== undefined) return prev;
          return { ...prev, [key]: terminals[0]?.id ?? null };
        });
      } catch {
        loadedProjectsRef.current.delete(key);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [homeActive]);

  const warmPrepareKey = project?.path
    ? `${scopeKeyForProject(project)}:${project.path}`
    : null;
  // Read `project` through a ref so a project-query refetch that returns a new
  // reference with identical data doesn't change the effect deps and churn the
  // warm slot (kill + respawn the shell PTY). `warmPrepareKey` already encodes
  // everything that should trigger teardown/re-prepare.
  const warmInputRef = useRef({ project });
  warmInputRef.current = { project };
  useEffect(() => {
    const { project } = warmInputRef.current;
    if (!project?.path || !warmPrepareKey) return;
    void prefetchTerminalModules();
    void prepareUserTerminalWarmSlot({ project, cwd: project.path });
    return () => {
      void discardUserTerminalWarmSlot();
    };
    // Depend only on warmPrepareKey (the stable logical key); inputs come from the ref.
  }, [warmPrepareKey]);

  const sessions = scopeKey ? (sessionsByProject[scopeKey] ?? []) : [];
  const runningProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [key, list] of Object.entries(sessionsByProject)) {
      if (list.some((s) => s.ptyId)) ids.add(key.split(":")[0]!);
    }
    return ids;
  }, [sessionsByProject]);
  const runningWorktreeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [key, list] of Object.entries(sessionsByProject)) {
      if (list.some((s) => s.ptyId)) ids.add(key);
    }
    return ids;
  }, [sessionsByProject]);
  const focusedId = scopeKey ? (focusedByProject[scopeKey] ?? null) : null;
  const hiddenIds = useMemo<Set<string>>(
    () => new Set(scopeKey ? (hiddenIdsByProject[scopeKey] ?? []) : []),
    [scopeKey, hiddenIdsByProject]
  );
  const toggleHidden = useCallback(
    (id: string) => {
      if (!scopeKey) return;
      const key = scopeKey;
      const hiddenIds = hiddenIdsByProject[key] ?? [];
      const hiding = !hiddenIds.includes(id);
      setHiddenIdsByProject((prev) => {
        const cur = prev[key] ?? [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        return { ...prev, [key]: next };
      });

      if (!hiding) {
        setPanelOpenByProject((prev) => (prev[key] === true ? prev : { ...prev, [key]: true }));
        return;
      }

      const visibleAfterHide = (sessionsByProjectRef.current[key] ?? []).filter(
        (s) => s.terminal.id !== id && !hiddenIds.includes(s.terminal.id)
      );
      if (visibleAfterHide.length === 0) {
        setPanelOpenByProject((prev) =>
          prev[key] === false ? prev : { ...prev, [key]: false }
        );
      }
    },
    [hiddenIdsByProject, scopeKey]
  );

  const updateSessions = useCallback(
    (projectId: string, fn: (prev: Session[]) => Session[]) => {
      setSessionsByProject((prev) => ({ ...prev, [projectId]: fn(prev[projectId] ?? []) }));
    },
    []
  );

  const setFocusFor = useCallback((projectId: string, id: string | null) => {
    setFocusedByProject((prev) => (prev[projectId] === id ? prev : { ...prev, [projectId]: id }));
  }, []);

  const createTerminal = useCallback(
    async (opts?: { name?: string; startCommand?: string | null; project?: ScopedProject; cwd?: string | null; focusOnCreate?: boolean }) => {
      const targetProject = opts?.project ?? project;
      const focusOnCreate = opts?.focusOnCreate ?? true;
      // Home mode: no project context → create a project-less home terminal. The
      // cwd is resolved at spawn time per-runtime (host/remote home dir), so we
      // persist no host path here. Home terminals are never launch/ephemeral, so
      // startCommand and the warm-slot fast path don't apply.
      if (!targetProject && homeActive) {
        const key = homeScopeKeyFor(LOCAL_SCOPE_ID);
        const { terminal } = await api.createHomeTerminal({
          name: opts?.name,
          scopeId: LOCAL_SCOPE_ID,
        });
        updateSessions(key, (prev) => [...prev, { terminal, ptyId: null }]);
        if (focusOnCreate) setFocusFor(key, terminal.id);
        setPanelOpenByProject((prev) => ({ ...prev, [key]: true }));
        return terminal;
      }
      if (!targetProject) return null;
      const projectId = targetProject.id;
      const key = scopeKeyForProject(targetProject);
      const cwd = opts?.cwd ?? targetProject.path;
      const startCommand = opts?.startCommand ?? null;
      const electron = getElectron();
      const canUseWarmSlot =
        !startCommand &&
        !!cwd &&
        !!electron &&
        !isRemoteProjectRuntime(targetProject.sandboxId);

      if (canUseWarmSlot) {
        const warmSlot = takeUserTerminalWarmSlot(
          cwd,
          targetProject.activeRuntimeScopeId ?? LOCAL_SCOPE_ID,
        );
        if (warmSlot) {
          const draftTerminal: UserTerminal = {
            ...warmSlot.draftTerminal,
            name: opts?.name?.trim() || warmSlot.draftTerminal.name,
          };
          updateSessions(key, (prev) => [...prev, { terminal: draftTerminal, ptyId: warmSlot.ptyId }]);
          if (focusOnCreate) setFocusFor(key, draftTerminal.id);
          setPanelOpenByProject((prev) => ({ ...prev, [key]: true }));

          void (async () => {
            try {
              const { terminal } = await api.createUserTerminal(projectId, {
                id: warmSlot.clientTerminalId,
                cwd,
                name: opts?.name,
                worktreeId: targetProject.activeWorktreeId ?? null,
                scopeId: targetProject.activeRuntimeScopeId ?? LOCAL_SCOPE_ID,
              });
              updateSessions(key, (prev) =>
                prev.map((s) =>
                  s.terminal.id === warmSlot.clientTerminalId
                    ? { terminal, ptyId: warmSlot.ptyId }
                    : s,
                ),
              );
              replenishUserTerminalWarmSlot({ project: targetProject, cwd });
            } catch {
              if (electron) await electron.pty.kill(warmSlot.ptyId).catch(() => undefined);
              updateSessions(key, (prev) =>
                prev.filter((s) => s.terminal.id !== warmSlot.clientTerminalId),
              );
              replenishUserTerminalWarmSlot({ project: targetProject, cwd });
            }
          })();
          return draftTerminal;
        }
      }

      const { terminal } = await api.createUserTerminal(projectId, {
        cwd,
        name: opts?.name,
        startCommand,
        worktreeId: targetProject.activeWorktreeId ?? null,
        scopeId: targetProject.activeRuntimeScopeId ?? LOCAL_SCOPE_ID,
      });
      updateSessions(key, (prev) => [...prev, { terminal, ptyId: null }]);
      if (focusOnCreate) setFocusFor(key, terminal.id);
      setPanelOpenByProject((prev) => ({ ...prev, [key]: true }));
      if (!startCommand && cwd) {
        replenishUserTerminalWarmSlot({ project: targetProject, cwd });
      }
      return terminal;
    },
    [project, homeActive, updateSessions, setFocusFor]
  );

  const killTerminal = useCallback(
    async (id: string) => {
      const electron = getElectron();
      // Resolve owner + neighbor synchronously from the latest snapshot. Doing
      // this inside a setState updater breaks when the fiber has pending lanes
      // (the updater would run lazily, leaving the closure vars null).
      const snapshot = sessionsByProjectRef.current;
      let ownerProjectId: string | null = null;
      let killedPtyId: string | null = null;
      let neighborId: string | null = null;
      let lastTerminal = false;
      for (const [pid, list] of Object.entries(snapshot)) {
        const idx = list.findIndex((s) => s.terminal.id === id);
        if (idx === -1) continue;
        ownerProjectId = pid;
        killedPtyId = list[idx]!.ptyId;
        const filtered = list.filter((s) => s.terminal.id !== id);
        if (filtered.length > 0) {
          const pick = idx > 0 ? idx - 1 : 0;
          neighborId = filtered[pick]!.terminal.id;
        } else {
          lastTerminal = true;
        }
        break;
      }
      if (!ownerProjectId) return;

      // Dispose the cached xterm surface — a kill is a real teardown, not a
      // parkable scope switch, so the persistent subscription + Terminal go too.
      terminalSurfaceCache.destroy(id);

      setSessionsByProject((prev) => ({
        ...prev,
        [ownerProjectId!]: (prev[ownerProjectId!] ?? []).filter(
          (s) => s.terminal.id !== id
        ),
      }));
      setFocusedByProject((prev) => {
        if (prev[ownerProjectId!] !== id) return prev;
        return { ...prev, [ownerProjectId!]: neighborId };
      });
      setHiddenIdsByProject((prev) => {
        const cur = prev[ownerProjectId!];
        if (!cur || !cur.includes(id)) return prev;
        return { ...prev, [ownerProjectId!]: cur.filter((x) => x !== id) };
      });
      if (lastTerminal) {
        setPanelOpenByProject((prev) =>
          prev[ownerProjectId!] === false
            ? prev
            : { ...prev, [ownerProjectId!]: false }
        );
      }

      if (killedPtyId && electron) {
        const ptyApi = isRemotePtyId(killedPtyId) ? electron.remotePty : electron.pty;
        await ptyApi.kill(killedPtyId).catch(() => undefined);
      }
      try {
        if (isHomeScopeKey(ownerProjectId)) await api.deleteHomeTerminal(id);
        else await api.deleteUserTerminal(id);
      } catch {
        /* swallow */
      }
    },
    []
  );

  const closeForProject = useCallback(
    async (projectId: string) => {
      const keys = terminalScopeKeysForProject(sessionsByProjectRef.current, projectId);
      const ids = keys.flatMap((key) =>
        (sessionsByProjectRef.current[key] ?? []).map((s) => s.terminal.id),
      );
      for (const id of ids) {
        await killTerminal(id);
      }
      for (const key of keys) loadedProjectsRef.current.delete(key);
      setSessionsByProject(dropProjectKeys(projectId));
      setFocusedByProject(dropProjectKeys(projectId));
      setHiddenIdsByProject(dropProjectKeys(projectId));
      setPanelOpenByProject(dropProjectKeys(projectId));
    },
    [killTerminal],
  );

  const closeHomeForScope = useCallback(
    async (scopeId: string) => {
      const key = homeScopeKeyFor(scopeId || LOCAL_SCOPE_ID);
      const ids = (sessionsByProjectRef.current[key] ?? []).map((s) => s.terminal.id);
      for (const id of ids) {
        await killTerminal(id);
      }
      loadedProjectsRef.current.delete(key);
      setSessionsByProject(dropKey(key));
      setFocusedByProject(dropKey(key));
      setHiddenIdsByProject(dropKey(key));
      setPanelOpenByProject(dropKey(key));
    },
    [killTerminal],
  );

  const renameTerminal = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Resolve home-vs-project from the latest snapshot synchronously (not inside
    // the setState updater, which can run lazily) so the persistence call routes
    // to the right endpoint. Home terminals live under any `__home__:<scope>` key.
    const isHome = Object.entries(sessionsByProjectRef.current).some(
      ([key, list]) => isHomeScopeKey(key) && list.some((s) => s.terminal.id === id)
    );
    setSessionsByProject((prev) => {
      const next = { ...prev };
      for (const [pid, list] of Object.entries(prev)) {
        if (!list.some((s) => s.terminal.id === id)) continue;
        next[pid] = list.map((s) =>
          s.terminal.id === id ? { ...s, terminal: { ...s.terminal, name: trimmed } } : s
        );
      }
      return next;
    });
    try {
      if (isHome) await api.renameHomeTerminal(id, trimmed);
      else await api.renameUserTerminal(id, trimmed);
    } catch {
      /* swallow */
    }
  }, []);

  const setPtyId = useCallback((terminalId: string, ptyId: string | null) => {
    setSessionsByProject((prev) => {
      let next = prev;
      let changed = false;
      for (const [pid, list] of Object.entries(prev)) {
        if (!list.some((s) => s.terminal.id === terminalId)) continue;
        const updated = list.map((s) => {
          if (s.terminal.id !== terminalId) return s;
          if (s.ptyId === ptyId) return s;
          changed = true;
          return { ...s, ptyId };
        });
        if (updated !== list && changed) {
          next = next === prev ? { ...prev } : next;
          next[pid] = updated;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const focusTerminal = useCallback(
    (id: string) => {
      if (!scopeKey) return;
      setFocusFor(scopeKey, id);
    },
    [scopeKey, setFocusFor]
  );

  const cycle = useCallback(
    (delta: 1 | -1) => {
      if (!scopeKey) return;
      // No-op when the panel is closed — don't open it as a side effect of cycling.
      const key = scopeKey;
      if (!(panelOpenByProject[key] ?? false)) return;
      const list = sessionsByProject[key] ?? [];
      if (list.length === 0) return;
      const cur = focusedByProject[key] ?? null;
      const idx = cur ? list.findIndex((s) => s.terminal.id === cur) : -1;
      const nextIdx = idx === -1 ? 0 : (idx + delta + list.length) % list.length;
      setFocusFor(key, list[nextIdx]!.terminal.id);
    },
    [scopeKey, panelOpenByProject, sessionsByProject, focusedByProject, setFocusFor]
  );

  const cycleNext = useCallback(() => cycle(1), [cycle]);
  const cyclePrev = useCallback(() => cycle(-1), [cycle]);

  const value = useMemo<Ctx>(
    () => ({
      project,
      setProject,
      homeActive,
      setHomeActive,
      panelOpen,
      togglePanel,
      setPanelOpen,
      sessions,
      sessionsByScope: sessionsByProject,
      runningProjectIds,
      runningWorktreeIds,
      focusedId,
      focusTerminal,
      createTerminal,
      closeForProject,
      closeHomeForScope,
      killTerminal,
      hiddenIds,
      toggleHidden,
      renameTerminal,
      setPtyId,
      cycleNext,
      cyclePrev,
    }),
    [
      project,
      setProject,
      homeActive,
      setHomeActive,
      panelOpen,
      togglePanel,
      sessions,
      sessionsByProject,
      runningProjectIds,
      runningWorktreeIds,
      focusedId,
      focusTerminal,
      createTerminal,
      closeForProject,
      closeHomeForScope,
      killTerminal,
      hiddenIds,
      toggleHidden,
      renameTerminal,
      setPtyId,
      cycleNext,
      cyclePrev,
    ]
  );

  return (
    <UserTerminalContext.Provider value={value}>{children}</UserTerminalContext.Provider>
  );
}

export function useUserTerminals() {
  const ctx = useContext(UserTerminalContext);
  if (!ctx) throw new Error("useUserTerminals must be used inside UserTerminalProvider");
  return ctx;
}

/**
 * Like {@link useUserTerminals} but returns null instead of throwing when
 * there's no provider — for surfaces that render outside the main shell (e.g.
 * the pet desktop overlay window), where there's no terminal dock at all.
 */
export function useUserTerminalsOptional() {
  return useContext(UserTerminalContext);
}
