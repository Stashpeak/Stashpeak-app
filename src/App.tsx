import { useState } from "react";
import { SubscriptionsView } from "./components/SubscriptionsView";
import "./App.css";

type Section = "dashboard" | "subscriptions" | "docker" | "spend" | "map";

const NAV_ITEMS: { id: Section; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "⬛" },
  { id: "subscriptions", label: "Subscriptions", icon: "📋" },
  { id: "docker", label: "Docker", icon: "🐳" },
  { id: "spend", label: "Spend", icon: "💳" },
  { id: "map", label: "Map", icon: "🗺️" },
];

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
    <div className="flex flex-col items-center justify-center h-full text-center px-8 gap-3">
      <p className="text-4xl">{NAV_ITEMS.find((n) => n.id === section)?.icon}</p>
      <h2 className="text-lg font-semibold text-white">{SECTION_LABELS[section]}</h2>
      <p className="text-sm text-zinc-400 max-w-sm leading-relaxed">{descriptions[section]}</p>
      <span className="mt-2 text-xs text-zinc-600 uppercase tracking-widest">Coming soon</span>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState<Section>("dashboard");

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      {/* Sidebar */}
      <aside className="w-52 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-zinc-800">
          <span className="text-sm font-bold tracking-widest text-white uppercase">Stashpeak</span>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-1 p-3 flex-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActive(item.id)}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors text-left w-full cursor-pointer ${
                active === item.id
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Version */}
        <div className="px-5 py-3 border-t border-zinc-800">
          <span className="text-xs text-zinc-600">v0.1.0</span>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="h-12 flex items-center px-6 border-b border-zinc-800 shrink-0">
          <h1 className="text-sm font-medium text-zinc-300">{SECTION_LABELS[active]}</h1>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {active === "subscriptions" ? <SubscriptionsView /> : <EmptyState section={active} />}
        </div>
      </main>
    </div>
  );
}
