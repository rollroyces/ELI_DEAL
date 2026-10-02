/**
 * Optional Finnhub fallback for HK stock prices.
 * Used only when Yahoo Finance is rate-limiting or unreachable AND the user
 * has supplied their own Finnhub API key in Settings.
 *
 * The key is stored in localStorage and sent only to finnhub.io from the browser.
 * No key = this module is a no-op.
 */
(function (global) {
  'use strict';

  var FINNHUB_BASE = 'https://finnhub.io/api/v1';

  function getApiKey() {
    var settings = global.Storage && global.Storage.getSettings();
    return settings ? settings.finnhubApiKey : '';
  }

  function normalizeSymbol(symbol) {
    if (!symbol) return '';
    return String(symbol).trim().toUpperCase();
  }

  /**
   * Fetch a single HK quote from Finnhub.
   * @param {string} symbol
   * @returns {Promise<number|null>}
   */
  async function getQuote(symbol) {
    var key = getApiKey();
    if (!key) return null;
    var s = normalizeSymbol(symbol);
    var url = FINNHUB_BASE + '/quote?symbol=' + encodeURIComponent(s) +
              '&token=' + encodeURIComponent(key);
    try {
      var resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) return null;
      var data = await resp.json();
      // Finnhub returns { c: current, h, l, o, pc, t } — `c` is current price.
      var price = data && data.c;
      if (typeof price === 'number' && isFinite(price) && price > 0) return price;
      return null;
    } catch (e) {
      console.warn('Finnhub fetch failed for', s, e.message);
      return null;
    }
  }

  /** Liveness probe — returns true if a key is set and a probe quote succeeds. */
  async function ping() {
    if (!getApiKey()) return false;
    var p = await getQuote('0700.HK');
    return p != null;
  }

  global.Finnhub = {
    getQuote: getQuote,
    ping: ping,
    hasKey: function () { return !!getApiKey(); }
  };
})(window);