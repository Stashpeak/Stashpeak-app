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

export function useUpcomingRenewals() {
  const [renewals, setRenewals] = useState<UpcomingRenewal[]>([]);

  useEffect(() => {
    invoke<UpcomingRenewal[]>("get_upcoming_renewals").then(setRenewals).catch(() => {});
  }, []);

  return renewals;
}
