import type { CSSProperties } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { MapNodeTone } from "./types";

export interface SubscriptionNodeData extends Record<string, unknown> {
  title: string;
  caption: string;
  providerLabel: string;
  billingLabel: string;
  nextBillingLabel: string;
  statusLabel: string;
  tone: MapNodeTone;
}

export type SubscriptionGraphNode = Node<SubscriptionNodeData, "subscription">;

export function SubscriptionNode({ data }: NodeProps<SubscriptionGraphNode>) {
  const surfaceStyle = {
    ["--glass-surface-fill" as "--glass-surface-fill"]: data.tone.surfaceFill,
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

  return (
    <div
      className="glass-surface rounded-[24px] border border-[var(--glass-border)] px-4 py-4 shadow-[0_18px_42px_rgba(15,23,42,0.08)]"
      style={surfaceStyle}
    >
      <div className="flex items-start justify-between gap-3">
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

      <p className="mt-2 text-sm text-[var(--text-secondary)]">{data.providerLabel}</p>

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
  );
}
