import { useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { PromptSearchButton } from "~/components/views/PromptSearchButton";
import { useHideableMenu } from "~/lib/hideable-elements";
import { useSettings } from "~/queries";
import { DEFAULT_HEADER_BUTTON_VISIBILITY } from "~/shared/header-buttons";

const STORAGE_KEY = "mc.headerToolsExpanded";

/**
 * Collapsible tray for the low-frequency header tools. Collapsed to a single
 * "…" button by default so the top bar stays quiet; expanding is an explicit,
 * persisted choice — an inline toggle rather than a transient popover, because
 * the tools own their own portaled dropdowns (a popover wrapper would close
 * under them). Every tool keeps its global hotkey while hidden.
 *
 * Each tool can also be hidden outright (right-click → Hide, or Settings →
 * Interface). With them all hidden the "…" toggle would open onto nothing, so
 * the whole tray disappears with them.
 */
export function HeaderToolsCluster() {
  const { data: settings } = useSettings();
  const visibility = settings?.headerButtons ?? DEFAULT_HEADER_BUTTON_VISIBILITY;
  const { hideElementContextMenu, hideableMenu } = useHideableMenu();
  const [expanded, setExpanded] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggle = () =>
    setExpanded((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore quota / privacy-mode errors
      }
      return next;
    });

  const anyVisible = visibility.promptSearch;
  if (!anyVisible) return null;

  return (
    <>
      {expanded && (
        <>
          {visibility.promptSearch && (
            <PromptSearchButton
              onContextMenu={hideElementContextMenu("header-button:promptSearch")}
            />
          )}
        </>
      )}
      <Btn
        variant="ghost"
        icon="more"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={expanded ? "Hide tools" : "Show tools"}
        title={expanded ? "Hide tools" : "Tools — prompt search"}
        style={
          expanded
            ? { background: "var(--surface-2)", color: "var(--text)" }
            : undefined
        }
      />
      {hideableMenu}
    </>
  );
}
