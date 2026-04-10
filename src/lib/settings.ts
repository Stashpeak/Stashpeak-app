import { invoke } from "@tauri-apps/api/core";

export interface NotificationSettings {
  daysBefore: number;
  enabled: boolean;
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  return invoke<NotificationSettings>("get_notification_settings");
}

export async function setNotificationDays(days: number): Promise<void> {
  await invoke("set_notification_days", { days });
}

export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  await invoke("set_notifications_enabled", { enabled });
}
