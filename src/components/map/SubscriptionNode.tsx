import type { MouseEvent, PointerEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { SubscriptionGraphNode } from "./types";

export function SubscriptionNode({ data }: NodeProps<SubscriptionGraphNode>) {
  const stopInteractionPropagation = (event: MouseEvent | PointerEvent) => {
    event.stopPropagation();
  };

  return (
    <div className={`relative map-node-tone ${data.tone.className}`}>
      <Handle type="source" position={Position.Top} className="map-node-handle-hidden" />
      <div
        className="glass-surface map-node-surface rounded-[24px] border border-[var(--glass-border)] px-4 py-4"
      >
        <div className="map-node-drag-handle flex cursor-grab items-start justify-between gap-3 active:cursor-grabbing">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">{data.caption}</p>
            <h3 className="mt-1 truncate text-base font-medium text-[var(--text-primary)]">{data.title}</h3>
          </div>
          <span className="map-node-badge shrink-0 rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.18em]">
            {data.statusLabel}
          </span>
        </div>

        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm text-[var(--text-secondary)]">{data.providerLabel}</p>
            {data.linkLabel ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">{data.linkLabel}</p>
            ) : null}
          </div>

          <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
            {data.onResetPosition ? (
              <button
                type="button"
                className="map-node-action nodrag nopan pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border transition-colors"
                onPointerDown={stopInteractionPropagation}
                onMouseDown={stopInteractionPropagation}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  data.onResetPosition?.();
                }}
                aria-label={`Reset position for ${data.title}`}
                title="Reset position"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3.5 5.5V2.75H6.25" />
                  <path d="M3.85 5.15A5 5 0 1 1 4.6 11.8" />
                </svg>
              </button>
            ) : null}

            {data.linkActionLabel && data.onToggleLink ? (
              <button
                type="button"
                className="map-node-action nodrag nopan pointer-events-auto rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.16em] transition-colors"
                onPointerDown={stopInteractionPropagation}
                onMouseDown={stopInteractionPropagation}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  data.onToggleLink?.();
                }}
                aria-label={`${data.linkActionLabel} ${data.title}`}
              >
                {data.linkActionLabel}
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 space-y-2.5">
          <div className="map-node-panel rounded-[18px] border px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Monthly equivalent</p>
            <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{data.billingLabel}</p>
          </div>
          <div className="map-node-panel rounded-[18px] border px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Next billing</p>
            <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{data.nextBillingLabel}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
