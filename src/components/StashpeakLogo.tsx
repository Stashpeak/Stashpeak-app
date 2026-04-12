import logoUrl from "../assets/stashpeak-logo-2025.svg";

interface Props {
  width?: number;
  height?: number;
  theme?: "light" | "dark";
}

export function StashpeakLogo({ width = 42, height = 40, theme = "light" }: Props) {
  return (
    <img
      src={logoUrl}
      alt="Stashpeak"
      width={width}
      height={height}
      draggable={false}
      style={{
        display: "block",
        flexShrink: 0,
        filter: theme === "dark" ? "invert(1)" : "none",
      }}
    />
  );
}
