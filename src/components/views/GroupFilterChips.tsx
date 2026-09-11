import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { ContextMenuPopover } from "~/components/ui/ContextMenuPopover";
import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/DropdownMenuItem";
import { Icon } from "~/components/ui/Icon";
import { ACTIVE_GROUP_ALL, buildGroupScopeEntries, isGroupIdActive } from "~/lib/active-group";
import { GROUP_COLORS } from "~/lib/design-meta";
import { useGroupMutations } from "~/lib/use-group-mutations";
import type { Group } from "~/db/schema";
import type { ActiveProjectGroup } from "~/shared/ui-preferences";

const CHIP_RADIUS = 999;
const CHIP_LABEL_MAX = 160;
const MENU_MIN_WIDTH = 180;

type OpenMenu = { id: string; x: number; y: number };
type MenuMode = "root" | "recolor";

/**
 * Dashboard view-filter surface: the chip row for the globally active group —
 * the visual twin of the header GroupSwitcher (same state, richer at-a-glance
 * counts) — under a heading that names what the row does, with the controls
 * that create and edit groups on the chips themselves. Empty groups stay
 * selectable so a fresh group can be filled via its empty state.
 *
 * The heading and the create control render even at zero groups: that is the
 * moment the control matters most, so it cannot live behind the chip list's
 * empty guard.
 *
 * Each group chip is a container rather than a single button, because a
 * focusable menu trigger cannot nest inside the selection button. Right-click
 * and that trigger open the same menu through one path, so the pointer and
 * keyboard routes cannot drift apart.
 */
