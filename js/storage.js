/**
 * Storage facade.
 *
 * The UI calls these methods synchronously and they return from an
 * in-memory cache that mirrors SQLite. Writes go through the cache
 * immediately (so the next read is correct) and then asynchronously
 * persist to both SQLite (js/db.js → OPFS) and localStorage (legacy
 * fallback / migration source).
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  app.js  ──>  Storage (this file)  ──>  in-memory cache    │
 *   │                              │                             │
 *   │                              ├─>  localStorage (sync)      │
 *   │                              └─>  Db (js/db.js → OPFS)     │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Migration:
 *   - On first init, if SQLite (OPFS) is empty but localStorage has
 *     deals, we lift the localStorage data into SQLite and keep
 *     localStorage in sync going forward.
 *   - If SQLite isn't available (sql.js failed to load), we run in
 *     localStorage-only mode and `Db.status().backend === 'failed'`.
 */
(function (global) {
  'use strict';

  var KEY_DEALS = 'eli_deals_v1';
  var KEY_SETTINGS = 'eli_settings_v1';
  var KEY_PRICE_CACHE = 'eli_price_cache_v1';
  var KEY_VERSION = 'eli_schema_version';
  var CURRENT_SCHEMA = 1;

  var DEFAULT_SETTINGS = {
    refreshInterval: 14400000, // 4 hours
    lastRefresh: null,
    finnhubApiKey: '',
    alertThresholdPct: 10,
    currencyDisplay: 'hkd'
  };

  // ── Sync helpers (localStorage only) ────────────────────────────────
  function safeRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function safeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  // ── In-memory cache (mirrors SQLite) ─────────────────────────────────
  var memDeals = [];
  var memSettings = Object.assign({}, DEFAULT_SETTINGS);
  var memPriceCache = {};
  var memReady = false;

  function ensureReady() {
    if (memReady) return;
    memReady = true;
    memDeals = safeRead(KEY_DEALS, []);
    memSettings = Object.assign({}, DEFAULT_SETTINGS, safeRead(KEY_SETTINGS, null) || {});
    memPriceCache = safeRead(KEY_PRICE_CACHE, {});
    // Schema bookkeeping (no migration needed yet)
    if (parseInt(localStorage.getItem(KEY_VERSION) || '0', 10) < CURRENT_SCHEMA) {
      localStorage.setItem(KEY_VERSION, String(CURRENT_SCHEMA));
    }
  }

  function backfillDealRuntime(d) {
    d.underlyingAssets = (d.underlyingAssets || []).map(function (a) {
      return Object.assign({ currentPrice: a.strikePrice }, a);
    });
    d.currentValue = typeof d.currentValue === 'number' ? d.currentValue : d.purchasePrice || 0;
    d.pnl = typeof d.pnl === 'number' ? d.pnl : 0;
    return d;
  }

  function syncMemDealsFromArray(arr) {
    memDeals = (arr || []).map(backfillDealRuntime);
  }

  // ── Async backend sync (fire-and-forget) ─────────────────────────────
  var pendingFlushes = [];
  function asyncPersistDeals() {
    var snapshot = JSON.parse(JSON.stringify(memDeals));
    safeWrite(KEY_DEALS, snapshot);
    if (global.Db && global.Db.ready) {
      var p = global.Db.ready().then(function () {
        if (global.Db && global.Db.saveDeals) return global.Db.saveDeals(snapshot);
      });
      pendingFlushes.push(p);
    }
  }
  function asyncPersistSettings() {
    safeWrite(KEY_SETTINGS, memSettings);
  }
  function asyncPersistPriceCache() {
    safeWrite(KEY_PRICE_CACHE, memPriceCache);
  }

  // Resolve when all pending backend writes complete.
  function flush() {
    return Promise.all(pendingFlushes.slice()).catch(function () { /* per-write failures are non-fatal */ });
  }

  // Re-pull from the SQLite backend into the in-memory cache.
  // Useful after Db.clearAll() or Db.importFile() to keep cache in sync.
  async function refresh() {
    if (!global.Db) return;
    try {
      await global.Db.ready();
      var fromDb = global.Db.getDeals();
      syncMemDealsFromArray(fromDb || []);
      safeWrite(KEY_DEALS, memDeals);
    } catch (e) { /* ignore */ }
  }

  // ── Init / migration ────────────────────────────────────────────────
  async function init() {
    ensureReady();
    if (!global.Db || !global.Db.ready) return;
    try {
      await global.Db.ready();
      var fromDb = global.Db.getDeals();
      if (fromDb && fromDb.length > 0) {
        // SQLite is authoritative.
        syncMemDealsFromArray(fromDb);
        safeWrite(KEY_DEALS, memDeals);
      } else if (memDeals.length > 0) {
        // Migrate from localStorage into SQLite.
        await global.Db.saveDeals(memDeals);
      }
    } catch (e) { /* fall back to localStorage silently */ }
  }

  // ── Deals API ───────────────────────────────────────────────────────
  function getDeals() { ensureReady(); return memDeals.slice(); }
  function setDeals(deals) {
    ensureReady();
    syncMemDealsFromArray(deals);
    asyncPersistDeals();
  }
  function addDeal(deal) {
    ensureReady();
    deal.id = deal.id || ('ELI-HK' + String(Date.now()).slice(-6));
    deal.createdAt = deal.createdAt || new Date().toISOString();
    memDeals.push(deal);
    asyncPersistDeals();
    return deal;
  }
  function updateDeal(dealId, updates) {
    ensureReady();
    var idx = -1;
    for (var i = 0; i < memDeals.length; i++) {
      if (memDeals[i].id === dealId) { idx = i; break; }
    }
    if (idx === -1) return null;
    memDeals[idx] = Object.assign({}, memDeals[idx], updates, { updatedAt: new Date().toISOString() });
    asyncPersistDeals();
    return memDeals[idx];
  }
  function deleteDeal(dealId) {
    ensureReady();
    var before = memDeals.length;
    memDeals = memDeals.filter(function (d) { return d.id !== dealId; });
    var removed = memDeals.length !== before;
    if (removed) asyncPersistDeals();
    return removed;
  }
  function replaceAllDeals(deals) {
    ensureReady();
    syncMemDealsFromArray(deals);
    asyncPersistDeals();
  }

  // ── Settings API ────────────────────────────────────────────────────
  function getSettings() { ensureReady(); return Object.assign({}, memSettings); }
  function setSettings(partial) {
    ensureReady();
    memSettings = Object.assign({}, memSettings, partial || {});
    asyncPersistSettings();
  }

  // ── Price cache ─────────────────────────────────────────────────────
  var PRICE_TTL_MS = 180 * 1000;
  function getPriceCache() { ensureReady(); return memPriceCache; }
  function getCachedPrice(symbol) {
    ensureReady();
    var entry = memPriceCache[symbol];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PRICE_TTL_MS) return null;
    return entry.price;
  }
  function setCachedPrice(symbol, price) {
    ensureReady();
    memPriceCache[symbol] = { price: price, timestamp: Date.now() };
    var cutoff = Date.now() - PRICE_TTL_MS * 4;
    Object.keys(memPriceCache).forEach(function (k) {
      if (memPriceCache[k].timestamp < cutoff) delete memPriceCache[k];
    });
    asyncPersistPriceCache();
  }
  function clearPriceCache() {
    ensureReady();
    memPriceCache = {};
    asyncPersistPriceCache();
  }

  // ── Bulk export / import ────────────────────────────────────────────
  function exportAll() {
    ensureReady();
    return {
      schemaVersion: CURRENT_SCHEMA,
      exportedAt: new Date().toISOString(),
      deals: memDeals,
      settings: memSettings
    };
  }

  function importAll(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid import payload');
    }
    if (Array.isArray(payload.deals)) replaceAllDeals(payload.deals);
    if (payload.settings && typeof payload.settings === 'object') setSettings(payload.settings);
  }

  // ── Database (real .db file) export / import ───────────────────────
  async function exportDatabaseFile() {
    if (!global.Db) return null;
    return await global.Db.exportFile();
  }

  async function importDatabaseFile(bytes) {
    if (!global.Db) throw new Error('SQLite layer not loaded');
    var n = await global.Db.importFile(bytes);
    memDeals = global.Db.getDeals();
    safeWrite(KEY_DEALS, memDeals);
    return n;
  }

  function dbStatus() {
    return global.Db ? global.Db.status() : { backend: 'unavailable', ready: false };
  }

  // ── Init on load ────────────────────────────────────────────────────
  // Fire-and-forget so app.js's init() doesn't need to await us.
  init();

  global.Storage = {
    getDeals: getDeals,
    setDeals: setDeals,
    addDeal: addDeal,
    updateDeal: updateDeal,
    deleteDeal: deleteDeal,
    replaceAllDeals: replaceAllDeals,
    getSettings: getSettings,
    setSettings: setSettings,
    getCachedPrice: getCachedPrice,
    setCachedPrice: setCachedPrice,
    clearPriceCache: clearPriceCache,
    exportAll: exportAll,
    importAll: importAll,
    exportDatabaseFile: exportDatabaseFile,
    importDatabaseFile: importDatabaseFile,
    dbStatus: dbStatus,
    flush: flush,
    refresh: refresh
  };
})(window);