export const CACHE_KEY = import.meta.env.DEV ? "spend_cache_dev_v1" : "spend_cache_v1";
export const STALE_AFTER_MS = 5 * 60 * 1000;

interface CacheEntry<TData> {
  data: TData;
  fetchedAt: number;
}

type SpendCache<TId extends string, TData> = Partial<Record<TId, CacheEntry<TData>>>;

export function loadCache<TId extends string, TData>(): SpendCache<TId, TData> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as SpendCache<TId, TData>;
  } catch {
    return {};
  }
}

export function persistCache<TId extends string, TData>(id: TId, data: TData) {
  const cache = loadCache<TId, TData>();
  cache[id] = { data, fetchedAt: Date.now() };
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

export function evictCache<TId extends string, TData>(id: TId) {
  const cache = loadCache<TId, TData>();
  delete cache[id];
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

export function buildInitialStates<TId extends string, TData, TStatus>(
  emptyStates: Record<TId, TStatus>,
  buildOkState: (data: TData, fetchedAt: number) => TStatus,
): Record<TId, TStatus> {
  const cache = loadCache<TId, TData>();
  const result = { ...emptyStates };

  for (const [id, entry] of Object.entries(cache) as [TId, CacheEntry<TData> | undefined][]) {
    if (entry) {
      result[id] = buildOkState(entry.data, entry.fetchedAt);
    }
  }

  return result;
}
