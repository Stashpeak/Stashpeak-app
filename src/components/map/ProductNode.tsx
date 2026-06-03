import type { MouseEvent, PointerEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ProductGraphNode } from "./types";

export function ProductNode({ data }: NodeProps<ProductGraphNode>) {
  const stopInteractionPropagation = (event: MouseEvent | PointerEvent) => {
    event.stopPropagation();
  };

  return (
    <div className={`relative map-node-tone ${data.tone.className}`}>
      <Handle
        id="provider"
        type="target"
        position={Position.Top}
        className="map-node-handle-hidden"
      />
      <Handle
        id="subscription"
        type="target"
        position={Position.Bottom}
        className="map-node-handle-hidden"
      />
      <div
        className={`glass-surface map-node-surface rounded-[22px] border border-[var(--glass-border)] px-3.5 py-3${data.isLinked ? "" : " opacity-[0.76]"}`}
      >
        <div className="flex items-start gap-2">
          <div className="map-node-drag-handle flex min-w-0 flex-1 cursor-grab items-start justify-between gap-2 active:cursor-grabbing">
            <div className="min-w-0">
              <p className="text-[9px] uppercase tracking-[0.22em] text-[var(--text-muted)]">
                {data.caption}
              </p>
              <h3 className="mt-1 truncate text-sm font-medium text-[var(--text-primary)]">
                {data.title}
              </h3>
            </div>
            <span className="map-node-badge shrink-0 rounded-full border px-2 py-1 text-[8px] uppercase tracking-[0.16em]">
              {data.statusLabel}
            </span>
          </div>

          {data.onResetPosition ? (
            <button
              type="button"
              className="map-node-action nodrag nopan pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors"
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
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3.5 5.5V2.75H6.25" />
                <path d="M3.85 5.15A5 5 0 1 1 4.6 11.8" />
              </svg>
            </button>
          ) : null}
        </div>

        {data.description ? (
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {data.description}
          </p>
        ) : null}

        <div className="map-node-panel mt-3 rounded-[16px] border px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Coverage
          </p>
          <p className="mt-1 text-xs font-medium text-[var(--text-primary)]">
            {data.activityLabel}
          </p>
        </div>
      </div>
    </div>
  );
}
