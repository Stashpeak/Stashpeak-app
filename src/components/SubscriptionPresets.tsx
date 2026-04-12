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
  { id: "google-ai-pro", name: "Google AI Pro", provider: "Google One", currency: "USD", category: "assistant" },
  { id: "cursor", name: "Cursor", provider: "Cursor", currency: "USD", category: "coding" },
  { id: "github-copilot", name: "GitHub Copilot", provider: "GitHub", currency: "USD", category: "coding" },
  { id: "midjourney", name: "Midjourney", provider: "Midjourney", currency: "USD", category: "image" },
  { id: "perplexity-pro", name: "Perplexity Pro", provider: "Perplexity", currency: "USD", category: "research" },
  { id: "elevenlabs", name: "ElevenLabs", provider: "ElevenLabs", currency: "USD", category: "audio" },
  { id: "runway", name: "Runway", provider: "Runway", currency: "USD", category: "video" },
];

interface SubscriptionPresetsProps {
  onPresetSelect: (preset: Preset) => void;
}

export function SubscriptionPresets({ onPresetSelect }: SubscriptionPresetsProps) {
  // Group presets by category preserving insertion order
  const groups = PRESETS.reduce<Map<string, Preset[]>>((acc, preset) => {
    const list = acc.get(preset.category) ?? [];
    list.push(preset);
    acc.set(preset.category, list);
    return acc;
  }, new Map());

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const { value } = event.target;
    event.target.value = "";
    const preset = PRESETS.find((p) => p.id === value);
    if (preset) onPresetSelect(preset);
  }

  return (
    <div className="rounded-3xl border border-zinc-100 bg-white p-6 shadow-sm">
      <h3 className="text-base text-primary" style={{ fontWeight: 400 }}>
        Quick-fill from preset
      </h3>
      <p className="mt-1 text-sm text-secondary">
        Pick a service to pre-fill the form. Review and add your actual billing amount before saving.
      </p>

      <select
        defaultValue=""
        onChange={handleChange}
        className="mt-4 w-full cursor-pointer appearance-none rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10"
      >
        <option value="" disabled>
          Select a preset…
        </option>
        {Array.from(groups.entries()).map(([category, presets]) => (
          <optgroup
            key={category}
            label={category.charAt(0).toUpperCase() + category.slice(1)}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name} — {preset.provider}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
