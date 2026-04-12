import { useState, useEffect, type ReactElement } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DashboardView } from "./components/DashboardView";
import { SpendView } from "./components/SpendView";
import { SubscriptionsView } from "./components/SubscriptionsView";
import { SettingsView } from "./components/SettingsView";
import { StashpeakLogo } from "./components/StashpeakLogo";
import "./App.css";

export type Section = "dashboard" | "subscriptions" | "docker" | "spend" | "map" | "settings";

const GEAR_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
  </svg>
);

// Minimal SVG icons — clean line style
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
      <path d="M1 11c0 1.1.9 2 2 2h10a2 2 0 002-2V9H1v2z" />
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

function EmptyState({ section }: { section: Exclude<Section, "settings"> }) {
  const descriptions: Record<Exclude<Section, "settings">, string> = {
    dashboard: "Your AI ecosystem at a glance. Add subscriptions, connect Docker, and configure providers to populate this view.",
    subscriptions: "Track your recurring AI subscriptions — ChatGPT Plus, Claude Pro, Cursor, and more. No surprises on billing day.",
    docker: "Monitor your local AI containers — Ollama, OpenWebUI, Qdrant, and anything else running on your machine.",
    spend: "See real API spend across Anthropic, OpenAI, OpenRouter, and Groq in one place. No more tab-switching.",
    map: "A visual map of your entire AI ecosystem — services, tools, and how they connect.",
  };

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 gap-4">
      <div className="w-12 h-12 rounded-2xl bg-[#6750a4]/8 flex items-center justify-center text-[#6750a4]">
        {ICONS[section]}
      </div>
      <div className="space-y-1.5">
        <h2
          className="text-xl text-[#6750a4]"
          style={{ fontFamily: "'Kumbh Sans', sans-serif", fontWeight: 300 }}
        >
          {SECTION_LABELS[section]}
        </h2>
        <p className="text-sm text-[#625b71] max-w-xs leading-relaxed">{descriptions[section]}</p>
      </div>
      <span
        className="text-[10px] text-[#625b71]/50 uppercase tracking-[0.25em]"
        style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
      >
        Coming soon
      </span>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState<Section>("dashboard");
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.1.0"));

    // Silent startup update check — deferred so it doesn't block initial paint
    import("./lib/updater").then(({ checkForUpdate }) => {
      checkForUpdate()
        .then((result) => { if (result) setUpdateAvailable(true); })
        .catch(() => { /* no network or offline is fine */ });
    });
  }, []);

  return (
    <div
      className="flex h-screen bg-white select-none overflow-hidden"
      style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
    >
      {/* Sidebar */}
      <aside className="w-52 flex flex-col border-r border-zinc-100 shrink-0">
        {/* Logo pill — matches LP navbar pill style, links to stashpeak.com */}
        <div className="px-4 py-4 border-b border-zinc-100 flex items-center">
          <button
            onClick={() => openUrl("https://stashpeak.com")}
            className="cursor-pointer"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "7px 14px 7px 7px",
              borderRadius: "80px",
              background: "rgba(43, 0, 81, 0.35)",
              backdropFilter: "blur(10px)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(255,255,255,0.2), inset 1px 0 0 rgba(255,255,255,0.5), inset -1px 0 0 rgba(255,255,255,0.2)",
              border: "none",
            }}
          >
            <StashpeakLogo width={28} height={27} />
            <span style={{ fontFamily: "'Kumbh Sans', sans-serif", fontWeight: 400, fontSize: "14px", color: "white", whiteSpace: "nowrap" }}>
              Stashpeak
            </span>
          </button>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-0.5 p-3 flex-1">
          {(["dashboard", "spend", "subscriptions", "docker", "map"] as Section[]).map((id) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-full text-sm transition-all text-left w-full cursor-pointer ${
                active === id
                  ? "bg-[#6750a4]/10 text-[#6750a4]"
                  : "text-[#625b71] hover:bg-zinc-50 hover:text-[#6750a4]/80"
              }`}
            >
              <span className={`shrink-0 transition-colors ${active === id ? "text-[#6750a4]" : "text-[#625b71]/60"}`}>
                {ICONS[id]}
              </span>
              {SECTION_LABELS[id]}
            </button>
          ))}
        </nav>

        {/* Footer: version + settings gear */}
        <div className="px-4 py-3 border-t border-zinc-100 flex items-center justify-between">
          <span className="text-[10px] text-zinc-300 tracking-wider">
            {appVersion ? `v${appVersion}` : ""}
          </span>
          <div className="relative">
            <button
              onClick={() => setActive("settings")}
              title={updateAvailable ? "Settings (update available)" : "Settings"}
              className={`p-1 rounded-full transition-colors cursor-pointer ${
                active === "settings"
                  ? "text-[#6750a4]"
                  : "text-zinc-300 hover:text-[#6750a4]/60"
              }`}
            >
              {GEAR_ICON}
            </button>
            {updateAvailable && (
              <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-[#6750a4] ring-2 ring-white pointer-events-none" />
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-zinc-50/50">
        <div className="flex-1 overflow-auto">
          {active === "dashboard" ? (
            <DashboardView onNavigate={setActive} />
          ) : active === "subscriptions" ? (
            <SubscriptionsView />
          ) : active === "spend" ? (
            <SpendView onNavigate={setActive} />
          ) : active === "settings" ? (
            <SettingsView
              updateAvailable={updateAvailable}
              onUpdateConsumed={() => setUpdateAvailable(false)}
            />
          ) : (
            <EmptyState section={active} />
          )}
        </div>
      </main>
    </div>
  );
}
