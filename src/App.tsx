import { useState, type ReactElement } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SubscriptionsView } from "./components/SubscriptionsView";
import { StashpeakLogo } from "./components/StashpeakLogo";
import "./App.css";

type Section = "dashboard" | "subscriptions" | "docker" | "spend" | "map";

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
};

const SECTION_LABELS: Record<Section, string> = {
  dashboard: "Dashboard",
  subscriptions: "Subscriptions",
  docker: "Docker",
  spend: "Spend",
  map: "Map",
};

function EmptyState({ section }: { section: Section }) {
  const descriptions: Record<Section, string> = {
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
          {(["dashboard", "subscriptions", "docker", "spend", "map"] as Section[]).map((id) => (
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

        {/* Version */}
        <div className="px-5 py-3 border-t border-zinc-100">
          <span className="text-[10px] text-zinc-300 tracking-wider">v0.1.0</span>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-zinc-50/50">
        <div className="flex-1 overflow-auto">
          {active === "subscriptions" ? <SubscriptionsView /> : <EmptyState section={active} />}
        </div>
      </main>
    </div>
  );
}
