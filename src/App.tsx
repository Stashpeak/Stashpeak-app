import { useEffect, useState, type ReactElement } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DashboardView } from "./components/DashboardView";
import { MapView } from "./components/MapView";
import { SettingsView } from "./components/SettingsView";
import { SpendView } from "./components/SpendView";
import { StashpeakLogo } from "./components/StashpeakLogo";
import { SubscriptionsView } from "./components/SubscriptionsView";
import { useTheme } from "./hooks/useTheme";
import { WindowControls } from "./components/WindowControls";
import "./App.css";

export type Section = "dashboard" | "subscriptions" | "docker" | "spend" | "map" | "settings";
const IS_DEV_BUILD = import.meta.env.DEV;

const GEAR_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
  </svg>
);

const ICONS: Record<Section, ReactElement> = {
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="1" width="6" height="6" rx="1.5" />
      <rect x="9" y="1" width="6" height="6" rx="1.5" />
      <rect x="1" y="9" width="6" height="6" rx="1.5" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" />
    </svg>
  ),
  subscriptions: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="14" height="10" rx="2" />
      <path d="M1 6h14" />
      <path d="M5 10h2M9 10h2" />
    </svg>
  ),
  docker: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="5" width="3" height="3" rx="0.5" />
      <rect x="5" y="5" width="3" height="3" rx="0.5" />
      <rect x="9" y="5" width="3" height="3" rx="0.5" />
      <rect x="5" y="1" width="3" height="3" rx="0.5" />
      <path d="M1 11c0 1.1.9 2 2 2h10a2 2 0 0 0 2-2V9H1v2z" />
    </svg>
  ),
  spend: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v12M5 5.5C5 4.12 6.34 3 8 3s3 1.12 3 2.5S9.66 8 8 8 5 9.12 5 10.5 6.34 13 8 13s3-1.12 3-2.5" />
    </svg>
  ),
  map: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2L2 4v10l4-2 4 2 4-2V2l-4 2-4-2z" />
      <path d="M6 2v10M10 4v10" />
    </svg>
  ),
  settings: GEAR_ICON,
};

const SECTION_LABELS: Record<Section, string> = {
  dashboard: "Dashboard",
  subscriptions: "Subscriptions",
  docker: "Docker",
  spend: "Spend",
  map: "Map",
  settings: "Settings",
};

function EmptyState({ section }: { section: "docker" }) {
  const descriptions: Record<"docker", string> = {
    docker: "Monitor your local AI containers - Ollama, OpenWebUI, Qdrant, and anything else running on your machine.",
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-(--glass-border) bg-(--purple-accent) text-(--purple-button-text) backdrop-blur-[5px]">
        {ICONS[section]}
      </div>
      <div className="space-y-1.5">
        <h2 className="text-xl text-(--text-primary) font-light">
          {SECTION_LABELS[section]}
        </h2>
        <p className="max-w-xs text-sm leading-relaxed text-(--text-secondary)">{descriptions[section]}</p>
      </div>
      <span className="text-[10px] uppercase tracking-[0.25em] text-(--text-subtle)">
        Coming soon
      </span>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState<Section>("dashboard");
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const { theme, setTheme, resolvedTheme } = useTheme();

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.1.0"));

    import("./lib/updater").then(({ checkForUpdate }) => {
      checkForUpdate()
        .then((result) => {
          if (result) setUpdateAvailable(true);
        })
        .catch(() => {
          /* offline is fine */
        });
    });
  }, []);

  return (
    <div
      className="flex h-screen overflow-hidden select-none bg-(--bg-gradient) text-(--text-primary)"
    >
      <aside
        className="flex w-64 shrink-0 flex-col border-r bg-(--sidebar-bg) border-(--border-sidebar) backdrop-blur-[20px]"
      >
        <div 
          className="flex items-center border-b px-4 py-4 border-(--border-subtle)" 
          data-tauri-drag-region
        >
          <button
            onClick={() => openUrl("https://stashpeak.com")}
            className="glass-surface [--glass-surface-fill:var(--logo-pill-fill)] cursor-pointer rounded-[80px] flex items-center gap-2.5 py-[7px] pl-[7px] pr-[14px] backdrop-blur-[10px] border-none"
          >
            <StashpeakLogo width={28} height={27} theme={resolvedTheme} />
            <span className="font-normal text-[14px] text-(--logo-text) whitespace-nowrap">
              Stashpeak
            </span>
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3">
          {(["dashboard", "map", "spend", "subscriptions", "docker"] as Section[]).map((id) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={`flex h-10 w-full items-center gap-2.5 rounded-full border border-transparent px-3 text-left text-sm transition-colors cursor-pointer ${
                active === id
                  ? "glass-surface [--glass-surface-fill:var(--nav-active-fill)] text-(--text-primary)"
                  : "text-(--text-secondary) hover:bg-(--glass-bg) hover:text-(--text-primary)"
              }`}
            >
              <span className={`shrink-0 transition-colors ${active === id ? "text-(--text-primary)" : "text-(--text-secondary)"}`}>
                {ICONS[id]}
              </span>
              {SECTION_LABELS[id]}
            </button>
          ))}
        </nav>

        <div className="flex items-center justify-between border-t px-4 py-3 border-(--border-subtle)">
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-wider text-(--text-subtle)">
              {appVersion ? `v${appVersion}` : ""}
            </span>
            {IS_DEV_BUILD && (
              <span
                title="Development build"
                className="rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2 py-0.5 text-[9px] font-semibold tracking-[0.24em] text-emerald-600"
              >
                DEV
              </span>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => setActive("settings")}
              title={updateAvailable ? "Settings (update available)" : "Settings"}
              className={`rounded-full p-1 transition-colors cursor-pointer ${
                active === "settings"
                  ? "text-(--text-primary)"
                  : "text-(--text-subtle) hover:text-(--text-primary)"
              }`}
            >
              {GEAR_ICON}
            </button>
            {updateAvailable && (
              <span
                className="pointer-events-none absolute right-0 top-0 h-2 w-2 rounded-full bg-(--purple-primary) shadow-[0_0_0_2px_var(--bg-surface)]"
              />
            )}
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <WindowControls />
        <div className="flex min-h-0 flex-1 flex-col">
          {active === "dashboard" ? (
            <DashboardView onNavigate={setActive} />
          ) : active === "subscriptions" ? (
            <SubscriptionsView />
          ) : active === "spend" ? (
            <SpendView onNavigate={setActive} />
          ) : active === "map" ? (
            <MapView />
          ) : active === "settings" ? (
            <SettingsView
              onThemeChange={setTheme}
              onUpdateConsumed={() => setUpdateAvailable(false)}
              resolvedTheme={resolvedTheme}
              theme={theme}
              updateAvailable={updateAvailable}
            />
          ) : (
            <EmptyState section={active} />
          )}
        </div>
      </main>
    </div>
  );
}
