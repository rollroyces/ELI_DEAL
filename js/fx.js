/**
 * Foreign-exchange rate provider.
 *
 * Uses the free exchangerate.host API (no key required). Rates are cached
 * in localStorage for 6 hours so a refresh doesn't trigger a network call
 * every time.
 *
 * The base currency is HKD (since all deals are HK-listed). Supported
 * display currencies: HKD, USD, CNY, EUR, JPY, GBP.
 *
 * @file js/fx.js
 */
(function (global) {
  'use strict';

  var CACHE_KEY = 'eli_fx_cache_v1';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

  // Hardcoded fallbacks — used only if the network call fails AND cache is empty.
  // Source: approximate rates (1 HKD = X foreign), refreshed quarterly.
  var FALLBACK_RATES = {
    HKD: 1,
    USD: 0.128,
    CNY: 0.93,
    EUR: 0.118,
    JPY: 19.5,
    GBP: 0.101
  };

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeCache(obj) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  function fresh(cache) {
    if (!cache || !cache.fetchedAt) return false;
    return (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;
  }

  /**
   * Return the rate from HKD to the given currency (1 HKD = rate * foreign).
   * Tries cache first, then network, then fallback.
   * @param {string} target 'USD' | 'CNY' | 'EUR' | 'JPY' | 'GBP' | 'HKD'
   * @returns {Promise<{ rate: number, asOf: string, source: 'cache'|'network'|'fallback' }>}
   */
  async function getRate(target) {
    target = (target || 'HKD').toUpperCase();
    if (target === 'HKD') return Promise.resolve({ rate: 1, asOf: '1970-01-01', source: 'fallback' });

    var cache = readCache();
    if (fresh(cache) && cache.rates && typeof cache.rates[target] === 'number') {
      return { rate: cache.rates[target], asOf: cache.asOf, source: 'cache' };
    }

    try {
      // exchangerate.host: open.er-api.com is a mirror without key requirement.
      // Returns rates keyed by 3-letter codes (USD, CNY, EUR, JPY, GBP).
      var url = 'https://open.er-api.com/v6/latest/HKD';
      var resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (!data.rates || typeof data.rates[target] !== 'number') throw new Error('rate missing');
      writeCache({
        fetchedAt: Date.now(),
        asOf: data.time_last_update_utc || new Date().toISOString().slice(0, 10),
        base: 'HKD',
        rates: data.rates
      });
      return { rate: data.rates[target], asOf: data.time_last_update_utc, source: 'network' };
    } catch (e) {
      // Last resort: fall back to the static table. Mark asOf as 'fallback'
      // so the UI can show the staleness.
      var rate = FALLBACK_RATES[target];
      if (typeof rate !== 'number') throw new Error('Unknown currency: ' + target);
      return { rate: rate, asOf: 'fallback', source: 'fallback' };
    }
  }

  /**
   * Convert an HKD-denominated amount into the given currency.
   * @param {number} hkdAmount
   * @param {string} target
   * @returns {Promise<{ amount: number, rate: number, source: string }>}
   */
  async function convert(hkdAmount, target) {
    if (typeof hkdAmount !== 'number' || !isFinite(hkdAmount)) {
      return { amount: NaN, rate: NaN, source: 'fallback' };
    }
    var r = await getRate(target);
    return { amount: hkdAmount * r.rate, rate: r.rate, source: r.source, asOf: r.asOf };
  }

  /**
   * List of supported display currencies.
   * @returns {Array<{ code: string, name: string, symbol: string }>}
   */
  function supportedCurrencies() {
    return [
      { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$' },
      { code: 'USD', name: 'US Dollar',         symbol: 'US$' },
      { code: 'CNY', name: 'Chinese Yuan',      symbol: '¥' },
      { code: 'EUR', name: 'Euro',              symbol: '€' },
      { code: 'JPY', name: 'Japanese Yen',      symbol: '¥' },
      { code: 'GBP', name: 'British Pound',     symbol: '£' }
    ];
  }

  global.Fx = {
    getRate: getRate,
    convert: convert,
    supportedCurrencies: supportedCurrencies
  };
})(window);