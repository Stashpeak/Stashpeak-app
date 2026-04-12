import { useState, useEffect, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  getNotificationSettings,
  setNotificationDays,
  setNotificationsEnabled,
  getHomeCurrency,
  setHomeCurrency,
  getExchangeRates,
  upsertExchangeRate,
  type ExchangeRate,
} from "../lib/settings";
import { getProviderEnabled, setProviderEnabled } from "../lib/connectors";
import { checkForUpdate, downloadAndInstall, type Update } from "../lib/updater";
import { CURRENCY_OPTIONS } from "../lib/currencies";
import { SelectableErrorMessage } from "./SelectableErrorMessage";

const NOTIFICATION_PRESETS = [0, 1, 3, 7];
const PRESET_LABELS: Record<number, string> = {
  0: "Same day",
  1: "1 day",
  3: "3 days",
  7: "7 days",
};

const SPEND_PROVIDERS = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "groq", name: "Groq" },
  { id: "gcp", name: "Google Cloud" },
];

interface RateRowProps {
  fromCurrency: string;
  homeCurrency: string;
  initialRate: number | null;
  onSaved: () => void;
}

function RateRow({ fromCurrency, homeCurrency, initialRate, onSaved }: RateRowProps) {
  const [input, setInput] = useState(initialRate !== null ? String(initialRate) : "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    const parsed = parseFloat(input);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Enter a positive number");
      return;
    }
    setError(null);
    try {
      await upsertExchangeRate(fromCurrency, homeCurrency, parsed);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-[#625b71] w-24 shrink-0">
        1 <span className="font-medium text-[#1c1b1f]">{fromCurrency}</span> =
      </span>
      <input
        type="number"
        min={0}
        step="any"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === "Enter" && void commit()}
        placeholder="e.g. 25.5"
        className="w-28 px-3 py-1.5 rounded-xl border border-zinc-200 text-sm text-[#1c1b1f] outline-none focus:border-[#6750a4] transition-colors"
        style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
      />
      <span className="text-sm text-[#625b71]">{homeCurrency}</span>
      {saved && (
        <span className="text-xs text-[#6750a4] transition-opacity">Saved</span>
      )}
      {error && (
        <SelectableErrorMessage kind="inline">{error}</SelectableErrorMessage>
      )}
    </div>
  );
}

interface SettingsViewProps {
  updateAvailable: boolean;
  onUpdateConsumed: () => void;
}

