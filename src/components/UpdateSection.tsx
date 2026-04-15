import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, downloadAndInstall, type Update } from "../lib/updater";
import { ACCENT_BUTTON_SURFACE } from "../lib/surfaceStyles";
import { SelectableErrorMessage } from "./SelectableErrorMessage";

type CheckState = "idle" | "checking" | "upToDate" | "available" | "downloading" | "done" | "error";

interface UpdateSectionProps {
  updateAvailable: boolean;
  onUpdateConsumed: () => void;
}

export function UpdateSection({
  updateAvailable,
  onUpdateConsumed,
}: UpdateSectionProps) {
  const [appVersion, setAppVersion] = useState("");
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body: string | null } | null>(null);
  const updateRef = useRef<Update | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.1.0"));
  }, []);

  useEffect(() => {
    if (updateAvailable) {
      setCheckState("available");
      // IMPORTANT: App.tsx background check only passes `updateAvailable: boolean` —
      // the Update object is discarded there. We must re-fetch here to populate
      // updateRef.current; without it handleInstall() silently exits (guard on line ~56).
      // Do NOT remove this re-fetch or the "Download and install" button will do nothing.
      void checkForUpdate().then((result) => {
        if (result) {
          updateRef.current = result.update;
          setUpdateInfo({ version: result.info.version, body: result.info.body });
        }
      });
    }
  }, [updateAvailable]);

  async function handleCheckForUpdates() {
    setCheckState("checking");
    setUpdateError(null);
    try {
      const result = await checkForUpdate();
      if (result) {
        updateRef.current = result.update;
        setUpdateInfo({ version: result.info.version, body: result.info.body });
        setCheckState("available");
        return;
      }

      setCheckState("upToDate");
    } catch (error) {
      setUpdateError(String(error));
      setCheckState("error");
    }
  }

  async function handleInstall() {
    if (!updateRef.current) {
      // updateRef is populated either by handleCheckForUpdates() (manual flow)
      // or by the useEffect above (background-detection flow). If it's still null
      // here, the re-fetch hasn't resolved yet — do not proceed silently.
      return;
    }

    setCheckState("downloading");
    setDownloadProgress(0);
    setDownloadTotal(null);
    try {
      await downloadAndInstall(updateRef.current, (downloaded, total) => {
        setDownloadProgress(downloaded);
        setDownloadTotal(total);
      });
      setCheckState("done");
      onUpdateConsumed();
    } catch (error) {
      setUpdateError(String(error));
      setCheckState("error");
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-ink">About</h2>
        <p className="mt-0.5 text-xs text-secondary">
          Stashpeak{appVersion ? ` v${appVersion}` : ""}
        </p>
      </div>

      {checkState === "idle" && (
        <button
          onClick={() => void handleCheckForUpdates()}
          className={`${ACCENT_BUTTON_SURFACE} cursor-pointer`}
        >
          {updateAvailable ? "Update available - view" : "Check for updates"}
        </button>
      )}

      {checkState === "checking" && <p className="text-xs text-secondary">Checking...</p>}

      {checkState === "upToDate" && (
        <p className="text-xs text-primary">You&apos;re up to date.</p>
      )}

      {checkState === "available" && (
        <div className="space-y-2">
          {updateInfo && (
            <p className="text-xs text-secondary">
              v{updateInfo.version} is available.
              {updateInfo.body && (
                <span className="mt-1 block whitespace-pre-wrap text-ink/70">{updateInfo.body}</span>
              )}
            </p>
          )}
          <button
            onClick={() => void handleInstall()}
            className="cursor-pointer rounded-full bg-primary px-4 py-1.5 text-sm text-white transition-all hover:bg-primary/90"
          >
            Download and install
          </button>
        </div>
      )}

      {checkState === "downloading" && (
        <div className="space-y-1.5">
          <p className="text-xs text-secondary">Downloading...</p>
          {downloadTotal !== null && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-100">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.round((downloadProgress / downloadTotal) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {checkState === "done" && (
        <p className="text-xs text-primary">
          Update installed. The app will restart shortly.
        </p>
      )}

      {checkState === "error" && (
        <div className="space-y-2">
          <SelectableErrorMessage kind="inline">{updateError}</SelectableErrorMessage>
          <button
            onClick={() => void handleCheckForUpdates()}
            className="cursor-pointer text-xs text-primary underline"
          >
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
