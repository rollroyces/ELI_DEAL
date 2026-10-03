/**
 * SQLite-backed persistent storage for HK ELI Portfolio Manager.
 *
 * Architecture
 * ────────────
 *   1. sql.js (SQLite compiled to WebAssembly) gives us a real SQL database
 *      that runs entirely in the browser.
 *   2. The whole DB is held in memory as a `Database` object.
 *   3. After every successful mutation we serialize the in-memory DB to
 *      the browser's Origin Private File System (OPFS) at `HK_ELI.db`.
 *      OPFS is browser-managed, survives reload / close / reboot, and is
 *      not exposed to the user (no quota prompts like localStorage).
 *   4. Users can also export the in-memory DB as a real `.db` file
 *      (downloadable, openable in DB Browser for SQLite, sqlite3 CLI,
 *      DBeaver, etc.) and import any compatible .db file back in.
 *
 * What if OPFS or sql.js aren't available?
 * ─────────────────────────────────────────
 *   - Safari (currently) doesn't support OPFS → DB still works in-memory
 *     for the session, exports/imports still work via the file system.
 *   - If sql.js fails to load (no network, blocked wasm), `Storage`
 *     falls back to localStorage and the user sees a banner. None of
 *     the UI breaks — it's a graceful degradation.
 *
 * Public API (mirrors the localStorage layer in storage.js):
 *   Db.ready                  Promise — resolves when sql.js + OPFS are ready
 *   Db.getDeals()             Array  — all deals (sync, served from cache)
 *   Db.saveDeals(deals)       — replace all deals (async; flushes to OPFS)
 *   Db.exportFile()           Uint8Array — current DB as .db bytes
 *   Db.importFile(bytes)      Promise — replace DB with new bytes
 *   Db.status()               { backend: 'opfs'|'memory'|'failed', size }
 *
 * The exact same SQL schema can be loaded into sqlite3 CLI or any GUI
 * tool — see SCHEMA at the bottom of this file.
 */
