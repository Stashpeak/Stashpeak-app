import type { ProviderDefinition, ProviderId, ProviderStatus } from "../lib/spendProviders";
import { PILL_SURFACE, SUBTLE_PANEL_SURFACE, TEXT_INPUT_SURFACE } from "../lib/surfaceStyles";
import { SelectableErrorMessage } from "./SelectableErrorMessage";

interface ProviderCardProps {
  provider: ProviderDefinition;
  status: ProviderStatus;
  isAdding: boolean;
  isConfirmingRevoke: boolean;
  keyInput: string;
  gcpProject: string;
  gcpDataset: string;
  gcpTable: string;
  addError: string | null;
  savingKey: boolean;
  onKeyInputChange: (value: string) => void;
  onGcpProjectChange: (value: string) => void;
  onGcpDatasetChange: (value: string) => void;
  onGcpTableChange: (value: string) => void;
  onSaveKey: (id: ProviderId) => void;
  onCancelAddKey: () => void;
  onRefresh: (id: ProviderId) => void;
  onRevokeKey: (id: ProviderId) => void;
  onToggleConfirmRevoke: (id: ProviderId) => void;
  onStartAddKey: (id: ProviderId) => void;
  formatRefreshedAt: (date: Date) => string;
}

export function ProviderCard({
  provider,
  status,
  isAdding,
  isConfirmingRevoke,
  keyInput,
  gcpProject,
  gcpDataset,
  gcpTable,
  addError,
  savingKey,
  onKeyInputChange,
  onGcpProjectChange,
  onGcpDatasetChange,
  onGcpTableChange,
  onSaveKey,
  onCancelAddKey,
  onRefresh,
  onRevokeKey,
  onToggleConfirmRevoke,
  onStartAddKey,
  formatRefreshedAt,
}: ProviderCardProps) {
  const { id, name, note, comingSoon } = provider;
  const staleMessage =
    status.tag === "stale"
      ? status.error.replace(/^Error:\s*/i, "").replace(/^Failed to fetch spend for \w+:\s*/i, "")
      : "";

  return (
    <div className={SUBTLE_PANEL_SURFACE}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-ink">{name}</p>
            {comingSoon && (
              <span className="text-[10px] text-secondary/60 uppercase tracking-[0.18em] border border-zinc-200 rounded-full px-2 py-0.5">
                Billing API coming soon
              </span>
            )}
          </div>

          {!comingSoon && status.tag === "unconfigured" && !isAdding && (
            <p className="text-xs text-secondary mt-0.5">No API key configured</p>
          )}
          {!comingSoon && status.tag === "loading" && (
            <p className="text-xs text-secondary mt-0.5 animate-pulse">Fetching...</p>
          )}
          {id === "gcp" && <p className="text-[10px] text-amber-600 mt-1">Data delayed up to 48h</p>}
          {!comingSoon && status.tag === "ok" && (
            <div className="mt-3 flex flex-wrap gap-2.5">
              <div className={PILL_SURFACE}>
                <p className="text-[10px] text-secondary/60 uppercase tracking-[0.2em]">This month</p>
                <p className="text-base text-primary font-light">${status.data.currentMonthUsd.toFixed(2)}</p>
              </div>
              <div className={PILL_SURFACE}>
                <p className="text-[10px] text-secondary/60 uppercase tracking-[0.2em]">Last month</p>
                <p className="text-base text-primary font-light">
                  {status.data.previousMonthUsd > 0 ? `$${status.data.previousMonthUsd.toFixed(2)}` : "-"}
                </p>
              </div>
            </div>
          )}
          {!comingSoon && status.tag === "stale" && (
            <SelectableErrorMessage kind="inline" className="mt-1 max-w-sm text-xs leading-relaxed">
              {staleMessage}
            </SelectableErrorMessage>
          )}

          {!comingSoon && isAdding && (
            <div className="mt-3 space-y-2">
              {note && <p className="text-xs text-secondary/70">{note}</p>}
              {id === "gcp" ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={gcpProject}
                    onChange={(e) => onGcpProjectChange(e.target.value)}
                    placeholder="Project ID (e.g. my-project-123)"
                    className={TEXT_INPUT_SURFACE}
                  />
                  <input
                    type="text"
                    value={gcpDataset}
                    onChange={(e) => onGcpDatasetChange(e.target.value)}
                    placeholder="BigQuery Dataset ID (e.g. bq_billing_export)"
                    className={TEXT_INPUT_SURFACE}
                  />
                  <input
                    type="text"
                    value={gcpTable}
                    onChange={(e) => onGcpTableChange(e.target.value)}
                    placeholder="Table Name (e.g. gcp_billing_export_v1_...)"
                    className={TEXT_INPUT_SURFACE}
                  />
                  <textarea
                    value={keyInput}
                    onChange={(e) => onKeyInputChange(e.target.value)}
                    placeholder="Paste Service Account JSON Key..."
                    autoFocus
                    rows={3}
                    className={`${TEXT_INPUT_SURFACE} resize-y`}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => onSaveKey(id)}
                      disabled={savingKey || !keyInput.trim() || !gcpProject.trim() || !gcpDataset.trim() || !gcpTable.trim()}
                      className="px-4 py-1.5 rounded-full bg-primary text-white text-sm disabled:opacity-40 cursor-pointer hover:bg-primary/90 transition-colors"
                    >
                      {savingKey ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={onCancelAddKey}
                      className="px-3 py-1.5 rounded-full text-sm text-secondary hover:bg-zinc-50 cursor-pointer transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => onKeyInputChange(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && onSaveKey(id)}
                    placeholder="Paste API key..."
                    autoFocus
                    className={`flex-1 ${TEXT_INPUT_SURFACE}`}
                  />
                  <button
                    onClick={() => onSaveKey(id)}
                    disabled={savingKey || !keyInput.trim()}
                    className="px-4 py-1.5 rounded-full bg-primary text-white text-sm disabled:opacity-40 cursor-pointer hover:bg-primary/90 transition-colors"
                  >
                    {savingKey ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={onCancelAddKey}
                    className="px-3 py-1.5 rounded-full text-sm text-secondary hover:bg-zinc-50 cursor-pointer transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {addError && (
                <SelectableErrorMessage kind="inline" className="text-xs">
                  {addError}
                </SelectableErrorMessage>
              )}
            </div>
          )}
        </div>

        {!comingSoon && (
          <div className="shrink-0 flex flex-col items-end gap-1 pt-0.5">
            {status.tag === "ok" && (
              <>
                <p className="text-[10px] text-secondary/50">
                  {status.backgroundRefreshing ? (
                    <span className="animate-pulse">Refreshing...</span>
                  ) : (
                    formatRefreshedAt(status.refreshedAt)
                  )}
                </p>
                <button
                  onClick={() => onRefresh(id)}
                  disabled={status.backgroundRefreshing}
                  className="text-xs text-primary hover:text-primary/70 cursor-pointer transition-colors disabled:opacity-40"
                >
                  Refresh
                </button>
                {isConfirmingRevoke ? (
                  <div className="flex gap-1 items-center">
                    <button
                      onClick={() => onRevokeKey(id)}
                      className="text-xs text-rose-500 hover:text-rose-400 cursor-pointer transition-colors"
                    >
                      Revoke
                    </button>
                    <span className="text-[10px] text-secondary/40">/</span>
                    <button
                      onClick={() => onToggleConfirmRevoke(id)}
                      className="text-xs text-secondary hover:text-secondary/70 cursor-pointer transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onToggleConfirmRevoke(id)}
                    className="text-xs text-secondary/50 hover:text-rose-400 cursor-pointer transition-colors"
                  >
                    Revoke key
                  </button>
                )}
              </>
            )}
            {status.tag === "stale" && (
              <>
                <button
                  onClick={() => onRefresh(id)}
                  className="text-xs text-rose-400 hover:text-rose-300 cursor-pointer transition-colors"
                >
                  Retry
                </button>
                {isConfirmingRevoke ? (
                  <div className="flex gap-1 items-center">
                    <button
                      onClick={() => onRevokeKey(id)}
                      className="text-xs text-rose-500 hover:text-rose-400 cursor-pointer transition-colors"
                    >
                      Revoke
                    </button>
                    <span className="text-[10px] text-secondary/40">/</span>
                    <button
                      onClick={() => onToggleConfirmRevoke(id)}
                      className="text-xs text-secondary hover:text-secondary/70 cursor-pointer transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onToggleConfirmRevoke(id)}
                    className="text-xs text-secondary/50 hover:text-rose-400 cursor-pointer transition-colors"
                  >
                    Revoke key
                  </button>
                )}
              </>
            )}
            {(status.tag === "unconfigured" || status.tag === "stale") && !isAdding && (
              <button
                onClick={() => onStartAddKey(id)}
                className="text-xs text-primary hover:text-primary/70 cursor-pointer transition-colors"
              >
                {status.tag === "unconfigured" ? "Add key" : "Update key"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
