import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export interface UpcomingRenewal {
  id: number;
  name: string;
  currency: string;
  cost: number;
  billingPeriod: string;
  daysUntil: number;
  nextBillingAt: string;
}

export function useUpcomingRenewals(refreshTrigger?: unknown) {
  const [renewals, setRenewals] = useState<UpcomingRenewal[]>([]);

  useEffect(() => {
    let isActive = true;

    void invoke<UpcomingRenewal[]>("get_upcoming_renewals")
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
