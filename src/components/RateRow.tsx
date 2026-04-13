import { useState } from "react";
import { upsertExchangeRate } from "../lib/settings";
import { SelectableErrorMessage } from "./SelectableErrorMessage";

interface RateRowProps {
  fromCurrency: string;
  homeCurrency: string;
  initialRate: number | null;
  onSaved: () => void;
}

export function RateRow({ fromCurrency, homeCurrency, initialRate, onSaved }: RateRowProps) {
  const [input, setInput] = useState(initialRate !== null ? String(initialRate) : "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    const parsed = parseFloat(input);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Enter a positive number");
      return;
    }
    setError(null);
    try {
      await upsertExchangeRate(fromCurrency, homeCurrency, parsed);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-secondary w-24 shrink-0">
        1 <span className="font-medium text-ink">{fromCurrency}</span> =
      </span>
      <input
        type="number"
        min={0}
        step="any"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === "Enter" && void commit()}
        placeholder="e.g. 25.5"
        className="w-28 rounded-[14px] border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-subtle)] focus:border-[var(--purple-primary)] focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <span className="text-sm text-secondary">{homeCurrency}</span>
      {saved && <span className="text-xs text-primary transition-opacity">Saved</span>}
      {error && <SelectableErrorMessage kind="inline">{error}</SelectableErrorMessage>}
    </div>
  );
}
