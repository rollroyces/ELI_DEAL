/**
 * Browser-side persistence layer.
 * Replaces the Flask + MySQL/SQLite backend that the original project used.
 * All data lives in localStorage, so it stays in this browser profile.
 * Use Export/Import (CSV/JSON) in Settings to move data across devices.
 */
(function (global) {
  'use strict';

  var KEY_DEALS = 'eli_deals_v1';
  var KEY_SETTINGS = 'eli_settings_v1';
  var KEY_PRICE_CACHE = 'eli_price_cache_v1';
  var KEY_VERSION = 'eli_schema_version';
  var CURRENT_SCHEMA = 1;

  function safeRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('storage read failed for', key, e);
      return fallback;
    }
  }

  function safeWrite(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('storage write failed for', key, e);
      return false;
    }
  }

  // ─── Schema migration hook ─────────────────────────────────────────
  function ensureSchema() {
    var v = parseInt(localStorage.getItem(KEY_VERSION) || '0', 10);
    if (v < CURRENT_SCHEMA) {
      // Future migrations go here.
      localStorage.setItem(KEY_VERSION, String(CURRENT_SCHEMA));
    }
  }

  // ─── Deals ─────────────────────────────────────────────────────────
  function getDeals() {
    return safeRead(KEY_DEALS, []);
  }

  function setDeals(deals) {
    return safeWrite(KEY_DEALS, deals || []);
  }

  function generateDealId() {
    var ts = Date.now().toString(36).toUpperCase();
    var rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'ELI-HK-' + ts.slice(-6) + rand;
  }

  function addDeal(deal) {
    var deals = getDeals();
    deal.id = deal.id || generateDealId();
    deal.createdAt = deal.createdAt || new Date().toISOString();
    deals.push(deal);
    setDeals(deals);
    return deal;
  }

  function updateDeal(dealId, updates) {
    var deals = getDeals();
    var idx = -1;
    for (var i = 0; i < deals.length; i++) {
      if (deals[i].id === dealId) { idx = i; break; }
    }
    if (idx === -1) return null;
    deals[idx] = Object.assign({}, deals[idx], updates, { updatedAt: new Date().toISOString() });
    setDeals(deals);
    return deals[idx];
  }

  function deleteDeal(dealId) {
    var deals = getDeals();
    var next = deals.filter(function (d) { return d.id !== dealId; });
    setDeals(next);
    return next.length !== deals.length;
  }

  function replaceAllDeals(deals) {
    // Used by Import to wipe and reload cleanly.
    setDeals(deals || []);
  }

  // ─── Settings ──────────────────────────────────────────────────────
  var DEFAULT_SETTINGS = {
    refreshInterval: 14400000, // 4 hours
    lastRefresh: null,
    finnhubApiKey: '',         // optional user-supplied
    alertThresholdPct: 10,
    currencyDisplay: 'hkd'
  };

  function getSettings() {
    var s = safeRead(KEY_SETTINGS, null);
    if (!s) return Object.assign({}, DEFAULT_SETTINGS);
    // Merge defaults so new fields appear for existing users.
    return Object.assign({}, DEFAULT_SETTINGS, s);
  }

  function setSettings(partial) {
    var merged = Object.assign({}, getSettings(), partial || {});
    return safeWrite(KEY_SETTINGS, merged);
  }

  // ─── Price cache (TTL-based) ────────────────────────────────────────
  var PRICE_TTL_MS = 180 * 1000; // 3 min

  function getPriceCache() {
    return safeRead(KEY_PRICE_CACHE, {});
  }

  function getCachedPrice(symbol) {
    var cache = getPriceCache();
    var entry = cache[symbol];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PRICE_TTL_MS) return null;
    return entry.price;
  }

  function setCachedPrice(symbol, price) {
    var cache = getPriceCache();
    cache[symbol] = { price: price, timestamp: Date.now() };
    // Trim very-old entries to keep storage tidy.
    var cutoff = Date.now() - PRICE_TTL_MS * 4;
    Object.keys(cache).forEach(function (k) {
      if (cache[k].timestamp < cutoff) delete cache[k];
    });
    safeWrite(KEY_PRICE_CACHE, cache);
  }

  function clearPriceCache() {
    localStorage.removeItem(KEY_PRICE_CACHE);
  }

  // ─── Bulk import/export helpers ────────────────────────────────────
  function exportAll() {
    return {
      schemaVersion: CURRENT_SCHEMA,
      exportedAt: new Date().toISOString(),
      deals: getDeals(),
      settings: getSettings()
    };
  }

  function importAll(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid import payload');
    }
    if (Array.isArray(payload.deals)) {
      setDeals(payload.deals);
    }
    if (payload.settings && typeof payload.settings === 'object') {
      setSettings(payload.settings);
    }
  }

  ensureSchema();

  global.Storage = {
    // deals
    getDeals: getDeals,
    setDeals: setDeals,
    addDeal: addDeal,
    updateDeal: updateDeal,
    deleteDeal: deleteDeal,
    replaceAllDeals: replaceAllDeals,
    // settings
    getSettings: getSettings,
    setSettings: setSettings,
    // price cache
    getCachedPrice: getCachedPrice,
    setCachedPrice: setCachedPrice,
    clearPriceCache: clearPriceCache,
    // bulk
    exportAll: exportAll,
    importAll: importAll
  };
})(window);