import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Btn } from "~/components/ui/Btn";
import { CardFrame } from "~/components/ui/CardFrame";
import { Icon } from "~/components/ui/Icon";
import { DropdownMenuItem } from "~/components/ui/DropdownMenuItem";
import {
  ACTIVE_GROUP_ALL,
  ACTIVE_GROUP_UNGROUPED,
  UNGROUPED_DOT,
  activeGroupLabel,
  buildGroupScopeEntries,
  useActiveGroup,
} from "~/lib/active-group";
import { useHideableMenu } from "~/lib/hideable-elements";
import { useProjects } from "~/queries";
import { useBinding } from "~/lib/keybindings/store";
import { formatBinding } from "~/lib/keybindings/format";
import { Z_INDEX } from "~/lib/z-index";
import type { ActiveProjectGroup } from "~/shared/ui-preferences";
import { useSuspendAppDragRegion } from "~/lib/use-dismissable-menu";

function GroupDot({ color, size = 7 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 6px ${color}66`,
        flexShrink: 0,
      }}
    />
  );
}

/**
 * Header switcher for the globally active project group — the workspace-like
 * context that scopes the dashboard, the left rail, and the project picker.
 * Leads the TopBar breadcrumb (Group › Project › Scope) as the broadest
 * context; hidden while no groups exist and on Settings/Usage screens.
 */
export function GroupSwitcher() {
  const { activeGroup, setActiveGroup, groups } = useActiveGroup();
  const { data: scopedProjects } = useProjects();
  const [open, setOpen] = useState(false);
  useSuspendAppDragRegion(open);
  const nextGroupBinding = useBinding("group.next");
  const [menuRect, setMenuRect] = useState<{ top: number; left: number } | null>(null);
  const { hideElementContextMenu, hideableMenu } = useHideableMenu();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLElement>(null);

  const updateMenuRect = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setMenuRect({ top: rect.bottom + 6, left: rect.left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    updateMenuRect();
    window.addEventListener("resize", updateMenuRect);
    window.addEventListener("scroll", updateMenuRect, true);
    return () => {
      window.removeEventListener("resize", updateMenuRect);
      window.removeEventListener("scroll", updateMenuRect, true);
    };
  }, [open, updateMenuRect]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // No groups yet — nothing to switch between, keep the header quiet.
  if (groups.length === 0) return null;

  const projects = scopedProjects ?? [];
  const label = activeGroupLabel(activeGroup, groups);
  const activeColor =
    activeGroup === ACTIVE_GROUP_ALL
      ? "var(--text-faint)"
      : activeGroup === ACTIVE_GROUP_UNGROUPED
        ? UNGROUPED_DOT
        : (groups.find((g) => g.id === activeGroup)?.color ?? "var(--text-faint)");

  const select = (next: ActiveProjectGroup) => {
    setOpen(false);
    setActiveGroup(next);
  };

  const entries = buildGroupScopeEntries({
    groups,
    projects,
    activeGroup,
    allColor: "var(--text-faint)",
  });

  return (
    <div ref={anchorRef} className="no-drag" style={{ position: "relative", display: "inline-flex" }}>
      <Btn
        type="button"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Active group: ${label}. Switch group`}
        title={
          nextGroupBinding
            ? `Active group: ${label} — cycle with ${formatBinding(nextGroupBinding)}`
            : `Active group: ${label} — switch group`
        }
        onClick={() => setOpen((v) => !v)}
        onContextMenu={hideElementContextMenu("group-switcher")}
        style={{ paddingInline: 8 }}
      >
        <GroupDot color={activeColor} />
        <span
          style={{
            maxWidth: 140,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: activeGroup === ACTIVE_GROUP_ALL ? "var(--text-dim)" : "var(--text)",
          }}
        >
          {label}
        </span>
        <Icon
          name="chevron-down"
          size={11}
          style={{
            color: "var(--text-faint)",
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 120ms ease",
          }}
        />
      </Btn>
      {open &&
        menuRect &&
        createPortal(
          <CardFrame
            ref={menuRef}
            role="menu"
            aria-label="Switch active group"
            solid
            className="mc-project-actions-menu"
            style={{
              position: "fixed",
              top: menuRect.top,
              left: menuRect.left,
              minWidth: 210,
              boxShadow: "0 14px 32px rgba(0,0,0,0.42)",
              zIndex: Z_INDEX.popover,
            }}
          >
            {entries.map((entry) => {
              const selected = activeGroup === entry.key;
              return (
                <DropdownMenuItem
                  key={entry.key}
                  leading={<GroupDot color={entry.color ?? "var(--text-faint)"} />}
                  aria-current={selected ? "true" : undefined}
                  disabled={entry.pending}
                  onClick={() => {
                    // Its create has not come back yet; the server cannot
                    // resolve this id, so it is not selectable as a scope.
                    if (entry.pending) return;
                    select(entry.key);
                  }}
                  style={
                    selected
                      ? { background: "color-mix(in srgb, var(--accent) 14%, transparent)" }
                      : undefined
                  }
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%" }}>
                    <span style={{ flex: 1 }}>{entry.label}</span>
                    {entry.count !== null && (
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--text-dim)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {entry.count}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </CardFrame>,
          document.body,
        )}
      {hideableMenu}
    </div>
  );
}
