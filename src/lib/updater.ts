import { check, type Update } from "@tauri-apps/plugin-updater";

export type { Update };

export interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
}

/**
 * Checks for an available update. Returns UpdateInfo and the raw Update
 * object if one is available, or null if the app is already up to date.
 * Throws on network or signature errors — caller should catch.
 */
export async function checkForUpdate(): Promise<{ info: UpdateInfo; update: Update } | null> {
  const update = await check();
  if (!update) return null;
  return {
    info: {
      version: update.version,
      body: update.body ?? null,
      date: update.date ?? null,
    },
    update,
  };
}

/**
 * Downloads and installs the given update, then requests a relaunch.
 * The onProgress callback receives cumulative bytes downloaded and total size.
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case "Finished":
        break;
    }
  });
}