export function SettingsView({ updateAvailable, onUpdateConsumed }: SettingsViewProps) {
  // Notification settings
  const [days, setDays] = useState<number | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [customInput, setCustomInput] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Provider settings
  const [providerStates, setProviderStates] = useState<Record<string, boolean>>({});

  // Currency settings
  const [homeCurrency, setHomeCurrencyState] = useState<string | null>(null);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  // Currencies that appear in subscriptions — loaded from parent via localStorage trick
  // We read them in SettingsView via the Tauri backend list_subscriptions query
  const [subCurrencies, setSubCurrencies] = useState<string[]>([]);
  const [currencySaved, setCurrencySaved] = useState(false);

  // About / updater state
  const [appVersion, setAppVersion] = useState<string>("");
  type CheckState = "idle" | "checking" | "upToDate" | "available" | "downloading" | "done" | "error";
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body: string | null } | null>(null);
  const updateRef = useRef<Update | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.1.0"));
  }, []);

  useEffect(() => {
    if (updateAvailable) {
      setCheckState("available");
    }
  }, [updateAvailable]);

  useEffect(() => {
    getNotificationSettings()
      .then(({ daysBefore, enabled }) => {
        setEnabled(enabled);
        if (NOTIFICATION_PRESETS.includes(daysBefore)) {
          setDays(daysBefore);
          setIsCustom(false);
        } else {
          setDays(daysBefore);
          setCustomInput(String(daysBefore));
          setIsCustom(true);
        }
      })
      .catch((e) => setLoadError(String(e)));

    getHomeCurrency()
      .then(setHomeCurrencyState)
      .catch((e) => setLoadError(String(e)));

    Promise.all(SPEND_PROVIDERS.map(p => getProviderEnabled(p.id).then(enabled => ({ id: p.id, enabled }))))
      .then(results => {
        const state: Record<string, boolean> = {};
        for (const res of results) state[res.id] = res.enabled;
        setProviderStates(state);
      })
      .catch(e => setLoadError(String(e)));

    loadExchangeRates();

    // Read subscription currencies stored in sessionStorage by SubscriptionsView
    const stored = sessionStorage.getItem("sub_currencies");
    if (stored) {
      try { setSubCurrencies(JSON.parse(stored) as string[]); } catch { /* ignore */ }
    }
  }, []);

  function loadExchangeRates() {
    getExchangeRates()
      .then(setExchangeRates)
      .catch((e) => setLoadError(String(e)));
  }

  async function saveDays(newDays: number) {
    await setNotificationDays(newDays);
    setDays(newDays);
    flashNotifSaved();
  }

  async function saveEnabled(val: boolean) {
    await setNotificationsEnabled(val);
    setEnabled(val);
    flashNotifSaved();
  }

  function flashNotifSaved() {
    setNotifSaved(true);
    setTimeout(() => setNotifSaved(false), 2000);
  }

  function handlePreset(d: number) {
    setIsCustom(false);
    setCustomInput("");
    void saveDays(d);
  }

  function handleCustomCommit() {
    const parsed = parseInt(customInput, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 365) {
      void saveDays(parsed);
    }
  }

  async function handleHomeCurrencyChange(currency: string) {
    setHomeCurrencyState(currency);
    try {
      await setHomeCurrency(currency);
      setCurrencySaved(true);
      setTimeout(() => setCurrencySaved(false), 2000);
    } catch (e) {
      setLoadError(String(e));
    }
  }

  async function handleProviderToggle(id: string, enabled: boolean) {
    try {
      await setProviderEnabled(id, enabled);
      setProviderStates(prev => ({ ...prev, [id]: enabled }));
    } catch (e) {
      setLoadError(String(e));
    }
  }

  async function handleCheckForUpdates() {
    setCheckState("checking");
    setUpdateError(null);
    try {
      const result = await checkForUpdate();
      if (result) {
        updateRef.current = result.update;
        setUpdateInfo({ version: result.info.version, body: result.info.body });
        setCheckState("available");
      } else {
        setCheckState("upToDate");
      }
    } catch (e) {
      setUpdateError(String(e));
      setCheckState("error");
    }
  }

  async function handleInstall() {
    if (!updateRef.current) return;
    setCheckState("downloading");
    setDownloadProgress(0);
    setDownloadTotal(null);
    try {
      await downloadAndInstall(updateRef.current, (dl, total) => {
        setDownloadProgress(dl);
        setDownloadTotal(total);
      });
      setCheckState("done");
      onUpdateConsumed();
    } catch (e) {
      setUpdateError(String(e));
      setCheckState("error");
    }
  }

  const loaded = days !== null && enabled !== null && homeCurrency !== null;

  // Currencies that need a rate: subscription currencies that differ from home currency
  const ratesNeeded = subCurrencies.filter((c) => c !== homeCurrency);

  // Map existing rates for quick lookup
  const rateMap = new Map<string, number>(
    exchangeRates
      .filter((r) => r.toCurrency === homeCurrency)
      .map((r) => [r.fromCurrency, r.rate])
  );

  return (
    <div className="p-8 max-w-lg" style={{ fontFamily: "'Kumbh Sans', sans-serif" }}>
      <h1
        className="text-xl text-[#6750a4] mb-1"
        style={{ fontWeight: 300 }}
      >
        Settings
      </h1>
      <p className="text-sm text-[#625b71] mb-8">App preferences</p>

      {loadError && (
        <SelectableErrorMessage kind="inline" className="mb-4">
          {loadError}
        </SelectableErrorMessage>
      )}

      {loaded && (
        <div className="space-y-10">
          {/* ── Home currency ─────────────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2
                className="text-sm font-medium text-[#1c1b1f]"
                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
              >
                Home currency
              </h2>
              <p className="text-xs text-[#625b71] mt-0.5">
                Subscription totals are converted into this currency in the header.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <select
                id="home-currency-select"
                value={homeCurrency}
                onChange={(e) => void handleHomeCurrencyChange(e.target.value)}
                className="px-3 py-2 rounded-xl border border-zinc-200 text-sm text-[#1c1b1f] outline-none focus:border-[#6750a4] transition-colors cursor-pointer bg-white"
                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
              >
                {CURRENCY_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {currencySaved && (
                <span className="text-xs text-[#6750a4]">Saved</span>
              )}
            </div>

            {/* Exchange rates — only shown if there are subscription currencies that differ */}
            {ratesNeeded.length > 0 && (
              <div className="space-y-3 pt-1">
                <p className="text-xs text-[#625b71] leading-relaxed">
                  Enter exchange rates for your subscription currencies. Used to calculate the aggregate total.
                </p>
                {ratesNeeded.map((from) => (
                  <RateRow
                    key={from}
                    fromCurrency={from}
                    homeCurrency={homeCurrency}
                    initialRate={rateMap.get(from) ?? null}
                    onSaved={loadExchangeRates}
                  />
                ))}
              </div>
            )}

            {ratesNeeded.length === 0 && subCurrencies.length > 0 && (
              <p className="text-xs text-[#625b71]/60">
                All your subscriptions are already in {homeCurrency} — no conversion needed.
              </p>
            )}
          </section>

          <div className="border-t border-zinc-100" />

          {/* ── Billing renewal reminders ──────────────────────────── */}
          <section className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2
                  className="text-sm font-medium text-[#1c1b1f]"
                  style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                >
                  Billing renewal reminders
                </h2>
                <p className="text-xs text-[#625b71] mt-0.5">
                  Notify when a subscription is about to renew
                </p>
              </div>
              <button
                role="switch"
                aria-checked={enabled}
                onClick={() => void saveEnabled(!enabled)}
                className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0 ${
                  enabled ? "bg-[#6750a4]" : "bg-zinc-200"
                }`}
              >
                <span
                  className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${
                    enabled ? "left-5" : "left-1"
                  }`}
                />
              </button>
            </div>

            {enabled && (
              <div>
                <p className="text-xs text-[#625b71] mb-3 leading-relaxed">
                  How many days before renewal to notify. Fires once per billing
                  cycle when you open Stashpeak.
                </p>

                <div className="flex gap-2 flex-wrap">
                  {NOTIFICATION_PRESETS.map((p) => (
                    <button
                      key={p}
                      onClick={() => handlePreset(p)}
                      className={`px-4 py-1.5 rounded-full text-sm transition-all cursor-pointer ${
                        !isCustom && days === p
                          ? "bg-[#6750a4] text-white"
                          : "bg-[#6750a4]/8 text-[#6750a4] hover:bg-[#6750a4]/15"
                      }`}
                      style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                    >
                      {PRESET_LABELS[p]}
                    </button>
                  ))}

                  <button
                    onClick={() => {
                      setIsCustom(true);
                      setCustomInput(days !== null && NOTIFICATION_PRESETS.includes(days) ? "" : String(days));
                    }}
                    className={`px-4 py-1.5 rounded-full text-sm transition-all cursor-pointer ${
                      isCustom
                        ? "bg-[#6750a4] text-white"
                        : "bg-[#6750a4]/8 text-[#6750a4] hover:bg-[#6750a4]/15"
                    }`}
                    style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                  >
                    Custom
                  </button>
                </div>

                {isCustom && (
                  <div className="flex items-center gap-2 mt-3">
                    <input
                      type="number"
                      min={0}
                      max={365}
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      onBlur={handleCustomCommit}
                      onKeyDown={(e) => e.key === "Enter" && handleCustomCommit()}
                      placeholder="e.g. 14"
                      className="w-24 px-3 py-1.5 rounded-xl border border-zinc-200 text-sm text-[#1c1b1f] outline-none focus:border-[#6750a4] transition-colors"
                      style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                      autoFocus
                    />
                    <span className="text-sm text-[#625b71]">days before renewal</span>
                  </div>
                )}
              </div>
            )}

            <p
              className={`text-xs text-[#6750a4] transition-opacity ${notifSaved ? "opacity-100" : "opacity-0"}`}
              style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
            >
              Saved
            </p>
          </section>

          <div className="border-t border-zinc-100" />

          {/* ── API Connectors ─────────────────────────────────────── */}
          <section className="space-y-6">
            <div>
              <h2
                className="text-sm font-medium text-[#1c1b1f]"
                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
              >
                API Connectors
              </h2>
              <p className="text-xs text-[#625b71] mt-0.5">
                Enable or disable specific connectors from fetching data
              </p>
            </div>

            <div className="space-y-4">
              {SPEND_PROVIDERS.map(p => (
                <div key={p.id} className="flex items-center justify-between">
                  <span className="text-sm text-[#1c1b1f]">{p.name}</span>
                  <button
                    role="switch"
                    aria-checked={providerStates[p.id] ?? true}
                    onClick={() => void handleProviderToggle(p.id, !(providerStates[p.id] ?? true))}
                    className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0 ${
                      (providerStates[p.id] ?? true) ? "bg-[#6750a4]" : "bg-zinc-200"
                    }`}
                  >
                    <span
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${
                        (providerStates[p.id] ?? true) ? "left-5" : "left-1"
                      }`}
                    />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <div className="border-t border-zinc-100" />

          {/* ── About ──────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-medium text-[#1c1b1f]">About</h2>
              <p className="text-xs text-[#625b71] mt-0.5">
                Stashpeak{appVersion ? ` v${appVersion}` : ""}
              </p>
            </div>

            {checkState === "idle" && (
              <button
                onClick={() => void handleCheckForUpdates()}
                className="px-4 py-1.5 rounded-full text-sm bg-[#6750a4]/8 text-[#6750a4] hover:bg-[#6750a4]/15 transition-all cursor-pointer"
                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
              >
                {updateAvailable ? "Update available — view" : "Check for updates"}
              </button>
            )}

            {checkState === "checking" && (
              <p className="text-xs text-[#625b71]">Checking…</p>
            )}

            {checkState === "upToDate" && (
              <p className="text-xs text-[#6750a4]">You're up to date.</p>
            )}

            {checkState === "available" && (
              <div className="space-y-2">
                {updateInfo && (
                  <p className="text-xs text-[#625b71]">
                    v{updateInfo.version} is available.
                    {updateInfo.body && (
                      <span className="block mt-1 text-[#1c1b1f]/70 whitespace-pre-wrap">{updateInfo.body}</span>
                    )}
                  </p>
                )}
                <button
                  onClick={() => void handleInstall()}
                  className="px-4 py-1.5 rounded-full text-sm bg-[#6750a4] text-white hover:bg-[#6750a4]/90 transition-all cursor-pointer"
                  style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                >
                  Download and install
                </button>
              </div>
            )}

            {checkState === "downloading" && (
              <div className="space-y-1.5">
                <p className="text-xs text-[#625b71]">Downloading…</p>
                {downloadTotal !== null && (
                  <div className="w-full h-1 rounded-full bg-zinc-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#6750a4] transition-all"
                      style={{ width: `${Math.round((downloadProgress / downloadTotal) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {checkState === "done" && (
              <p className="text-xs text-[#6750a4]">
                Update installed. The app will restart shortly.
              </p>
            )}

            {checkState === "error" && (
              <div className="space-y-2">
                <SelectableErrorMessage kind="inline">{updateError}</SelectableErrorMessage>
                <button
                  onClick={() => void handleCheckForUpdates()}
                  className="text-xs text-[#6750a4] underline cursor-pointer"
                  style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                >
                  Try again
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
