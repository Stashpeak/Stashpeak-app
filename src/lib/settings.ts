import { invoke } from "@tauri-apps/api/core";

export interface NotificationSettings {
  daysBefore: number;
  enabled: boolean;
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  try {
    return await invoke<NotificationSettings>("get_notification_settings");
  } catch (e) {
    throw new Error(`Failed to load notification settings: ${e}`);
  }
}

export async function setNotificationDays(days: number): Promise<void> {
  try {
    await invoke("set_notification_days", { days });
  } catch (e) {
    throw new Error(`Failed to set notification days: ${e}`);
  }
}

export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke("set_notifications_enabled", { enabled });
  } catch (e) {
    throw new Error(`Failed to set notifications enabled: ${e}`);
  }
}
