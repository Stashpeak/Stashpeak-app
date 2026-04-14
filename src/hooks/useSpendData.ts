import { useEffect, useRef, useState } from "react";
import { fetchProviderSpend, getProviderEnabled, type SpendData } from "../lib/connectors";
import { hasProviderApiKey } from "../lib/credentials";
import {
  STALE_AFTER_MS,
  buildInitialStates,
  evictCache,
  loadCache,
  persistCache,
} from "../lib/spendCache";
import {
  EMPTY_PROVIDER_STATES,
  SPEND_PROVIDERS,
  type ProviderDefinition,
  type ProviderId,
  type ProviderStatus,
} from "../lib/spendProviders";

function buildOkState(data: SpendData, fetchedAt: number): ProviderStatus {
  return { tag: "ok", data, refreshedAt: new Date(fetchedAt) };
}

export function useSpendData() {
  const [states, setStates] = useState<Record<ProviderId, ProviderStatus>>(() =>
    buildInitialStates<ProviderId, SpendData, ProviderStatus>(EMPTY_PROVIDER_STATES, buildOkState),
  );
  const [visibleProviders, setVisibleProviders] = useState<ProviderDefinition[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  function setStatus(id: ProviderId, status: ProviderStatus) {
    setStates((prev) => ({ ...prev, [id]: status }));
  }

  async function refresh(id: ProviderId, showLoading = true) {
    if (showLoading) {
      setStatus(id, { tag: "loading" });
    } else {
      setStates((prev) => {
        const status = prev[id];
        return status.tag === "ok"
          ? { ...prev, [id]: { ...status, backgroundRefreshing: true } }
          : prev;
      });
    }

    try {
      const data = await fetchProviderSpend(id);
      if (cancelledRef.current) return;
      setStatus(id, { tag: "ok", data, refreshedAt: new Date() });
      persistCache(id, data);
    } catch (error) {
      if (cancelledRef.current) return;
      setStatus(id, { tag: "stale", error: String(error) });
    }
  }

  function clear(id: ProviderId) {
    evictCache(id);
    setStatus(id, { tag: "unconfigured" });
  }

  function refreshAll() {
    visibleProviders.forEach(({ id }) => {
      const status = states[id];
      if (status.tag === "ok" || status.tag === "stale") {
        void refresh(id);
      }
    });
  }

  useEffect(() => {
    cancelledRef.current = false;

    const cache = loadCache<ProviderId, SpendData>();
    const now = Date.now();

    Promise.all(SPEND_PROVIDERS.map(({ id }) => getProviderEnabled(id).then((enabled) => ({ id, enabled }))))
      .then((results) => {
        if (cancelledRef.current) return;

        const enabledById = {} as Record<ProviderId, boolean>;

        for (const { id, enabled } of results) {
          enabledById[id] = enabled;
          if (!enabled) clear(id);
        }

        setVisibleProviders(SPEND_PROVIDERS.filter(({ id }) => enabledById[id]));

        SPEND_PROVIDERS.forEach(({ id, comingSoon }) => {
          if (comingSoon || !enabledById[id]) return;

          hasProviderApiKey(id)
            .then((hasKey) => {
              if (cancelledRef.current) return;
              if (!hasKey) {
                clear(id);
                return;
              }

              const entry = cache[id];
              const isStale = !entry || now - entry.fetchedAt > STALE_AFTER_MS;
              if (isStale) {
                void refresh(id, !entry);
              }
            })
            .catch(() => {});
        });
      })
      .catch((error) => {
        if (!cancelledRef.current) setLoadError(String(error));
      });

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return { clear, loadError, refresh, refreshAll, states, visibleProviders };
}
