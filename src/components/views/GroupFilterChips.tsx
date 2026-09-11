import { buildGroupScopeEntries } from "~/lib/active-group";
import type { Group } from "~/db/schema";
import type { ActiveProjectGroup } from "~/shared/ui-preferences";

/**
 * Dashboard chip row for the globally active group — the visual twin of the
 * header GroupSwitcher (same state, richer at-a-glance counts). Empty groups
 * stay selectable so a fresh group can be filled via its empty state.
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
  if (groups.length === 0) return null;

  const entries = buildGroupScopeEntries({ groups, projects, activeGroup });

  return (
    <div
      role="group"
      aria-label="Filter projects by group"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 24,
      }}
    >
      {entries.map((entry) => {
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
              borderRadius: 999,
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
    </div>
  );
}
