import type { CSSProperties } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MapNodeTone } from "./types";

export interface ProviderNodeData extends Record<string, unknown> {
  title: string;
  caption: string;
  statusLabel: string;
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
  note?: string;
  tone: MapNodeTone;
}

export type ProviderGraphNode = Node<ProviderNodeData, "provider">;

const HIDDEN_HANDLE_STYLE = {
  width: 10,
  height: 10,
  opacity: 0,
  background: "transparent",
  border: "none",
} as const;

export function ProviderNode({ data }: NodeProps<ProviderGraphNode>) {
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

  return (
    <div className="relative">
      <Handle type="target" position={Position.Bottom} style={HIDDEN_HANDLE_STYLE} />
      <div
        className="glass-surface rounded-[24px] border border-[var(--glass-border)] px-4 py-4"
        style={surfaceStyle}
      >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">{data.caption}</p>
          <h3 className="mt-1 text-base font-medium text-[var(--text-primary)]">{data.title}</h3>
        </div>
        <span
          className="shrink-0 rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.18em]"
          style={badgeStyle}
        >
          {data.statusLabel}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-[18px] border px-3 py-2.5" style={metricStyle}>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">{data.primaryLabel}</p>
          <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{data.primaryValue}</p>
        </div>
        <div className="rounded-[18px] border px-3 py-2.5" style={metricStyle}>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">{data.secondaryLabel}</p>
          <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{data.secondaryValue}</p>
        </div>
      </div>

      {data.note ? (
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">{data.note}</p>
      ) : null}
      </div>
    </div>
  );
}
