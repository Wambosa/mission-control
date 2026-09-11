import { useCallback, useRef, useState } from "react";
import { buildGroupScopeEntries } from "~/lib/active-group";
import { useGroupMutations } from "~/lib/use-group-mutations";
import type { Group } from "~/db/schema";
import type { ActiveProjectGroup } from "~/shared/ui-preferences";

const CHIP_RADIUS = 999;

/**
 * Dashboard view-filter surface: the chip row for the globally active group —
 * the visual twin of the header GroupSwitcher (same state, richer at-a-glance
 * counts) — under a heading that names what the row does, with the control
 * that creates a group beside it. Empty groups stay selectable so a fresh
 * group can be filled via its empty state.
 *
 * The heading and the create control render even at zero groups: that is the
 * moment the control matters most, so it cannot live behind the chip list's
 * empty guard.
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
  const { createGroup } = useGroupMutations();
  const [creating, setCreating] = useState(false);
  // Escape and a successful commit both blur the field; without this the blur
  // handler would fire a second create from the same keystroke.
  const settledRef = useRef(false);

  const entries = buildGroupScopeEntries({ groups, projects, activeGroup });

  const startCreating = useCallback(() => {
    settledRef.current = false;
    setCreating(true);
  }, []);

  const cancelCreating = useCallback(() => {
    settledRef.current = true;
    setCreating(false);
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
            return (
              <button
                key={entry.key}
                type="button"
                aria-pressed={active}
                onClick={() => onChange(entry.key)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 12px",
                  borderRadius: CHIP_RADIUS,
                  border: `1px solid ${active ? "var(--accent-border)" : "var(--border-strong)"}`,
                  background: active ? "var(--accent-dim)" : "var(--surface-1)",
                  color: active ? "var(--text)" : "var(--text-dim)",
                  fontSize: 12.5,
                  cursor: "pointer",
                  transition: "border-color 120ms ease, background 120ms ease",
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
                {entry.label}
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
                cancelCreating();
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
    </section>
  );
}
