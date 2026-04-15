import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ProviderGraphNode } from "./types";

export function ProviderNode({ data }: NodeProps<ProviderGraphNode>) {
  return (
    <div className={`relative map-node-tone ${data.tone.className}`}>
      <Handle type="source" position={Position.Bottom} className="map-node-handle-hidden" />
      <Handle type="target" position={Position.Bottom} className="map-node-handle-hidden" />
      <div
        className="glass-surface map-node-surface rounded-[24px] border border-[var(--glass-border)] px-4 py-4"
      >
        <div className="map-node-drag-handle flex cursor-grab items-start justify-between gap-3 active:cursor-grabbing">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">{data.caption}</p>
            <h3 className="mt-1 text-base font-medium text-[var(--text-primary)]">{data.title}</h3>
          </div>
          <span className="map-node-badge shrink-0 rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.18em]">
            {data.statusLabel}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <div className="map-node-panel rounded-[18px] border px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">{data.primaryLabel}</p>
            <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{data.primaryValue}</p>
          </div>
          <div className="map-node-panel rounded-[18px] border px-3 py-2.5">
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
