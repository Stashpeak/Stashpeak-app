import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { SubscriptionGraphNode } from "./types";

const HIDDEN_HANDLE_STYLE = {
  width: 10,
  height: 10,
  opacity: 0,
  background: "transparent",
  border: "none",
} as const;

export function SubscriptionNode({ data }: NodeProps<SubscriptionGraphNode>) {
  const stopInteractionPropagation = (event: MouseEvent | PointerEvent) => {
    event.stopPropagation();
  };

  const surfaceStyle = {
    ["--glass-surface-fill" as "--glass-surface-fill"]: data.tone.surfaceFill,
    boxShadow: "var(--map-node-shadow)",
  } as CSSProperties;

  const badgeStyle = {
    backgroundColor: data.tone.badgeFill,
    borderColor: data.tone.badgeBorder,
    color: data.tone.badgeText,
  } as CSSProperties;

  const metricStyle = {
    backgroundColor: data.tone.metricFill,
    borderColor: data.tone.metricBorder,
  } as CSSProperties;

  const actionStyle = {
    backgroundColor: data.tone.metricFill,
    borderColor: data.tone.metricBorder,
    color: data.tone.badgeText,
  } as CSSProperties;

  return (
    <div className="relative">
      <Handle type="source" position={Position.Top} style={HIDDEN_HANDLE_STYLE} />
      <div
        className="glass-surface rounded-[24px] border border-[var(--glass-border)] px-4 py-4"
        style={surfaceStyle}
      >
        <div className="map-node-drag-handle flex cursor-grab items-start justify-between gap-3 active:cursor-grabbing">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">{data.caption}</p>
            <h3 className="mt-1 truncate text-base font-medium text-[var(--text-primary)]">{data.title}</h3>
          </div>
          <span
            className="shrink-0 rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.18em]"
            style={badgeStyle}
          >
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
                className="nodrag nopan pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border transition-colors"
                onPointerDown={stopInteractionPropagation}
                onMouseDown={stopInteractionPropagation}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  data.onResetPosition?.();
                }}
                style={actionStyle}
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
                className="nodrag nopan pointer-events-auto rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.16em] transition-colors"
                onPointerDown={stopInteractionPropagation}
                onMouseDown={stopInteractionPropagation}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  data.onToggleLink?.();
                }}
                style={actionStyle}
                aria-label={`${data.linkActionLabel} ${data.title}`}
              >
                {data.linkActionLabel}
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 space-y-2.5">
          <div className="rounded-[18px] border px-3 py-2.5" style={metricStyle}>
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Monthly equivalent</p>
            <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{data.billingLabel}</p>
          </div>
          <div className="rounded-[18px] border px-3 py-2.5" style={metricStyle}>
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Next billing</p>
            <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{data.nextBillingLabel}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
