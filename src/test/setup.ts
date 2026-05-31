import { afterEach } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";

// --- Determinism for golden snapshots -------------------------------------
// buildGraph embeds Intl-formatted currency/date strings (via formatCurrency
// and formatShortDate, both of which call Intl.*(undefined, ...)) into node
// data. Left alone, that output depends on the host's locale and time zone, so
// a snapshot taken on a cs-CZ dev machine would differ from one taken in CI.
// Pin the time zone and force the *default* locale (the one used when code
// passes `undefined`) to en-US so the snapshot is identical everywhere.
// @ts-expect-error process is a nodejs global (this app ships no @types/node)
process.env.TZ = "UTC";

const pinDefaultLocale = <T extends object>(Ctor: T): T =>
  new Proxy(Ctor, {
    construct(target, args, newTarget) {
      return Reflect.construct(target as never, [args[0] ?? "en-US", ...args.slice(1)], newTarget);
    },
    apply(target, thisArg, args) {
      return Reflect.apply(target as never, thisArg, [args[0] ?? "en-US", ...args.slice(1)]);
    },
  });

Intl.NumberFormat = pinDefaultLocale(Intl.NumberFormat);
Intl.DateTimeFormat = pinDefaultLocale(Intl.DateTimeFormat);

// Date.prototype.toLocale* (used by formatProviderRefreshedAt on 'ok'-status
// providers) does NOT route through Intl.* above, so pin its default locale
// too. Callers pass `[]` to mean "default locale"; treat that as en-US as well.
const DATE_LOCALE_METHODS = [
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
] as const;

for (const method of DATE_LOCALE_METHODS) {
  const original = Date.prototype[method] as (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  Date.prototype[method] = function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    const pinned =
      locales === undefined || (Array.isArray(locales) && locales.length === 0)
        ? "en-US"
        : locales;
    return original.call(this, pinned, options);
  };
}

// Reset any registered Tauri IPC mock between tests so state never leaks across
// files (no-op for tests that never call mockIPC, e.g. the buildGraph golden).
afterEach(() => {
  clearMocks();
});
