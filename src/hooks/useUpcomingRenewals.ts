import { useEffect, useState } from "react";
import { getUpcomingRenewals, type UpcomingRenewal } from "../lib/subscriptions";

export function useUpcomingRenewals(refreshTrigger?: unknown) {
  const [renewals, setRenewals] = useState<UpcomingRenewal[]>([]);

  useEffect(() => {
    let isActive = true;

    void getUpcomingRenewals()
      .then((nextRenewals) => {
        if (isActive) {
          setRenewals(nextRenewals);
        }
      })
      .catch(() => {});

    return () => {
      isActive = false;
    };
  }, [refreshTrigger]);

  return renewals;
}
