/**
 * Watchlist — track stocks you don't have a deal for.
 *
 * Stored as a separate key in localStorage / SQLite. Each entry:
 *   { symbol, addedAt, targetEntry, note }
 *
 * Pure helpers plus a small CRUD API. The UI reuses Payoff.maxDrawdown
 * and the existing chart primitives for any analytics on watchlist items.
 *
 * @file js/watchlist.js
 */
(function (global) {
  'use strict';

  var KEY = 'eli_watchlist_v1';

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
    if (global.Db && typeof Db.saveWatchlist === 'function') {
      Db.saveWatchlist(list).catch(function () {});
    }
  }

  /**
   * @typedef {Object} WatchEntry
   * @property {string} symbol
   * @property {number} addedAt
   * @property {number|null} [targetEntry]   desired entry price (HK$)
   * @property {string} [note]
   */

  function list() { return read(); }

  function add(entry) {
    if (!entry || !entry.symbol) return null;
    var sym = String(entry.symbol).trim().toUpperCase();
    var list = read();
    var existing = list.find(function (e) { return e.symbol === sym; });
    if (existing) {
      existing.targetEntry = entry.targetEntry || existing.targetEntry || null;
      existing.note = entry.note || existing.note || '';
    } else {
      list.push({
        symbol: sym,
        addedAt: Date.now(),
        targetEntry: entry.targetEntry || null,
        note: entry.note || ''
      });
    }
    write(list);
    return list.find(function (e) { return e.symbol === sym; });
  }

  function remove(symbol) {
    var sym = String(symbol).trim().toUpperCase();
    var list = read().filter(function (e) { return e.symbol !== sym; });
    write(list);
    return list;
  }

  function get(symbol) {
    var sym = String(symbol).trim().toUpperCase();
    return read().find(function (e) { return e.symbol === sym; }) || null;
  }

  /**
   * Bulk-import an array of { symbol, targetEntry?, note? } entries.
   * Existing entries are updated; new ones are appended.
   * Returns the resulting list.
   */
  function bulkImport(entries) {
    (entries || []).forEach(function (e) { add(e); });
    return read();
  }

  global.Watchlist = {
    list: list,
    get: get,
    add: add,
    remove: remove,
    bulkImport: bulkImport
  };
})(window);