import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { SessionHeader } from "../session-header/SessionHeader.js";
import "./TitleBar.css";

interface TitleBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onSidebarToggleMouseEnter?: () => void;
  onSidebarToggleMouseLeave?: () => void;
}

// Title bar — a fixed-height chrome strip spanning the full width of the
// window. Holds the OS drag region, the sidebar toggle, and (when a session is
// active) the SessionHeader. The height is a constant 38px regardless of
// content; see TitleBar.css and App.css for the enforcing rules.
export function TitleBar({
  sidebarCollapsed,
  onToggleSidebar,
  onSidebarToggleMouseEnter,
  onSidebarToggleMouseLeave,
}: TitleBarProps): React.ReactElement {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  return (
    <div className="titlebar">
      <button
        type="button"
        className="titlebar__sidebar-toggle"
        onClick={onToggleSidebar}
        onMouseEnter={sidebarCollapsed ? onSidebarToggleMouseEnter : undefined}
        onMouseLeave={sidebarCollapsed ? onSidebarToggleMouseLeave : undefined}
        title={`${sidebarCollapsed ? "Show" : "Hide"} sidebar (⌘B)`}
        aria-label={`${sidebarCollapsed ? "Show" : "Hide"} sidebar`}
        aria-pressed={!sidebarCollapsed}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" strokeWidth="1.3" />
          <line x1="6" y1="2.75" x2="6" y2="13.25" strokeWidth="1.3" />
          {!sidebarCollapsed && (
            <rect
              x="1.75"
              y="2.75"
              width="4.25"
              height="10.5"
              rx="1.5"
              fill="currentColor"
              stroke="none"
              opacity="0.45"
            />
          )}
        </svg>
      </button>
      {activeSessionId ? (
        <SessionHeader key={activeSessionId} sessionId={activeSessionId as SessionId} />
      ) : null}
    </div>
  );
}
