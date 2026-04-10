import { useState, useEffect } from "react";
import {
  getNotificationSettings,
  setNotificationDays,
  setNotificationsEnabled,
} from "../lib/settings";

const PRESETS = [0, 1, 3, 7];
const PRESET_LABELS: Record<number, string> = {
  0: "Same day",
  1: "1 day",
  3: "3 days",
  7: "7 days",
};

export function SettingsView() {
  // null = not yet loaded (prevents flash of default value)
  const [days, setDays] = useState<number | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [customInput, setCustomInput] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getNotificationSettings()
      .then(({ daysBefore, enabled }) => {
        setEnabled(enabled);
        if (PRESETS.includes(daysBefore)) {
          setDays(daysBefore);
          setIsCustom(false);
        } else {
          setDays(daysBefore);
          setCustomInput(String(daysBefore));
          setIsCustom(true);
        }
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  async function saveDays(newDays: number) {
    await setNotificationDays(newDays);
    setDays(newDays);
    flashSaved();
  }

  async function saveEnabled(val: boolean) {
    await setNotificationsEnabled(val);
    setEnabled(val);
    flashSaved();
  }

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handlePreset(d: number) {
    setIsCustom(false);
    setCustomInput("");
    saveDays(d);
  }

  function handleCustomCommit() {
    const parsed = parseInt(customInput, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 365) {
      saveDays(parsed);
    }
  }

  const loaded = days !== null && enabled !== null;

  return (
    <div className="p-8 max-w-lg">
      <h1
        className="text-xl text-[#6750a4] mb-1"
        style={{ fontFamily: "'Kumbh Sans', sans-serif", fontWeight: 300 }}
      >
        Settings
      </h1>
      <p className="text-sm text-[#625b71] mb-8">App preferences</p>

      {loadError && (
        <p className="text-sm text-red-500 mb-4">{loadError}</p>
      )}

      {loaded && (
        <section className="space-y-6">
          {/* On/off toggle */}
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
              onClick={() => saveEnabled(!enabled)}
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

          {/* Day presets — only shown when notifications are on */}
          {enabled && (
            <div>
              <p className="text-xs text-[#625b71] mb-3 leading-relaxed">
                How many days before renewal to notify. Fires once per billing
                cycle when you open Stashpeak.
              </p>

              <div className="flex gap-2 flex-wrap">
                {PRESETS.map((p) => (
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
                    setCustomInput(days !== null && PRESETS.includes(days) ? "" : String(days));
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

          {/* Saved feedback */}
          <p
            className={`text-xs text-[#6750a4] transition-opacity ${saved ? "opacity-100" : "opacity-0"}`}
            style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
          >
            Saved
          </p>
        </section>
      )}
    </div>
  );
}
