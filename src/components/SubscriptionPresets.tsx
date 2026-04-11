export type Preset = {
  id: string;
  name: string;
  provider: string;
  currency: string;
  category: string;
};

export const PRESETS: Preset[] = [
  { id: "chatgpt-plus", name: "ChatGPT Plus", provider: "OpenAI", currency: "USD", category: "assistant" },
  { id: "claude-pro", name: "Claude Pro", provider: "Anthropic", currency: "USD", category: "assistant" },
  { id: "cursor", name: "Cursor", provider: "Cursor", currency: "USD", category: "coding" },
  { id: "github-copilot", name: "GitHub Copilot", provider: "GitHub", currency: "USD", category: "coding" },
  { id: "midjourney", name: "Midjourney", provider: "Midjourney", currency: "USD", category: "image" },
  { id: "perplexity-pro", name: "Perplexity Pro", provider: "Perplexity", currency: "USD", category: "research" },
  { id: "elevenlabs", name: "ElevenLabs", provider: "ElevenLabs", currency: "USD", category: "audio" },
  { id: "runway", name: "Runway", provider: "Runway", currency: "USD", category: "video" },
];

interface SubscriptionPresetsProps {
  selectedPresets: string[];
  onSelectionChange: (ids: string[]) => void;
  onQuickAdd: () => void;
  isSaving: boolean;
}

export function SubscriptionPresets({
  selectedPresets,
  onSelectionChange,
  onQuickAdd,
  isSaving,
}: SubscriptionPresetsProps) {
  return (
    <div className="rounded-3xl border border-zinc-100 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base text-[#6750a4]" style={{ fontWeight: 400 }}>
            Quick-add presets
          </h3>
          <p className="mt-1 text-sm text-[#625b71]">
            Add common subscriptions with one click. Presets start at zero cost so you can fill in your real
            billing amount afterward.
          </p>
        </div>
        <button
          type="button"
          onClick={onQuickAdd}
          disabled={selectedPresets.length === 0 || isSaving}
          className="rounded-full border border-[#6750a4]/30 bg-[#6750a4]/8 px-4 py-2 text-sm text-[#6750a4] transition hover:bg-[#6750a4]/15 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ fontFamily: "'Roboto', sans-serif", fontWeight: 500 }}
        >
          Add selected
        </button>
      </div>

      <div className="mt-5 grid gap-2.5 md:grid-cols-2">
        {PRESETS.map((preset) => {
          const isChecked = selectedPresets.includes(preset.id);
          return (
            <label
              key={preset.id}
              className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                isChecked
                  ? "border-[#6750a4]/30 bg-[#6750a4]/5"
                  : "border-zinc-100 bg-zinc-50/50 hover:border-zinc-200"
              }`}
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={(event) => {
                  onSelectionChange(
                    event.target.checked
                      ? [...selectedPresets, preset.id]
                      : selectedPresets.filter((value) => value !== preset.id),
                  );
                }}
                className="h-4 w-4 rounded-full border-zinc-300 text-[#6750a4] accent-[#6750a4]"
              />
              <span className="min-w-0">
                <span className="block text-sm text-zinc-800">{preset.name}</span>
                <span className="mt-0.5 block text-[10px] uppercase tracking-[0.2em] text-[#625b71]/50">
                  {preset.provider}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
