import type { ReactNode } from "react";

type SelectableErrorMessageProps = {
  children: ReactNode;
  className?: string;
  kind?: "banner" | "inline";
};

export function SelectableErrorMessage({
  children,
  className = "",
  kind = "banner",
}: SelectableErrorMessageProps) {
  const Component = kind === "inline" ? "p" : "div";

  // The app shell disables text selection globally, so error text opts back in here.
  const baseClassName =
    kind === "inline"
      ? "select-text break-words whitespace-pre-wrap text-sm text-rose-500"
      : "select-text break-words whitespace-pre-wrap rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700";

  return <Component className={`${baseClassName} ${className}`.trim()}>{children}</Component>;
}
