/**
 * Browser-side Yahoo Finance client.
 * Calls the public chart endpoint directly from the browser.
 * No API key required. CORS is supported by Yahoo's quote endpoints.
 *
 * Why we don't bundle the `yfinance` Python library here:
 *   yfinance is a Python wrapper around Yahoo's private APIs.
 *   In the browser we just hit the same JSON endpoints with fetch().
 */
(function (global) {
  'use strict';

  var CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
  // Spare host in case the primary gets rate-limited.
  var CHART_URL_FALLBACK = 'https://query2.finance.yahoo.com/v8/finance/chart';

  var DEFAULT_DELAY_MS = 120; // small delay between sequential calls to avoid 429s

  function normalizeHkSymbol(symbol) {
    if (!symbol) return '';
    var s = String(symbol).trim().toUpperCase();
    if (!s) return '';
    if (s.endsWith('.HK')) return s;
    // Pad HK stock codes with zeros to 4 digits if user typed "700" or "700.HK"
    var m = s.match(/^0*(\d+)(?:\.HK)?$/);
    if (m) {
      var digits = m[1];
      while (digits.length < 4) digits = '0' + digits;
      return digits + '.HK';
    }
    return s;
  }

  async function fetchFromHost(host, symbol, signal) {
    var url = host + '/' + encodeURIComponent(symbol) +
              '?interval=1d&range=1d&includePrePost=false';
    var resp = await fetch(url, {
      method: 'GET',
      signal: signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status);
    }
    return resp.json();
  }

  function extractPrice(json) {
    var result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result) return null;
    var meta = result.meta || {};
    // Try in order of preference.
    var price = meta.regularMarketPrice;
    if (price == null) price = meta.chartPreviousClose;
    if (price == null) price = meta.previousClose;
    if (price == null) {
        // Fall back to the last close in the price array.
        var closes = result.indicators && result.indicators.quote &&
                     result.indicators.quote[0] && result.indicators.quote[0].close;
        if (Array.isArray(closes) && closes.length) {
          for (var i = closes.length - 1; i >= 0; i--) {
            if (closes[i] != null) { price = closes[i]; break; }
          }
        }
      }
    if (typeof price !== 'number' || !isFinite(price) || price <= 0) return null;
    return price;
  }

  /**
   * Get a single quote. Tries both Yahoo hosts before giving up.
   * @param {string} symbol  e.g. "0700.HK"
   * @param {AbortSignal=} signal
   * @returns {Promise<number|null>}
   */
  async function getQuote(symbol, signal) {
    var normalized = normalizeHkSymbol(symbol);
    var hosts = [CHART_URL, CHART_URL_FALLBACK];
    var lastErr = null;
    for (var i = 0; i < hosts.length; i++) {
      try {
        var json = await fetchFromHost(hosts[i], normalized, signal);
        var price = extractPrice(json);
        if (price != null) return price;
        lastErr = new Error('Empty result from ' + hosts[i]);
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  /**
   * Batch fetch prices. Sequential with a small delay between calls to avoid 429s.
   * @param {string[]} symbols
   * @param {{delay?: number, signal?: AbortSignal}=} options
   * @returns {Promise<Object<string, number|null>>}  keyed by ORIGINAL symbol
   */
  async function getQuotes(symbols, options) {
    options = options || {};
    var delay = typeof options.delay === 'number' ? options.delay : DEFAULT_DELAY_MS;
    var result = {};
    var signal = options.signal;

    for (var i = 0; i < symbols.length; i++) {
      var original = symbols[i];
      var normalized = normalizeHkSymbol(original);

      // Cache hit short-circuit
      var cached = global.Storage && global.Storage.getCachedPrice(normalized);
      if (cached != null) {
        result[original] = cached;
        continue;
      }

      try {
        var price = await getQuote(normalized, signal);
        result[original] = price;
        if (price != null && global.Storage) {
          global.Storage.setCachedPrice(normalized, price);
        }
      } catch (e) {
        console.warn('YF fetch failed for', normalized, e.message);
        result[original] = null;
      }

      if (delay > 0 && i < symbols.length - 1) {
        await new Promise(function (r) { setTimeout(r, delay); });
      }
    }
    return result;
  }

  /** Lightweight liveness check for the Settings page status indicator. */
  async function ping() {
    try {
      // Use a stable, widely-quoted symbol for the health probe.
      var p = await getQuote('0700.HK');
      return p != null;
    } catch (e) {
      return false;
    }
  }

  /**
   * Probe the price source and return a detailed status object the UI
   * can show next to the Settings → Price Source panel.
   *   { ok: bool, message: string, latencyMs?: number }
   */
  async function probe() {
    var t0 = Date.now();
    try {
      var p = await getQuote('0700.HK');
      var latencyMs = Date.now() - t0;
      if (p != null) return { ok: true, message: 'Yahoo Finance responded with HK$ ' + p.toFixed(2) + ' for 0700.HK in ' + latencyMs + ' ms', latencyMs: latencyMs };
      return { ok: false, message: 'Yahoo Finance did not return a price (rate-limited or blocked)' };
    } catch (e) {
      return { ok: false, message: 'Yahoo Finance error: ' + (e.message || e) };
    }
  }

  global.YahooFinance = {
    normalizeHkSymbol: normalizeHkSymbol,
    getQuote: getQuote,
    getQuotes: getQuotes,
    ping: ping,
    probe: probe
  };
})(window);