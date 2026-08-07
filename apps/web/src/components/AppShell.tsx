import type { ReactNode } from "react";

import { NavLink } from "../routing/Router";
import { useAuth } from "../state/AuthContext";
import { usePair } from "../state/PairContext";
import { Brand } from "./Brand";
import { ConnectionStatus } from "./ConnectionStatus";
import { PwaManager } from "./PwaManager";

const navigation = [
  { to: "/", label: "Home", glyph: "⌂", end: true },
  { to: "/care", label: "Care", glyph: "♡" },
  { to: "/pair", label: "Pair", glyph: "↔" },
  { to: "/consent", label: "Consent", glyph: "✓" },
  { to: "/privacy", label: "Privacy", glyph: "◉" },
] as const;

export function AppShell({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const { user, logout } = useAuth();
  const { realtimeStatus, privacyPaused, partnerPrivacyPaused } = usePair();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Brand />
          <nav className="desktop-nav" aria-label="Primary navigation">
            {navigation.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={"end" in item && item.end}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-account">
            {privacyPaused || partnerPrivacyPaused ? (
              <span className="privacy-pill">
                {privacyPaused ? "Sharing paused" : "Partner paused"}
              </span>
            ) : (
              <ConnectionStatus status={realtimeStatus} />
            )}
            <details className="account-menu">
              <summary aria-label="Open account menu">
                {user?.displayName.slice(0, 1).toUpperCase() ?? "R"}
              </summary>
              <div className="account-popover">
                <strong>{user?.displayName}</strong>
                <span>{user?.email}</span>
                <NavLink to="/capabilities">Web capabilities</NavLink>
                <button type="button" onClick={() => void logout()}>
                  Sign out
                </button>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main id="main-content" className="main-content" tabIndex={-1}>
        {children}
      </main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {navigation.map((item) => (
          <NavLink key={item.to} to={item.to} end={"end" in item && item.end}>
            <span aria-hidden="true">{item.glyph}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <PwaManager />
    </div>
  );
}
