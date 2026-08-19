import { useEffect, useMemo, useState } from "react";

import type { RuntimeInfo } from "../shared/desktop-api";
import { Panel } from "./components/Panel";
import { StatusBadge } from "./components/StatusBadge";
import {
  NAVIGATION,
  navigationItem,
  routeFromHash,
  routeHash,
  type RouteId,
} from "./navigation";

type ThemePreference = "system" | "light" | "dark";

const PLACEHOLDER_COPY: Record<RouteId, string[]> = {
  overview: [
    "SourceNerve Account",
    "Git Provider",
    "SourceNerve Daemon",
    "Public MCP",
    "Workspace Health",
  ],
  workspaces: [
    "Choose repositories and local checkouts",
    "Create SourceNerve workspaces without editing TOML",
    "See access, branch, HEAD and index state",
  ],
  intelligence: [
    "Search indexed memory and raw code",
    "Inspect symbols, callers, callees and references",
    "Explore architecture, impact and context packs",
  ],
  tasks: [
    "Task → Branch → Context → Proposal",
    "Apply → Review → Commit → Push",
    "Every mutation stays behind SourceNerve guards",
  ],
  "pull-requests": [
    "Track provider issue and pull-request state",
    "Verify expected head SHA before merge",
    "Sync the default branch explicitly after merge",
  ],
  connections: [
    "SourceNerve Account (Auth0)",
    "GitHub / GitLab",
    "ChatGPT Plugin",
    "Public MCP",
  ],
  diagnostics: [
    "Sanitized Desktop, daemon, auth and tunnel logs",
    "Readiness and version diagnostics",
    "Explicit recovery and support-bundle actions",
  ],
  settings: [
    "Appearance",
    "Startup & Background",
    "Updates",
    "Notifications",
    "Advanced Diagnostics",
  ],
};

function nextTheme(theme: ThemePreference): ThemePreference {
  if (theme === "system") return "light";
  if (theme === "light") return "dark";
  return "system";
}

export function App() {
  const [route, setRoute] = useState<RouteId>(() => routeFromHash(window.location.hash));
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) {
      window.location.hash = routeHash("overview");
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    void window.sourcenerveDesktop
      .getRuntimeInfo()
      .then(setRuntime)
      .catch(() => setRuntime(null));
  }, []);

  const current = useMemo(() => navigationItem(route), [route]);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            SN
          </div>
          <div className="brand__copy">
            <strong>SourceNerve</strong>
            <span>Repository intelligence</span>
          </div>
        </div>

        <nav className="nav-list">
          {NAVIGATION.map((item) => (
            <a
              key={item.id}
              className={`nav-item ${route === item.id ? "nav-item--active" : ""}`}
              href={routeHash(item.id)}
              aria-current={route === item.id ? "page" : undefined}
              title={item.description}
            >
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar__footer">
          <StatusBadge label="Development" tone="working" />
          <span>Desktop scaffold</span>
        </div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace</p>
            <strong>No workspace selected</strong>
          </div>
          <div className="topbar__actions">
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setTheme((value) => nextTheme(value))}
              aria-label={`Theme: ${theme}. Change theme`}
            >
              Theme: {theme}
            </button>
            <StatusBadge label="Local shell" tone="ready" />
          </div>
        </header>

        <main className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">SourceNerve Desktop</p>
              <h1>{current.label}</h1>
              <p>{current.description}</p>
            </div>
            <button className="button" type="button" disabled>
              Coming in next issue
            </button>
          </div>

          {route === "overview" ? (
            <Overview runtime={runtime} />
          ) : (
            <PlaceholderScreen route={route} />
          )}
        </main>

        <footer className="status-strip" aria-label="Runtime status">
          <span>
            <i className="status-dot status-dot--ready" aria-hidden="true" />
            Desktop shell: Ready
          </span>
          <span>
            <i className="status-dot" aria-hidden="true" />
            Daemon: Not connected
          </span>
          <span>
            <i className="status-dot" aria-hidden="true" />
            Public MCP: Not connected
          </span>
          <span>
            {runtime ? `${runtime.platform}/${runtime.arch}` : "Runtime info unavailable"}
          </span>
        </footer>
      </div>
    </div>
  );
}

function Overview({ runtime }: { runtime: RuntimeInfo | null }) {
  return (
    <div className="dashboard-grid">
      <Panel title="SourceNerve Account" eyebrow="Identity">
        <div className="metric-row">
          <StatusBadge label="Not signed in" tone="neutral" />
          <span>Auth0 sign-in is implemented by #65.</span>
        </div>
      </Panel>

      <Panel title="Git Provider" eyebrow="Repository access">
        <div className="metric-row">
          <StatusBadge label="Not connected" tone="neutral" />
          <span>GitHub/GitLab connection is implemented by #64.</span>
        </div>
      </Panel>

      <Panel title="SourceNerve Daemon" eyebrow="Local runtime">
        <dl className="facts">
          <div>
            <dt>Status</dt>
            <dd>Not connected</dd>
          </div>
          <div>
            <dt>Desktop</dt>
            <dd>{runtime?.desktopVersion ?? "—"}</dd>
          </div>
          <div>
            <dt>Electron</dt>
            <dd>{runtime?.electronVersion ?? "—"}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Public MCP" eyebrow="Plugin connectivity">
        <div className="metric-row">
          <StatusBadge label="Not enrolled" tone="neutral" />
          <span>Bootstrap and tunnel lifecycle are surfaced by #66.</span>
        </div>
      </Panel>

      <Panel title="Workspaces" eyebrow="Repository health">
        <div className="empty-state">
          <strong>No workspace selected</strong>
          <p>
            Workspace creation and repository validation arrive in #63. The shell
            already reserves this area for readiness state.
          </p>
        </div>
      </Panel>
    </div>
  );
}

function PlaceholderScreen({ route }: { route: RouteId }) {
  return (
    <Panel title="Planned surface" eyebrow="Scaffold">
      <ul className="feature-list">
        {PLACEHOLDER_COPY[route].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="muted">
        This issue establishes navigation, layout and security boundaries only.
        Feature behavior remains in its dedicated Desktop issue.
      </p>
    </Panel>
  );
}