export function GroupFilterChips({
  groups,
  projects,
  activeGroup,
  onChange,
}: {
  groups: Group[];
  /** Sandbox-scoped but group-UNscoped list — counts must ignore the filter. */
  projects: Array<{ groupId: string | null }>;
  activeGroup: ActiveProjectGroup;
  onChange: (next: ActiveProjectGroup) => void;
}) {
  const { createGroup, renameGroup, recolorGroup, deleteGroup } = useGroupMutations();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [menuMode, setMenuMode] = useState<MenuMode>("root");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Group | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Escape and a successful commit both blur the field; without this the blur
  // handler would fire a second write from the same keystroke.
  const settledRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>());

  const entries = buildGroupScopeEntries({ groups, projects, activeGroup });
  const menuGroup = menu ? (groups.find((g) => g.id === menu.id) ?? null) : null;

  const closeMenu = useCallback(() => {
    const trigger = menu ? triggerRefs.current.get(menu.id) : null;
    setMenu(null);
    setMenuMode("root");
    trigger?.focus();
  }, [menu]);

  // Focus lands in the menu on open and after a content swap, so the keyboard
  // route reaches the same items the pointer does.
  useEffect(() => {
    if (!menu) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [menu, menuMode]);

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
  }, []);

  const openMenuForGroup = useCallback((id: string, at: { x: number; y: number }) => {
    setMenuMode("root");
    setMenu({ id, ...at });
  }, []);

  const openMenuFromTrigger = useCallback(
    (id: string) => {
      const rect = triggerRefs.current.get(id)?.getBoundingClientRect();
      openMenuForGroup(id, {
        x: rect?.left ?? 0,
        y: rect ? rect.bottom + 4 : 0,
      });
    },
    [openMenuForGroup],
  );

  const openMenuFromPointer = useCallback(
    (id: string, e: ReactMouseEvent) => {
      e.preventDefault();
      openMenuForGroup(id, { x: e.clientX, y: e.clientY });
    },
    [openMenuForGroup],
  );

  const startRenaming = useCallback((id: string) => {
    settledRef.current = false;
    setMenu(null);
    setMenuMode("root");
    setRenamingId(id);
  }, []);

  const commitRename = useCallback(
    async (id: string, raw: string) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setRenamingId(null);
      const name = raw.trim();
      const current = groups.find((g) => g.id === id);
      if (name.length === 0 || name === current?.name) return;
      await renameGroup(id, name);
    },
    [groups, renameGroup],
  );

  const startCreating = useCallback(() => {
    settledRef.current = false;
    setCreating(true);
  }, []);

  const commitCreate = useCallback(
    async (raw: string) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setCreating(false);
      const name = raw.trim();
      // An untouched field that loses focus is a cancel, not a rejected name.
      if (name.length === 0) return;
      await createGroup(name);
    },
    [createGroup],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    // Move the filter off the group first: deleting the scope the dashboard is
    // pointed at would otherwise leave it briefly filtered to nothing.
    if (activeGroup === pendingDelete.id) onChange(ACTIVE_GROUP_ALL);
    await deleteGroup(pendingDelete.id);
    setDeleting(false);
    setPendingDelete(null);
  }, [activeGroup, deleteGroup, onChange, pendingDelete]);

  const pendingDeleteCount = pendingDelete
    ? projects.filter((p) => p.groupId === pendingDelete.id).length
    : 0;

  return (
    <section aria-label="View filters" style={{ marginBottom: 24 }}>
      <h2
        style={{
          margin: "0 0 10px",
          fontFamily: "var(--mono)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
        }}
      >
        View Filters
      </h2>
      <div
        role="group"
        aria-label="Filter projects by group"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {groups.length > 0 &&
          entries.map((entry) => {
            const active = activeGroup === entry.key;
            const editable = isGroupIdActive(entry.key);

            if (editable && renamingId === entry.key) {
              return (
                <input
                  key={entry.key}
                  autoFocus
                  aria-label={`Rename ${entry.label}`}
                  defaultValue={entry.label}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => void commitRename(entry.key, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename(entry.key, e.currentTarget.value);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      settledRef.current = true;
                      setRenamingId(null);
                    }
                  }}
                  style={{
                    width: 150,
                    padding: "5px 12px",
                    borderRadius: CHIP_RADIUS,
                    border: "1px solid var(--accent-border)",
                    background: "var(--surface-1)",
                    color: "var(--text)",
                    fontSize: 12.5,
                    outline: "none",
                  }}
                />
              );
            }

            return (
              <span
                key={entry.key}
                onContextMenu={editable ? (e) => openMenuFromPointer(entry.key, e) : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: CHIP_RADIUS,
                  border: `1px solid ${active ? "var(--accent-border)" : "var(--border-strong)"}`,
                  background: active ? "var(--accent-dim)" : "var(--surface-1)",
                  transition: "border-color 120ms ease, background 120ms ease",
                }}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange(entry.key)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: editable ? "5px 6px 5px 12px" : "5px 12px",
                    border: "none",
                    background: "transparent",
                    borderRadius: CHIP_RADIUS,
                    color: active ? "var(--text)" : "var(--text-dim)",
                    fontSize: 12.5,
                    cursor: "pointer",
                  }}
                >
                  {entry.color && (
                    <span
                      aria-hidden
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: entry.color,
                        boxShadow: `0 0 6px ${entry.color}66`,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <span
                    style={{
                      maxWidth: CHIP_LABEL_MAX,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.label}
                  </span>
                  {entry.count !== null && (
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10.5,
                        color: active ? "var(--text-dim)" : "var(--text-faint)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {entry.count}
                    </span>
                  )}
                </button>
                {editable && (
                  <button
                    type="button"
                    ref={(el) => {
                      triggerRefs.current.set(entry.key, el);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={menu?.id === entry.key}
                    aria-label={`Edit ${entry.label}`}
                    title={`Edit ${entry.label}`}
                    onClick={() => openMenuFromTrigger(entry.key)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 22,
                      height: 22,
                      marginRight: 4,
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      borderRadius: "50%",
                      color: "var(--text-faint)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="chevron-down" size={11} />
                  </button>
                )}
              </span>
            );
          })}

        {creating ? (
          <input
            autoFocus
            aria-label="New group name"
            placeholder="Group name"
            onBlur={(e) => void commitCreate(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitCreate(e.currentTarget.value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                settledRef.current = true;
                setCreating(false);
              }
            }}
            style={{
              width: 150,
              padding: "5px 12px",
              borderRadius: CHIP_RADIUS,
              border: "1px solid var(--accent-border)",
              background: "var(--surface-1)",
              color: "var(--text)",
              fontSize: 12.5,
              outline: "none",
            }}
          />
        ) : (
          <button
            type="button"
            onClick={startCreating}
            title="Create a group"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: CHIP_RADIUS,
              border: "1px dashed var(--border-strong)",
              background: "transparent",
              color: "var(--text-faint)",
              fontSize: 12.5,
              cursor: "pointer",
              transition: "border-color 120ms ease, color 120ms ease",
            }}
          >
            <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
              +
            </span>
            New group
          </button>
        )}
      </div>

      {menu && menuGroup && (
        <ContextMenuPopover
          anchor={{ x: menu.x, y: menu.y }}
          label={`Edit ${menuGroup.name}`}
          minWidth={MENU_MIN_WIDTH}
          onClose={closeMenu}
        >
          <div ref={menuRef} onKeyDown={onMenuKeyDown}>
            {menuMode === "root" ? (
              <>
                <DropdownMenuItem icon="pencil" onClick={() => startRenaming(menuGroup.id)}>
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem icon="circle" onClick={() => setMenuMode("recolor")}>
                  Change color
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon="trash"
                  danger
                  onClick={() => {
                    setMenu(null);
                    setMenuMode("root");
                    setPendingDelete(menuGroup);
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </>
            ) : (
              <div
                role="group"
                aria-label={`Pick a color for ${menuGroup.name}`}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}
              >
                {GROUP_COLORS.map((color) => {
                  const selected = color.toLowerCase() === menuGroup.color.toLowerCase();
                  return (
                    <button
                      key={color}
                      type="button"
                      role="menuitem"
                      aria-label={`Set color ${color}`}
                      aria-pressed={selected}
                      onClick={() => {
                        void recolorGroup(menuGroup.id, color);
                        closeMenu();
                      }}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 6,
                        border: selected
                          ? "2px solid var(--text)"
                          : "1px solid var(--border-strong)",
                        background: color,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </ContextMenuPopover>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete group"
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      >
        <div
          style={{
            fontSize: 13,
            color: "var(--text)",
            marginBottom: 6,
            overflowWrap: "anywhere",
          }}
        >
          Remove &ldquo;{pendingDelete?.name}&rdquo;?
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {pendingDeleteCount === 0
            ? "This group is empty, so nothing else changes."
            : `Its ${pendingDeleteCount} ${
                pendingDeleteCount === 1 ? "project" : "projects"
              } will become ungrouped — they aren't deleted.`}
        </div>
      </ConfirmDialog>
    </section>
  );
}
