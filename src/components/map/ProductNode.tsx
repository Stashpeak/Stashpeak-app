import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ProductGraphNode } from "./types";

const HIDDEN_HANDLE_STYLE = {
  width: 10,
  height: 10,
  opacity: 0,
  background: "transparent",
  border: "none",
} as const;

export function ProductNode({ data }: NodeProps<ProductGraphNode>) {
  const surfaceStyle = {
    ["--glass-surface-fill" as "--glass-surface-fill"]: data.tone.surfaceFill,
    boxShadow: "var(--map-node-shadow)",
    opacity: data.isLinked ? 1 : 0.76,
  } as CSSProperties;

  const badgeStyle = {
    backgroundColor: data.tone.badgeFill,
    borderColor: data.tone.badgeBorder,
    color: data.tone.badgeText,
  } as CSSProperties;

  const detailStyle = {
    backgroundColor: data.tone.metricFill,
    borderColor: data.tone.metricBorder,
  } as CSSProperties;

  return (
    <div className="relative">
      <Handle id="provider" type="target" position={Position.Top} style={HIDDEN_HANDLE_STYLE} />
      <Handle id="subscription" type="target" position={Position.Bottom} style={HIDDEN_HANDLE_STYLE} />
      <div
        className="glass-surface rounded-[22px] border border-[var(--glass-border)] px-3.5 py-3"
        style={surfaceStyle}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[9px] uppercase tracking-[0.22em] text-[var(--text-muted)]">{data.caption}</p>
            <h3 className="mt-1 truncate text-sm font-medium text-[var(--text-primary)]">{data.title}</h3>
          </div>
          <span
            className="shrink-0 rounded-full border px-2 py-1 text-[8px] uppercase tracking-[0.16em]"
            style={badgeStyle}
          >
            {data.statusLabel}
          </span>
        </div>

        {data.description ? (
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{data.description}</p>
        ) : null}

        <div className="mt-3 rounded-[16px] border px-3 py-2" style={detailStyle}>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Coverage</p>
          <p className="mt-1 text-xs font-medium text-[var(--text-primary)]">{data.activityLabel}</p>
        </div>
      </div>
    </div>
  );
}
