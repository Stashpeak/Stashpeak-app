import { useEffect, useState } from "react";
import {
  getExchangeRates,
  getHomeCurrency,
  setHomeCurrency,
  type ExchangeRate,
} from "../lib/settings";
import { CURRENCY_OPTIONS } from "../lib/currencies";
import { RateRow } from "./RateRow";

interface ExchangeRatesSectionProps {
  subCurrencies: string[];
  onError: (error: string) => void;
  onReadyChange?: (ready: boolean) => void;
}

export function ExchangeRatesSection({
  subCurrencies,
  onError,
  onReadyChange,
}: ExchangeRatesSectionProps) {
  const [homeCurrency, setHomeCurrencyState] = useState<string | null>(null);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [currencySaved, setCurrencySaved] = useState(false);

  useEffect(() => {
    getHomeCurrency()
      .then((currency) => {
        setHomeCurrencyState(currency);
        onReadyChange?.(true);
      })
      .catch((error) => onError(String(error)));

    loadExchangeRates();
  }, [onError, onReadyChange]);

  function loadExchangeRates() {
    getExchangeRates()
      .then(setExchangeRates)
      .catch((error) => onError(String(error)));
  }

  async function handleHomeCurrencyChange(currency: string) {
    setHomeCurrencyState(currency);
    try {
      await setHomeCurrency(currency);
      setCurrencySaved(true);
      setTimeout(() => setCurrencySaved(false), 2000);
    } catch (error) {
      onError(String(error));
    }
  }

  if (homeCurrency === null) {
    return null;
  }

  const ratesNeeded = subCurrencies.filter((currency) => currency !== homeCurrency);
  const rateMap = new Map<string, number>(
    exchangeRates
      .filter((rate) => rate.toCurrency === homeCurrency)
      .map((rate) => [rate.fromCurrency, rate.rate]),
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-ink">Home currency</h2>
        <p className="mt-0.5 text-xs text-secondary">
          Subscription totals are converted into this currency in the header.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <select
          id="home-currency-select"
          value={homeCurrency}
          onChange={(event) => void handleHomeCurrencyChange(event.target.value)}
          className="cursor-pointer rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-primary"
        >
          {CURRENCY_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
        {currencySaved && <span className="text-xs text-primary">Saved</span>}
      </div>

      {ratesNeeded.length > 0 && (
        <div className="space-y-3 pt-1">
          <p className="text-xs leading-relaxed text-secondary">
            Enter exchange rates for your subscription currencies. Used to calculate the aggregate total.
          </p>
          {ratesNeeded.map((fromCurrency) => (
            <RateRow
              key={fromCurrency}
              fromCurrency={fromCurrency}
              homeCurrency={homeCurrency}
              initialRate={rateMap.get(fromCurrency) ?? null}
              onSaved={loadExchangeRates}
            />
          ))}
        </div>
      )}

      {ratesNeeded.length === 0 && subCurrencies.length > 0 && (
        <p className="text-xs text-secondary/60">
          All your subscriptions are already in {homeCurrency} - no conversion needed.
        </p>
      )}
    </section>
  );
}
