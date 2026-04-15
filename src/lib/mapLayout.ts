const MAP_LAYOUT_STORAGE_KEY = import.meta.env.DEV
  ? "stashpeak_map_layout_dev_v1"
  : "stashpeak_map_layout_v1";

export type StoredMapLayoutMode = "absolute" | "relative";

interface StoredMapNodeLayoutBase {
  x: number;
  y: number;
  layoutKey?: string;
}

export interface StoredAbsoluteMapNodeLayout extends StoredMapNodeLayoutBase {
  mode?: "absolute";
}

export interface StoredRelativeMapNodeLayout extends StoredMapNodeLayoutBase {
  mode: "relative";
  parentNodeId: string;
}

export type StoredMapNodeLayout = StoredAbsoluteMapNodeLayout | StoredRelativeMapNodeLayout;
export type StoredMapLayout = Record<string, StoredMapNodeLayout>;

export function createAbsoluteNodeLayout(x: number, y: number, layoutKey?: string): StoredAbsoluteMapNodeLayout {
  return { x, y, layoutKey };
}

export function createRelativeNodeLayout(
  parentNodeId: string,
  x: number,
  y: number,
  layoutKey?: string,
): StoredRelativeMapNodeLayout {
  return {
    mode: "relative",
    parentNodeId,
    x,
    y,
    layoutKey,
  };
}

export function isStoredRelativeNodeLayout(
  layout: StoredMapNodeLayout,
): layout is StoredRelativeMapNodeLayout {
  return layout.mode === "relative" && typeof layout.parentNodeId === "string";
}

export function loadMapLayout(): StoredMapLayout {
  try {
    const raw = localStorage.getItem(MAP_LAYOUT_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, Partial<StoredMapNodeLayout>>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => {
        if (typeof value?.x !== "number" || typeof value?.y !== "number") {
          return false;
        }

        if (value.mode === "relative") {
          return typeof value.parentNodeId === "string";
        }

        return true;
      }),
    ) as StoredMapLayout;
  } catch {
    return {};
  }
}

export function persistMapLayout(layout: StoredMapLayout) {
  localStorage.setItem(MAP_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}
