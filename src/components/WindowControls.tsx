import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export function WindowControls() {
  const isMac = navigator.userAgent.includes("Mac");

  if (isMac) return null;

  return (
    <div className="flex h-12 items-center gap-2 px-4" data-tauri-drag-region>
      <div className="flex-1" data-tauri-drag-region /> {/* Spacer for drag */}
      <button
        onClick={() => appWindow.minimize()}
        className="rounded-full p-2 text-[var(--text-subtle)] transition-colors hover:bg-[var(--glass-bg)] hover:text-[var(--text-primary)] cursor-pointer"
        title="Minimize"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 8h12" />
        </svg>
      </button>
      <button
        onClick={() => appWindow.toggleMaximize()}
        className="rounded-full p-2 text-[var(--text-subtle)] transition-colors hover:bg-[var(--glass-bg)] hover:text-[var(--text-primary)] cursor-pointer"
        title="Maximize"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <rect x="2" y="2" width="12" height="12" rx="2" />
        </svg>
      </button>
      <button
        onClick={() => appWindow.close()}
        className="rounded-full p-2 text-[var(--text-subtle)] transition-colors hover:bg-[rgba(255,0,0,0.1)] hover:text-red-500 cursor-pointer"
        title="Close"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
