const CATEGORY_LABEL_OVERRIDES: Record<string, string> = {
  ai: "AI",
};

export function formatCategoryLabel(value: string): string {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  return trimmedValue
    .split(/\s+/)
    .map((word) => CATEGORY_LABEL_OVERRIDES[word.toLowerCase()] ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
