import { useEffect, useState } from "react";
import {
  getNotificationSettings,
  setNotificationDays,
  setNotificationsEnabled,
} from "../lib/settings";
import { NotificationSettings, NOTIFICATION_PRESETS } from "./NotificationSettings";

interface NotificationSettingsSectionProps {
  onError: (error: string) => void;
  onReadyChange?: (ready: boolean) => void;
}

export function NotificationSettingsSection({
  onError,
  onReadyChange,
}: NotificationSettingsSectionProps) {
  const [days, setDays] = useState<number | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [customInput, setCustomInput] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);

  useEffect(() => {
    getNotificationSettings()
      .then(({ daysBefore, enabled }) => {
        setEnabled(enabled);
        onReadyChange?.(true);
        if (NOTIFICATION_PRESETS.includes(daysBefore)) {
          setDays(daysBefore);
          setIsCustom(false);
          return;
        }

        setDays(daysBefore);
        setCustomInput(String(daysBefore));
        setIsCustom(true);
      })
      .catch((error) => onError(String(error)));
  }, [onError, onReadyChange]);

  async function saveDays(newDays: number) {
    await setNotificationDays(newDays);
    setDays(newDays);
    flashNotifSaved();
  }

  async function saveEnabled(value: boolean) {
    await setNotificationsEnabled(value);
    setEnabled(value);
    flashNotifSaved();
  }

  function flashNotifSaved() {
    setNotifSaved(true);
    setTimeout(() => setNotifSaved(false), 2000);
  }

  function handlePreset(days: number) {
    setIsCustom(false);
    setCustomInput("");
    void saveDays(days);
  }

  function handleCustomCommit() {
    const parsed = parseInt(customInput, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 365) {
      void saveDays(parsed);
    }
  }

  if (days === null || enabled === null) {
    return null;
  }

  return (
    <NotificationSettings
      enabled={enabled}
      days={days}
      isCustom={isCustom}
      customInput={customInput}
      notifSaved={notifSaved}
      onToggleEnabled={() => void saveEnabled(!enabled)}
      onPreset={handlePreset}
      onSelectCustom={() => {
        setIsCustom(true);
        setCustomInput(days !== null && NOTIFICATION_PRESETS.includes(days) ? "" : String(days));
      }}
      onCustomInputChange={setCustomInput}
      onCustomCommit={handleCustomCommit}
    />
  );
}
