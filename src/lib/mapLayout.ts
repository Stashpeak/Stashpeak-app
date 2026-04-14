const MAP_LAYOUT_STORAGE_KEY = import.meta.env.DEV
  ? "stashpeak_map_layout_dev_v1"
  : "stashpeak_map_layout_v1";

export interface StoredMapNodeLayout {
  x: number;
  y: number;
  layoutKey?: string;
}

export type StoredMapLayout = Record<string, StoredMapNodeLayout>;

export function loadMapLayout(): StoredMapLayout {
  try {
    const raw = localStorage.getItem(MAP_LAYOUT_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, Partial<StoredMapNodeLayout>>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) =>
        typeof value?.x === "number" && typeof value?.y === "number",
      ),
    ) as StoredMapLayout;
  } catch {
    return {};
  }
}

export function persistMapLayout(layout: StoredMapLayout) {
  localStorage.setItem(MAP_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}