(function (global) {
  'use strict';

  var SQL = null;                    // sql.js module reference
  var db = null;                     // active SQL.Database instance
  var opfsRoot = null;               // navigator.storage.getDirectory() handle
  var useOpfs = false;               // whether OPFS persistence is enabled
  var dbReady = null;                // singleton init promise
  var lastError = null;              // surfaced for status reporting
  var inMemoryDeals = [];            // synchronous cache for the UI

  var OPFS_FILENAME = 'HK_ELI.db';
  var SCHEMA =
    'CREATE TABLE IF NOT EXISTS deals (' +
        'id TEXT PRIMARY KEY,' +
        'deal_name TEXT NOT NULL,' +
        'investment_date TEXT NOT NULL,' +
        'maturity_date TEXT NOT NULL,' +
        'nominal_amount REAL NOT NULL,' +
        'purchase_price REAL NOT NULL,' +
        'number_of_stocks INTEGER NOT NULL,' +
        'coupon_rate REAL NOT NULL,' +
        'settlement_method TEXT NOT NULL,' +
        'issuer TEXT NOT NULL,' +
        'status TEXT NOT NULL DEFAULT "Active",' +
        'current_value REAL DEFAULT 0,' +
        'pnl REAL DEFAULT 0,' +
        'created_at TEXT,' +
        'updated_at TEXT' +
      ');' +
      'CREATE TABLE IF NOT EXISTS deal_assets (' +
        'deal_id TEXT NOT NULL,' +
        'symbol TEXT NOT NULL,' +
        'name TEXT NOT NULL,' +
        'strike_price REAL NOT NULL,' +
        'barrier_level REAL NOT NULL,' +
        'weight REAL NOT NULL,' +
        'current_price REAL,' +
        'FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE' +
      ');' +
      'CREATE TABLE IF NOT EXISTS settings (' +
        'key TEXT PRIMARY KEY,' +
        'value TEXT' +
      ');' +
      'CREATE TABLE IF NOT EXISTS price_cache (' +
        'symbol TEXT PRIMARY KEY,' +
        'price REAL,' +
        'timestamp INTEGER' +
      ');';

  // ── sql.js loader (CDN, with graceful failure) ─────────────────────
  function loadSqlJs() {
    if (SQL) return Promise.resolve(SQL);
    if (global.initSqlJs) {
      // Already loaded via <script> tag in index.html.
      return global.initSqlJs({
        locateFile: function (f) { return 'https://cdn.jsdelivr.net/npm/sql.js@1.10/dist/' + f; }
      }).then(function (s) { SQL = s; return SQL; });
    }
    // Fallback: inject the script tag ourselves.
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/sql.js@1.10/dist/sql-wasm.js';
      s.onload = function () {
        if (!global.initSqlJs) return reject(new Error('initSqlJs missing after load'));
        global.initSqlJs({
          locateFile: function (f) { return 'https://cdn.jsdelivr.net/npm/sql.js@1.10/dist/' + f; }
        }).then(function (s2) { SQL = s2; resolve(SQL); }, reject);
      };
      s.onerror = function () { reject(new Error('Failed to load sql.js from CDN')); };
      document.head.appendChild(s);
    });
  }

  // ── OPFS helpers ───────────────────────────────────────────────────
  async function tryGetOpfsRoot() {
    if (!global.navigator || !global.navigator.storage || !global.navigator.storage.getDirectory) {
      return null;
    }
    try {
      return await global.navigator.storage.getDirectory();
    } catch (e) {
      lastError = e;
      return null;
    }
  }

  async function readOpfsBytes() {
    if (!opfsRoot) return null;
    try {
      var fh = await opfsRoot.getFileHandle(OPFS_FILENAME, { create: false });
      var file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      // File doesn't exist yet — first run.
      return null;
    }
  }

  async function writeOpfsBytes(bytes) {
    if (!opfsRoot) return;
    try {
      var fh = await opfsRoot.getFileHandle(OPFS_FILENAME, { create: true });
      var w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
    } catch (e) {
      lastError = e;
    }
  }

  // ── DB row helpers ─────────────────────────────────────────────────
  function rowToDeal(row) {
    return {
      id: row[0],
      dealName: row[1],
      investmentDate: row[2],
      maturityDate: row[3],
      nominalAmount: row[4],
      purchasePrice: row[5],
      numberOfStocks: row[6],
      couponRate: row[7],
      settlementMethod: row[8],
      issuer: row[9],
      status: row[10],
      currentValue: row[11],
      pnl: row[12],
      createdAt: row[13],
      updatedAt: row[14]
    };
  }

  function assetsRowsFor(dealId) {
    var stmt = db.prepare('SELECT symbol, name, strike_price, barrier_level, weight, current_price FROM deal_assets WHERE deal_id = ?');
    stmt.bind([dealId]);
    var assets = [];
    while (stmt.step()) assets.push({
      symbol: stmt.get()[0],
      name: stmt.get()[1],
      strikePrice: stmt.get()[2],
      barrierLevel: stmt.get()[3],
      weight: stmt.get()[4],
      currentPrice: stmt.get()[5]
    });
    stmt.free();
    return assets;
  }

  function reloadInMemoryCache() {
    if (!db) { inMemoryDeals = []; return; }
    var res = db.exec('SELECT id, deal_name, investment_date, maturity_date, nominal_amount, purchase_price, number_of_stocks, coupon_rate, settlement_method, issuer, status, current_value, pnl, created_at, updated_at FROM deals ORDER BY created_at ASC, id ASC');
    var rows = (res[0] && res[0].values) || [];
    inMemoryDeals = rows.map(function (r) {
      var deal = rowToDeal(r);
      deal.underlyingAssets = assetsRowsFor(deal.id);
      return deal;
    });
  }

  function syncDealToDb(deal) {
    db.run(
      'INSERT OR REPLACE INTO deals ' +
      '(id, deal_name, investment_date, maturity_date, nominal_amount, purchase_price, number_of_stocks, coupon_rate, settlement_method, issuer, status, current_value, pnl, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [deal.id, deal.dealName, deal.investmentDate, deal.maturityDate,
       deal.nominalAmount, deal.purchasePrice, deal.numberOfStocks,
       deal.couponRate, deal.settlementMethod, deal.issuer,
       deal.status || 'Active', deal.currentValue || 0, deal.pnl || 0,
       deal.createdAt || new Date().toISOString(),
       deal.updatedAt || new Date().toISOString()]
    );
    db.run('DELETE FROM deal_assets WHERE deal_id = ?', [deal.id]);
    (deal.underlyingAssets || []).forEach(function (a) {
      db.run(
        'INSERT INTO deal_assets (deal_id, symbol, name, strike_price, barrier_level, weight, current_price) VALUES (?,?,?,?,?,?,?)',
        [deal.id, a.symbol, a.name, a.strikePrice, a.barrierLevel, a.weight, a.currentPrice || null]
      );
    });
  }

  function replaceAllDealsInDb(deals) {
    db.run('DELETE FROM deal_assets');
    db.run('DELETE FROM deals');
    (deals || []).forEach(syncDealToDb);
  }

  function exportBytes() { return db.export(); }

  async function flushToOpfs() {
    if (!useOpfs) return;
    try {
      await writeOpfsBytes(exportBytes());
    } catch (e) {
      lastError = e;
    }
  }

  // ── Init ───────────────────────────────────────────────────────────
  function init() {
    if (dbReady) return dbReady;
    dbReady = (async function () {
      try {
        opfsRoot = await tryGetOpfsRoot();
        var SQLmod = await loadSqlJs();
        var existing = opfsRoot ? await readOpfsBytes() : null;
        if (existing && existing.length > 0) {
          db = new SQLmod.Database(existing);
          useOpfs = !!opfsRoot;
        } else {
          db = new SQLmod.Database();
          db.run(SCHEMA);
          useOpfs = !!opfsRoot;
          if (useOpfs) await flushToOpfs();
        }
      } catch (e) {
        // sql.js failed — DB will be unusable; caller should fall back.
        lastError = e;
        db = null;
        useOpfs = false;
      }
      reloadInMemoryCache();
    })();
    return dbReady;
  }

  // ── Public API ─────────────────────────────────────────────────────
  async function saveDeals(deals) {
    await init();
    if (!db) return false;
    try {
      db.run('BEGIN');
      replaceAllDealsInDb(deals);
      db.run('COMMIT');
      reloadInMemoryCache();
      await flushToOpfs();
      return true;
    } catch (e) {
      try { db.run('ROLLBACK'); } catch (_) {}
      lastError = e;
      return false;
    }
  }

  async function exportFile() {
    await init();
    if (!db) return null;
    return exportBytes();
  }

  async function importFile(bytes) {
    await init();
    if (!db || !SQL) throw new Error('SQLite not available');
    var SQLmod = SQL;
    var newDb = new SQLmod.Database(bytes);
    // Sanity-check: must contain a `deals` table.
    var tables = newDb.exec("SELECT name FROM sqlite_master WHERE type='table'");
    var names = (tables[0] && tables[0].values || []).map(function (r) { return r[0]; });
    if (names.indexOf('deals') === -1) {
      throw new Error('Not a valid HK ELI database (no `deals` table).');
    }
    db.close();
    db = newDb;
    reloadInMemoryCache();
    await flushToOpfs();
    return inMemoryDeals.length;
  }

  // Wipe everything back to an empty schema.
  async function clearAll() {
    await init();
    if (!db || !SQL) return false;
    db.close();
    db = new SQL.Database();
    db.run(SCHEMA);
    reloadInMemoryCache();
    await flushToOpfs();
    return true;
  }

  // ── Price cache helpers ────────────────────────────────────────────────
  // Returns { symbol -> { price, ageMs } } for any cached symbols.
  // Use ageMs to decide whether the cache is still fresh enough.
  async function getCachedPrices(symbols) {
    await init();
    if (!db || !symbols || symbols.length === 0) return {};
    try {
      var placeholders = symbols.map(function () { return '?'; }).join(',');
      var stmt = db.prepare(
        'SELECT symbol, price, timestamp FROM price_cache WHERE symbol IN (' + placeholders + ')'
      );
      stmt.run(symbols);
      var out = {};
      var now = Date.now();
      while (stmt.step()) {
        var sym = stmt.getString(0);
        var price = stmt.getValue(1);
        var ts = stmt.getValue(2);
        out[sym] = { price: price, ageMs: now - ts };
      }
      stmt.free();
      return out;
    } catch (e) {
      console.error('getCachedPrices failed:', e);
      return {};
    }
  }

  async function setCachedPrices(prices) {
    await init();
    if (!db || !prices) return false;
    try {
      var syms = Object.keys(prices).filter(function (s) {
        return typeof prices[s] === 'number';
      });
      if (syms.length === 0) return true;
      var now = Date.now();
      syms.forEach(function (sym) {
        var sub = db.prepare(
          'INSERT OR REPLACE INTO price_cache (symbol, price, timestamp) VALUES (?, ?, ?)'
        );
        try {
          sub.run([sym, prices[sym], now]);
        } catch (e) {
          console.warn('setCachedPrices row failed for', sym, e);
        } finally {
          try { sub.free(); } catch (_) {}
        }
      });
      await flushToOpfs();
      return true;
    } catch (e) {
      console.error('setCachedPrices failed:', e);
      return false;
    }
  }

  function clearCachedPrices() {
    if (!db) return;
    try { db.run('DELETE FROM price_cache'); } catch (e) {}
  }

  function status() {
    return {
      backend: !db ? 'failed' : (useOpfs ? 'opfs' : 'memory'),
      ready: !!db,
      dealCount: inMemoryDeals.length,
      error: lastError ? (lastError.message || String(lastError)) : null
    };
  }

  function getDeals() { return inMemoryDeals.slice(); }

  global.Db = {
    ready: init,
    saveDeals: saveDeals,
    getDeals: getDeals,
    exportFile: exportFile,
    importFile: importFile,
    clearAll: clearAll,
    getCachedPrices: getCachedPrices,
    setCachedPrices: setCachedPrices,
    clearCachedPrices: clearCachedPrices,
    status: status,
    schemaSQL: SCHEMA
  };
})(window);