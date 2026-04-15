import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { type MapEdge } from "../../lib/mapGraph";

const TOP_BUS_OFFSET = 20;
const BOTTOM_BUS_OFFSET = 20;

export function BusEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
}: EdgeProps<MapEdge>) {
  const laneY = sourceY < targetY
    ? targetY - TOP_BUS_OFFSET
    : targetY + BOTTOM_BUS_OFFSET;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX} ${laneY}`,
    `L ${targetX} ${laneY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");

  return <BaseEdge path={path} markerEnd={markerEnd} style={style} />;
}
