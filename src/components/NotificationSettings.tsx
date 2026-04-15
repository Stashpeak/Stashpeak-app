export const NOTIFICATION_PRESETS = [0, 1, 3, 7];
export const PRESET_LABELS: Record<number, string> = {
  0: "Same day",
  1: "1 day",
  3: "3 days",
  7: "7 days",
};

interface NotificationSettingsProps {
  enabled: boolean;
  days: number;
  isCustom: boolean;
  customInput: string;
  notifSaved: boolean;
  onToggleEnabled: () => void;
  onPreset: (days: number) => void;
  onSelectCustom: () => void;
  onCustomInputChange: (value: string) => void;
  onCustomCommit: () => void;
}

export function NotificationSettings({
  enabled,
  days,
  isCustom,
  customInput,
  notifSaved,
  onToggleEnabled,
  onPreset,
  onSelectCustom,
  onCustomInputChange,
  onCustomCommit,
}: NotificationSettingsProps) {
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-ink">Billing renewal reminders</h2>
          <p className="text-xs text-secondary mt-0.5">Notify when a subscription is about to renew</p>
        </div>
        <button
          role="switch"
          aria-checked={enabled ? "true" : "false"}
          aria-label="Toggle billing renewal reminders"
          onClick={onToggleEnabled}
          className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0 ${
            enabled ? "bg-primary" : "bg-zinc-200"
          }`}
        >
          <span
            className={`absolute top-1 w-4 h-4 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-all ${
              enabled ? "left-5" : "left-1"
            }`}
          />
        </button>
      </div>

      {enabled && (
        <div>
          <p className="text-xs text-secondary mb-3 leading-relaxed">
            How many days before renewal to notify. Fires once per billing cycle when you open Stashpeak.
          </p>

          <div className="flex gap-2 flex-wrap">
            {NOTIFICATION_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => onPreset(preset)}
                className={`px-4 py-1.5 rounded-full text-sm transition-all cursor-pointer ${
                  !isCustom && days === preset
                    ? "bg-primary text-white"
                    : "bg-primary/8 text-primary hover:bg-primary/15"
                }`}
              >
                {PRESET_LABELS[preset]}
              </button>
            ))}

            <button
              onClick={onSelectCustom}
              className={`px-4 py-1.5 rounded-full text-sm transition-all cursor-pointer ${
                isCustom ? "bg-primary text-white" : "bg-primary/8 text-primary hover:bg-primary/15"
              }`}
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
                onChange={(e) => onCustomInputChange(e.target.value)}
                onBlur={onCustomCommit}
                onKeyDown={(e) => e.key === "Enter" && onCustomCommit()}
                placeholder="e.g. 14"
                className="w-24 rounded-[14px] border border-(--glass-border) bg-(--glass-bg) px-3 py-1.5 text-sm text-(--text-primary) outline-none transition placeholder:text-(--text-subtle) focus:border-(--purple-primary) focus:ring-2 focus:ring-(--focus-ring)"
                autoFocus
              />
              <span className="text-sm text-secondary">days before renewal</span>
            </div>
          )}
        </div>
      )}

      <p className={`text-xs text-primary transition-opacity ${notifSaved ? "opacity-100" : "opacity-0"}`}>
        Saved
      </p>
    </section>
  );
}
