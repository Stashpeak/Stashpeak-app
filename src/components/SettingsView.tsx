import { useEffect, useState } from "react";
import { getProviderEnabled, setProviderEnabled } from "../lib/connectors";
import type { ResolvedTheme, Theme } from "../hooks/useTheme";
import { SECONDARY_BUTTON_SURFACE } from "../lib/surfaceStyles";
import { ExchangeRatesSection } from "./ExchangeRatesSection";
import { McpAccessSectionContainer } from "./McpAccessSectionContainer";
import { NotificationSettingsSection } from "./NotificationSettingsSection";
import { SelectableErrorMessage } from "./SelectableErrorMessage";
import { UpdateSection } from "./UpdateSection";

const SPEND_PROVIDERS = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "groq", name: "Groq" },
  { id: "gcp", name: "Google Cloud" },
];

const THEME_OPTIONS: { value: Theme; label: string; description: string }[] = [
  {
    value: "system",
    label: "System",
    description: "Follow your OS preference and update automatically.",
  },
  { value: "light", label: "Light", description: "Use the pastel glass theme." },
  { value: "dark", label: "Dark", description: "Use the darker glass theme." },
];

interface SettingsViewProps {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  onThemeChange: (theme: Theme) => void;
  updateAvailable: boolean;
  onUpdateConsumed: () => void;
}

export function SettingsView({
  theme,
  resolvedTheme,
  onThemeChange,
  updateAvailable,
  onUpdateConsumed,
}: SettingsViewProps) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerStates, setProviderStates] = useState<Record<string, boolean>>({});
  const [subCurrencies, setSubCurrencies] = useState<string[]>([]);
  const [notificationReady, setNotificationReady] = useState(false);
  const [exchangeReady, setExchangeReady] = useState(false);
  const [mcpReady, setMcpReady] = useState(false);

  useEffect(() => {
    Promise.all(
      SPEND_PROVIDERS.map((provider) =>
        getProviderEnabled(provider.id).then((enabled) => ({ id: provider.id, enabled })),
      ),
    )
      .then((results) => {
        const state: Record<string, boolean> = {};
        for (const result of results) {
          state[result.id] = result.enabled;
        }
        setProviderStates(state);
      })
      .catch((error) => setLoadError(String(error)));

    const stored = sessionStorage.getItem("sub_currencies");
    if (!stored) {
      return;
    }

    try {
      setSubCurrencies(JSON.parse(stored) as string[]);
    } catch {
      // Ignore malformed session data from older renders.
    }
  }, []);

  async function handleProviderToggle(id: string, enabled: boolean) {
    try {
      await setProviderEnabled(id, enabled);
      setProviderStates((previous) => ({ ...previous, [id]: enabled }));
    } catch (error) {
      setLoadError(String(error));
    }
  }

  const contentReady = notificationReady && exchangeReady && mcpReady;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-100 px-8 py-6">
        <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--purple-label)]">
          Preferences
        </p>
        <h2 className="mt-1.5 text-3xl font-light tracking-tight text-[var(--text-primary)]">
          Settings
        </h2>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
          Configure your regional preferences, notification settings, and API connectors.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-auto px-8 py-6">
        <div className="w-full">
          {loadError && (
            <SelectableErrorMessage kind="inline" className="mb-4">
              {loadError}
            </SelectableErrorMessage>
          )}

          <div className={contentReady ? "space-y-10" : "invisible h-0 overflow-hidden"}>
            <section className="space-y-4">
              <div>
                <h2 className="text-sm font-medium text-ink">Appearance</h2>
                <p className="mt-0.5 text-xs text-secondary">
                  System is the default. Manual overrides are saved on this device.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {THEME_OPTIONS.map((option) => {
                  const isActive = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      onClick={() => onThemeChange(option.value)}
                      className={
                        isActive
                          ? "rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg-elevated)] px-4 py-2 text-sm text-[var(--text-primary)] backdrop-blur-[5px] transition-all"
                          : SECONDARY_BUTTON_SURFACE
                      }
                      title={option.description}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <p className="text-xs text-secondary/60">
                Currently rendering the {resolvedTheme} theme.
              </p>
            </section>

            <div className="border-t border-zinc-100" />

            <ExchangeRatesSection
              subCurrencies={subCurrencies}
              onError={setLoadError}
              onReadyChange={setExchangeReady}
            />

            <div className="border-t border-zinc-100" />

            <NotificationSettingsSection
              onError={setLoadError}
              onReadyChange={setNotificationReady}
            />

            <div className="border-t border-zinc-100" />

            <section className="space-y-6">
              <div>
                <h2 className="text-sm font-medium text-ink">API Connectors</h2>
                <p className="mt-0.5 text-xs text-secondary">
                  Enable or disable specific connectors from fetching data
                </p>
              </div>

              <div className="space-y-4">
                {SPEND_PROVIDERS.map((provider) => (
                  <div key={provider.id} className="flex items-center justify-between">
                    <span className="text-sm text-ink">{provider.name}</span>
                    <button
                      role="switch"
                      aria-checked={providerStates[provider.id] ?? true}
                      onClick={() =>
                        void handleProviderToggle(
                          provider.id,
                          !(providerStates[provider.id] ?? true),
                        )
                      }
                      className={`relative h-6 w-10 shrink-0 cursor-pointer rounded-full transition-colors ${
                        (providerStates[provider.id] ?? true) ? "bg-primary" : "bg-zinc-200"
                      }`}
                    >
                      <span
                        className={`absolute top-1 h-4 w-4 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-all ${
                          (providerStates[provider.id] ?? true) ? "left-5" : "left-1"
                        }`}
                      />
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <div className="border-t border-zinc-100" />

            <UpdateSection updateAvailable={updateAvailable} onUpdateConsumed={onUpdateConsumed} />

            <div className="border-t border-zinc-100" />

            <McpAccessSectionContainer onError={setLoadError} onReadyChange={setMcpReady} />
          </div>
        </div>
      </div>
    </div>
  );
}
