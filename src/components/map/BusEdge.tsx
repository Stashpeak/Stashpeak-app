import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { type MapEdge } from "../../lib/mapGraph";

const TOP_BUS_OFFSET = 20;
const BOTTOM_BUS_OFFSET = 20;

export function BusEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
}: EdgeProps<MapEdge>) {
  const laneY = sourceY < targetY
    ? targetY - TOP_BUS_OFFSET
    : targetY + BOTTOM_BUS_OFFSET;
  const bus = data?.bus;

  if (!bus) {
    const fallbackPath = [
      `M ${sourceX} ${sourceY}`,
      `L ${sourceX} ${laneY}`,
      `L ${targetX} ${laneY}`,
      `L ${targetX} ${targetY}`,
    ].join(" ");

    return <BaseEdge path={fallbackPath} markerEnd={markerEnd} style={style} />;
  }

  const segments: string[] = [];

  if (bus.drawHorizontal) {
    segments.push(`M ${bus.laneStartX} ${laneY}`, `L ${bus.laneEndX} ${laneY}`);
  }

  if (bus.drawSourceStub) {
    segments.push(`M ${sourceX} ${sourceY}`, `L ${sourceX} ${laneY}`);
  }

  if (bus.drawTargetStub) {
    segments.push(`M ${targetX} ${laneY}`, `L ${targetX} ${targetY}`);
  }

  return (
    <BaseEdge
      path={segments.join(" ")}
      markerEnd={bus.drawTargetStub ? markerEnd : undefined}
      style={style}
    />
  );
}
