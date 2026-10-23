// HK ELI Portfolio Manager — Browser-only edition (GitHub Pages friendly).
//
// This is a from-scratch rewrite of the original app.js that removes all
// Flask / MySQL backend calls. Data lives in localStorage; prices come
// from Yahoo Finance (with optional Finnhub fallback). See README.md.
//
// Modules used (loaded before this file):
//   window.Storage      — localStorage wrapper for deals/settings/cache
//   window.YahooFinance — direct fetch to Yahoo Finance chart endpoint
//   window.Finnhub      — optional fallback when user provides an API key
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // Global application state
  // ──────────────────────────────────────────────────────────────────
  window.HKELIApp = {
    data: {
      hkStocks: [
        {symbol: "0700.HK", name: "Tencent Holdings Ltd"},
        {symbol: "9988.HK", name: "Alibaba Group"},
        {symbol: "0005.HK", name: "HSBC Holdings"},
        {symbol: "0941.HK", name: "China Mobile"},
        {symbol: "1810.HK", name: "Xiaomi Corp"},
        {symbol: "0016.HK", name: "Sun Hung Kai Properties"},
        {symbol: "2388.HK", name: "BOC Hong Kong"},
        {symbol: "1299.HK", name: "AIA Group"},
        {symbol: "0001.HK", name: "CK Hutchison Holdings"},
        {symbol: "0002.HK", name: "CLP Holdings"},
        {symbol: "0003.HK", name: "HK & China Gas"},
        {symbol: "0006.HK", name: "Power Assets"},
        {symbol: "0011.HK", name: "Hang Seng Bank"},
        {symbol: "0017.HK", name: "New World Development"},
        {symbol: "0027.HK", name: "Galaxy Entertainment"},
        {symbol: "0066.HK", name: "MTR Corporation"},
        {symbol: "0175.HK", name: "Geely Auto"},
        {symbol: "0388.HK", name: "Hong Kong Exchanges & Clearing"},
        {symbol: "0939.HK", name: "China Construction Bank"},
        {symbol: "0981.HK", name: "SMIC"},
        {symbol: "1928.HK", name: "Sands China"},
        {symbol: "2318.HK", name: "Ping An Insurance"},
        {symbol: "3690.HK", name: "Meituan"},
        {symbol: "0386.HK", name: "Sinopec Corp"},
        {symbol: "2883.HK", name: "China Oilfield Services Limited"},
        {symbol: "0857.HK", name: "PetroChina Co Ltd"},
        {symbol: "2800.HK", name: "Tracker Fund of Hong Kong"},
        {symbol: "2822.HK", name: "CSOP FTSE China A50 ETF"},
        {symbol: "2823.HK", name: "iShares FTSE China A50 ETF"}
      ],
      eliDeals: [],
      alerts: [],
      settings: {
        refreshInterval: 14400000,  // 4 hours
        lastRefresh: null,
        finnhubApiKey: ''
      },
      apiStatus: {
        connected: false,
        lastSuccessfulRefresh: null,
        lastError: null,
        source: 'idle'  // 'yahoo' | 'finnhub' | 'cache' | 'none'
      }
    },
    currentView: 'dashboard',
    editingDealId: null,
    deletingDealId: null,
    filteredDeals: [],
    charts: {},
    refreshTimer: null
  };

  // ──────────────────────────────────────────────────────────────────
  // Persistence helpers (thin wrappers over Storage that also keep the
  // in-memory data object in sync and handle UI re-render side-effects)
  // ──────────────────────────────────────────────────────────────────
  function persistDeals() {
    Storage.setDeals(HKELIApp.data.eliDeals);
  }

  function loadDealsIntoState() {
    var saved = Storage.getDeals();
    if (!Array.isArray(saved)) saved = [];
    // Backfill any missing runtime fields so the UI doesn't blow up.
    saved.forEach(function (deal) {
      deal.underlyingAssets = (deal.underlyingAssets || []).map(function (a) {
        return Object.assign({ currentPrice: a.strikePrice }, a);
      });
      deal.currentValue = typeof deal.currentValue === 'number' ? deal.currentValue : deal.purchasePrice || 0;
      deal.pnl = typeof deal.pnl === 'number' ? deal.pnl : 0;
    });
    HKELIApp.data.eliDeals = saved;
  }

  function getCurrentSettings() {
    return Object.assign({}, HKELIApp.data.settings, Storage.getSettings());
  }

  // ──────────────────────────────────────────────────────────────────
  // Formatting / utility helpers (unchanged from original)
  // ──────────────────────────────────────────────────────────────────
  function formatCurrency(amount) {
    return 'HK$' + Math.round(amount).toLocaleString();
  }

  // ──────────────────────────────────────────────────────────────────
  // Multi-currency display
  // Uses Fx.convert() with a cached rate; falls back to HKD on error.
  // ──────────────────────────────────────────────────────────────────
  var _displayRate = 1;            // HKD per display unit
  var _displayCode = 'HKD';
  var _displaySymbol = 'HK$';

  function setDisplayCurrency(code) {
    code = (code || 'HKD').toUpperCase();
    var syms = { HKD: 'HK$', USD: 'US$', CNY: '¥', EUR: '€', JPY: '¥', GBP: '£' };
    _displayCode = code;
    _displaySymbol = syms[code] || code + ' ';
    if (code === 'HKD') {
      _displayRate = 1;
      Storage.setSettings({ displayCurrency: 'HKD' });
      refreshAllAmounts();
      return;
    }
    if (window.Fx && typeof Fx.getRate === 'function') {
      Fx.getRate(code).then(function (r) {
        _displayRate = r.rate;
        Storage.setSettings({ displayCurrency: code });
        refreshAllAmounts();
      }).catch(function () {
        // Fallback already provided by Fx; just refresh.
        refreshAllAmounts();
      });
    }
  }

  function formatCurrency(hkdAmount) {
    if (typeof hkdAmount !== 'number' || !isFinite(hkdAmount)) return '—';
    var v = hkdAmount * _displayRate;
    // JPY and CNY typically displayed without fractional units.
    var noDecimals = (_displayCode === 'JPY' || _displayCode === 'CNY');
    var text = noDecimals
      ? Math.round(v).toLocaleString()
      : v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return _displaySymbol + text;
  }

  // Re-render every view that shows an amount. Lightweight: just calls
  // the same render functions that fire when a deal is mutated.
  function refreshAllAmounts() {
    var s = getCurrentSettings();
    _displayRate = (s.displayCurrency && s.displayCurrency !== 'HKD') ? _displayRate : 1;
    // Update static dashboard elements
    updatePortfolioSummary();
    if (HKELIApp.currentView === 'deals') renderDeals();
    else if (HKELIApp.currentView === 'analytics') setTimeout(setupCharts, 50);
    else if (HKELIApp.currentView === 'payoff') renderPayoffView();
    else if (HKELIApp.currentView === 'scenarios') renderScenariosView();
    else if (HKELIApp.currentView === 'calendar') renderCalendarView();
  }
  function formatHKPrice(amount, decimals) {
    decimals = typeof decimals === 'number' ? decimals : 4;
    var num = Number(amount);
    if (!isFinite(num)) return 'HK$0.0000';
    return 'HK$' + num.toFixed(decimals);
  }
  function formatTimeAgo(timestamp) {
    var diffInMinutes = Math.floor((Date.now() - new Date(timestamp)) / 60000);
    if (diffInMinutes < 60) return diffInMinutes + 'm ago';
    if (diffInMinutes < 1440) return Math.floor(diffInMinutes / 60) + 'h ago';
    return Math.floor(diffInMinutes / 1440) + 'd ago';
  }
  function calculateDaysToMaturity(maturityDate) {
    var diffTime = new Date(maturityDate) - new Date();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  function showToast(message, type, title) {
    type = type || 'info';
    title = title || ({success: 'Success', error: 'Error', warning: 'Warning'})[type] || 'Notification';
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toastId = 'toast-' + Date.now();
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.id = toastId;
    toast.innerHTML =
      '<div class="toast-header">' +
        '<span class="toast-title">' + title + '</span>' +
        '<button class="toast-close" onclick="document.getElementById(\'' + toastId + '\').remove()">×</button>' +
      '</div>' +
      '<p class="toast-message">' + message + '</p>';
    container.appendChild(toast);
    setTimeout(function () {
      var el = document.getElementById(toastId);
      if (!el) return;
      el.classList.add('removing');
      setTimeout(function () {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }, 5000);
  }

  // ──────────────────────────────────────────────────────────────────
  // Price cache TTLs (tunable)
  // ──────────────────────────────────────────────────────────────────
  var CACHE_FRESH_MS = 2 * 60 * 60 * 1000;     // 2 h — call this "fresh", skip API
  var CACHE_STALE_MS = 8 * 60 * 60 * 1000;     // 8 h — show but warn, try API

  function describeAge(ageMs) {
    if (ageMs == null) return 'never';
    var mins = Math.round(ageMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.round(hrs / 24);
    return days + 'd ago';
  }

  // ──────────────────────────────────────────────────────────────────
  // REWRITTEN: price refresh (SQLite cache → Yahoo → Finnhub)
  // ──────────────────────────────────────────────────────────────────
  async function refreshPrices(opts) {
    opts = opts || {};
    var force = !!opts.force;   // bypass cache if true (manual Refresh Now)
    console.log(force ? 'Force-refreshing from API…' : 'Refreshing prices (cache-aware)…');
    var refreshBtn = document.getElementById('manual-refresh');
    if (refreshBtn) {
      refreshBtn.classList.add('loading');
      refreshBtn.disabled = true;
    }

    try {
      // Collect unique symbols across all deals
      var seen = Object.create(null);
      var symbols = [];
      HKELIApp.data.eliDeals.forEach(function (deal) {
        (deal.underlyingAssets || []).forEach(function (asset) {
          if (asset.symbol && !seen[asset.symbol]) {
            seen[asset.symbol] = true;
            symbols.push(asset.symbol);
          }
        });
      });
      if (symbols.length === 0) {
        showToast('No underlying assets to refresh', 'info');
        return;
      }

      // Step 1: SQLite price cache — pre-populate `prices` with anything < 30 min old
      var prices = {};
      var freshFromCache = 0;
      var staleFromCache = 0;
      try {
        var cached = await Db.getCachedPrices(symbols);
        Object.keys(cached).forEach(function (sym) {
          var entry = cached[sym];
          if (entry && typeof entry.price === 'number' && entry.ageMs < CACHE_FRESH_MS && !force) {
            prices[sym] = entry.price;
            freshFromCache++;
          } else if (entry && typeof entry.price === 'number') {
            staleFromCache++;
          }
        });
      } catch (e) { /* ignore cache errors */ }

      // Step 3: Yahoo Finance — only for symbols NOT fresh in cache
      var needApi = symbols.filter(function (s) { return !(s in prices); });
      if (needApi.length > 0) {
        console.log('API call for', needApi.length, 'of', symbols.length, 'symbols (others fresh in cache)');
        var live = await YahooFinance.getQuotes(needApi, { delay: 200 });
        Object.keys(live).forEach(function (sym) {
          if (typeof live[sym] === 'number') prices[sym] = live[sym];
        });
        // Persist any newly-fetched prices to SQLite
        Db.setCachedPrices(live).catch(function () {});
        // Record daily snapshots for price history (used by max-drawdown
        // + the Payoff view's per-symbol chart).
        if (typeof Db.recordSnapshots === 'function') {
          Db.recordSnapshots(live, 'yahoo').catch(function (e) {
            console.warn('recordSnapshots failed', e);
          });
        }
      }

      var failed = symbols.filter(function (s) { return prices[s] == null; });
      var sourceStats = { yahoo: freshFromCache, finnhub: 0, manual: 0, missing: failed.length };

      // Step 4: Finnhub fallback for any remaining symbols (requires user API key)
      var finnhubFilled = {};
      if (failed.length && window.Finnhub && Finnhub.hasKey()) {
        console.log('Yahoo missed', failed.length, 'symbols; trying Finnhub…');
        for (var i = 0; i < failed.length; i++) {
          try {
            var p = await Finnhub.getQuote(failed[i]);
            if (p != null) {
              prices[failed[i]] = p;
              finnhubFilled[failed[i]] = p;
              sourceStats.finnhub++;
              failed.splice(i, 1);
              i--;
            }
          } catch (e) { /* keep null */ }
        }
        if (typeof Db.recordSnapshots === 'function' && Object.keys(finnhubFilled).length) {
          Db.recordSnapshots(finnhubFilled, 'finnhub').catch(function (e) {
            console.warn('recordSnapshots (finnhub) failed', e);
          });
        }
      }
      sourceStats.missing = failed.length;

      // Step 5: Apply prices + recompute deal metrics
      var updated = 0, missing = 0;
      HKELIApp.data.eliDeals.forEach(function (deal) {
        (deal.underlyingAssets || []).forEach(function (asset) {
          var np = prices[asset.symbol];
          if (typeof np === 'number') {
            asset.currentPrice = np;
            updated++;
          } else {
            missing++;
          }
          if (typeof asset.currentPrice !== 'number') {
            asset.currentPrice = asset.strikePrice; // safe fallback so UI doesn't NaN
          }
        });
        deal.currentValue = (deal.underlyingAssets || []).reduce(function (sum, a) {
          var effShares = (deal.purchasePrice || 0) / (a.strikePrice || 1);
          return sum + (a.currentPrice || 0) * effShares * (a.weight || 0);
        }, 0);
        deal.pnl = (deal.currentValue || 0) - (deal.purchasePrice || 0);
        updateDealStatus(deal);
      });
      persistDeals();
      rebuildAlertsFromState();
      rebuildCustomAlerts();

      var now = Date.now();
      HKELIApp.data.apiStatus.connected = updated > 0 || freshFromCache > 0;
      HKELIApp.data.apiStatus.lastSuccessfulRefresh = now;
      HKELIApp.data.apiStatus.lastError = failed.length ? (failed.length + ' symbols unavailable') : null;
      // Pick a primary source label for the connection indicator.
      var primarySource = updated > 0
        ? (sourceStats.finnhub > 0 ? 'finnhub' : 'yahoo')
        : (freshFromCache > 0 ? 'cache' : 'none');
      HKELIApp.data.apiStatus.source = primarySource;
      HKELIApp.data.apiStatus.sourceStats = {
        yahoo: sourceStats.yahoo + updated,
        finnhub: sourceStats.finnhub,
        manual: sourceStats.manual,
        cache: freshFromCache,
        missing: sourceStats.missing
      };
      HKELIApp.data.settings.lastRefresh = now;
      Storage.setSettings({ lastRefresh: now });

      renderDashboard();
      if (HKELIApp.currentView === 'deals') renderDeals();
      updateAPIStatus();
      if (HKELIApp.currentView === 'alerts') renderAlerts();
      updateRefreshDisplay();
      if (typeof updateRiskAnalytics === 'function') updateRiskAnalytics();

      // Status message — distinguish "all from cache" vs "fetched new"
      var parts = [];
      if (freshFromCache > 0) parts.push(freshFromCache + ' from cache');
      if (updated > 0) parts.push(updated + ' fetched');
      if (missing > 0) parts.push(missing + ' unavailable');
      var msg = parts.length
        ? 'Prices: ' + parts.join(', ')
        : 'No prices available';
      showToast(msg, missing > 0 ? 'warning' : 'success');
    } catch (err) {
      console.error('Price refresh failed:', err);
      HKELIApp.data.apiStatus.connected = false;
      HKELIApp.data.apiStatus.lastError = err.message;
      updateAPIStatus();
      showToast('Refresh failed: ' + err.message, 'error');
    } finally {
      if (refreshBtn) {
        refreshBtn.classList.remove('loading');
        refreshBtn.disabled = false;
      }
    }
  }

  function updateDealStatus(deal) {
    var hasKnockIn = false;
    (deal.underlyingAssets || []).forEach(function (a) {
      if (a.barrierLevel && a.currentPrice && a.currentPrice <= a.barrierLevel) {
        hasKnockIn = true;
      }
    });
    var daysToMat = calculateDaysToMaturity(deal.maturityDate);
    if (hasKnockIn) deal.status = 'Knock-in Triggered';
    else if (daysToMat <= 0) deal.status = 'Settled';
    else if (daysToMat <= 30) deal.status = 'Approaching Maturity';
    else deal.status = 'Active';
  }

  function updateAPIStatus() {
    var dot = document.getElementById('api-status-dot');
    var txt = document.getElementById('api-status-text');
    var last = document.getElementById('last-update');
    var stats = HKELIApp.data.apiStatus.sourceStats;
    if (dot && txt) {
      if (HKELIApp.data.apiStatus.connected) {
        dot.className = 'status-dot success';
        var sourceLabel = {
          yahoo: 'Yahoo',
          finnhub: 'Finnhub',
          cache: 'cache',
          none: 'cached data'
        }[HKELIApp.data.apiStatus.source] || 'Yahoo';
        var breakdown = stats ? ' (' + (stats.yahoo + stats.stooq + stats.finnhub) + ' fresh' +
          (stats.missing > 0 ? ', ' + stats.missing + ' missing' : '') + ')' : '';
        txt.textContent = 'Connected (' + sourceLabel + ')' + breakdown;
      } else {
        dot.className = 'status-dot error';
        txt.textContent = 'Offline (showing fallback prices)';
      }
    }
    if (last) {
      var t = HKELIApp.data.apiStatus.lastSuccessfulRefresh;
      last.textContent = t ? new Date(t).toLocaleTimeString() + ' HKT' : 'Never';
    }
    // Show the dashboard banner whenever prices failed in the last refresh
    var banner = document.getElementById('price-source-banner');
    if (banner) {
      var dismissed = false;
      try { dismissed = sessionStorage.getItem('eli_banner_dismissed') === '1'; } catch (_) {}
      var showBanner = !HKELIApp.data.apiStatus.connected && !dismissed
        && HKELIApp.data.eliDeals && HKELIApp.data.eliDeals.length > 0;
      banner.classList.toggle('hidden', !showBanner);
    }
  }

  // Test the price source from Settings → Price Source → Test button.
  async function testPriceSource() {
    var out = document.getElementById('price-source-probe');
    if (out) out.textContent = 'Probing Yahoo Finance…';
    var yf = await YahooFinance.probe();
    if (out) {
      out.style.background = yf.ok ? 'rgba(74, 222, 128, 0.1)' : 'rgba(248, 113, 113, 0.1)';
      out.innerHTML = yf.ok
        ? '✓ Yahoo Finance: ' + yf.message
        : '✗ Yahoo Finance: ' + yf.message;
    }
    if (!yf.ok && window.Finnhub && Finnhub.hasKey()) {
      if (out) out.innerHTML += '\n\nProbing Finnhub fallback…';
      var fh = await Finnhub.ping();
      if (out) {
        out.innerHTML += fh
          ? '\n✓ Finnhub: reachable (will be used as fallback for live prices)'
          : '\n✗ Finnhub: key set but API call failed';
      }
    } else if (!yf.ok) {
      if (out) {
        out.innerHTML += '\n\nNo Finnhub key set — paste one in the field above to enable the fallback.';
      }
    }
  }

  // REWRITTEN: liveness probe now pings Yahoo Finance directly.
  async function checkBackendHealth() {
    try {
      var ok = await YahooFinance.ping();
      HKELIApp.data.apiStatus.connected = ok;
      if (ok && !HKELIApp.data.apiStatus.lastSuccessfulRefresh) {
        HKELIApp.data.apiStatus.lastSuccessfulRefresh = Date.now();
      }
      HKELIApp.data.apiStatus.lastError = ok ? null : 'Yahoo Finance unreachable';
    } catch (e) {
      HKELIApp.data.apiStatus.connected = false;
      HKELIApp.data.apiStatus.lastError = e.message;
    } finally {
      updateAPIStatus();
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // REWRITTEN: load from localStorage (was: load from MySQL via Flask)
  // ──────────────────────────────────────────────────────────────────
  async function loadDealsFromDatabase() {
    loadDealsIntoState();
    refreshDealViews();
    reassignELIIds();
    renderDashboard();
    if (HKELIApp.currentView === 'deals') renderDeals();
    if (HKELIApp.currentView === 'alerts') renderAlerts();
    if (typeof updateRiskAnalytics === 'function') updateRiskAnalytics();
    showToast('Loaded ' + HKELIApp.data.eliDeals.length + ' deals from local storage', 'success');
    // Fire-and-forget price refresh so the dashboard comes alive.
    refreshPrices();
  }

  // REWRITTEN: "save" now exports a backup JSON file the user can keep.
  async function saveDealsToDatabase() {
    try {
      if (!HKELIApp.data.eliDeals || HKELIApp.data.eliDeals.length === 0) {
        showToast('No deals to back up', 'warning');
        return;
      }
      var payload = Storage.exportAll();
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'HK_ELI_Backup_' + new Date().toISOString().split('T')[0] + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Backup downloaded (' + HKELIApp.data.eliDeals.length + ' deals)', 'success');
    } catch (e) {
      console.error('Backup failed:', e);
      showToast('Backup failed: ' + e.message, 'error');
    }
  }

  function reassignELIIds() {
    // Compact IDs based on insertion order so the UI shows ELI-HK001..n.
    var sorted = HKELIApp.data.eliDeals.slice().sort(function (a, b) {
      var ad = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      if (ad !== 0) return ad;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    var idMap = new Map();
    sorted.forEach(function (deal, index) {
      idMap.set(deal, 'ELI-HK' + String(index + 1).padStart(3, '0'));
    });
    HKELIApp.data.eliDeals.forEach(function (deal) {
      deal.id = idMap.get(deal);
    });
  }

  // Re-render any views currently shown that depend on the deal list.
  // Called after add/edit/delete/import/clear to keep all views in sync.
  function refreshDealViews() {
    if (HKELIApp.currentView === 'deals') renderDeals();
    else if (HKELIApp.currentView === 'alerts') renderAlerts();
    else if (HKELIApp.currentView === 'analytics') setupCharts();
    else if (HKELIApp.currentView === 'payoff') {
      populatePayoffDealSelect();
      renderPayoffView();
    } else if (HKELIApp.currentView === 'scenarios') renderScenariosView();
    else if (HKELIApp.currentView === 'settings') renderManualPriceEntries();
  }

  // ──────────────────────────────────────────────────────────────────
  // HKEX market-hours indicator (unchanged)
  // ──────────────────────────────────────────────────────────────────
  function updateMarketOpenStatus() {
    var dot = document.getElementById('market-status-dot');
    var text = document.getElementById('market-status-text');
    if (!dot || !text) return;
    var hktMs = Date.now() + (8 * 60 * 60 * 1000);
    var hkt = new Date(hktMs);
    var day = hkt.getUTCDay();
    var time = hkt.getUTCHours() * 60 + hkt.getUTCMinutes();
    var isWeekday = day >= 1 && day <= 5;
    var open = isWeekday && (
      (time >= (9 * 60 + 30) && time < (12 * 60)) ||
      (time >= (13 * 60) && time < (16 * 60))
    );
    dot.className = 'status-indicator ' + (open ? 'active' : 'error');
    text.textContent = open ? 'HKEX Open (HKT)' : 'HKEX Closed (HKT)';
  }

  // ──────────────────────────────────────────────────────────────────
  // Auto-refresh timer
  // ──────────────────────────────────────────────────────────────────
  function startAutoRefresh() {
    if (HKELIApp.refreshTimer) {
      clearInterval(HKELIApp.refreshTimer);
      HKELIApp.refreshTimer = null;
    }
    if (HKELIApp.data.eliDeals.length === 0) return;
    var interval = HKELIApp.data.settings.refreshInterval;
    HKELIApp.refreshTimer = setInterval(function () {
      if (HKELIApp.data.eliDeals.length === 0) {
        clearInterval(HKELIApp.refreshTimer);
        HKELIApp.refreshTimer = null;
        return;
      }
      refreshPrices();
    }, interval);
  }

  function updateRefreshCountdown() {
    var countdownEl = document.getElementById('refresh-countdown');
    var nextCountdownEl = document.getElementById('next-refresh-countdown');
    if (!countdownEl && !nextCountdownEl) return;
    var now = Date.now();
    var lastRefresh = HKELIApp.data.settings.lastRefresh || now;
    var interval = HKELIApp.data.settings.refreshInterval;
    var timeToNext = Math.max(0, lastRefresh + interval - now);
    var hours = Math.floor(timeToNext / 3600000);
    var minutes = Math.floor((timeToNext % 3600000) / 60000);
    var txt = 'Next refresh in: ' + hours + 'h ' + minutes + 'm';
    if (countdownEl) countdownEl.textContent = txt;
    if (nextCountdownEl) nextCountdownEl.textContent = 'In ' + hours + 'h ' + minutes + 'm';
  }

  // ──────────────────────────────────────────────────────────────────
  // View switching
  // ──────────────────────────────────────────────────────────────────
  function switchView(viewName) {
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
    var activeNav = document.querySelector('[data-view="' + viewName + '"]');
    if (activeNav) activeNav.classList.add('active');
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    var target = document.getElementById(viewName + '-view');
    if (target) {
      target.classList.add('active');
      HKELIApp.currentView = viewName;
      if (viewName === 'analytics') setTimeout(setupCharts, 100);
      else if (viewName === 'deals') renderDeals();
      else if (viewName === 'alerts') { renderAlerts(); setupAlertRuleUI(); refreshAlertRuleTargets(); renderAlertRulesList(); }
      else if (viewName === 'settings') { updateRefreshDisplay(); updateAPIStatus(); renderManualPriceEntries(); updateNotificationSettingsUI(); }
      else if (viewName === 'dashboard') renderDashboard();
      else if (viewName === 'payoff') { populatePayoffDealSelect(); renderPayoffView(); }
      else if (viewName === 'scenarios') renderScenariosView();
      else if (viewName === 'calendar') renderCalendarView();
      else if (viewName === 'watchlist') renderWatchlistView();
      else if (viewName === 'compare') renderCompareView();
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Dashboard
  // ──────────────────────────────────────────────────────────────────
  function renderDashboard() {
    updatePortfolioSummary();
    updateDbStatusIndicator();
    var activityList = document.getElementById('activity-list');
    if (activityList) {
      var status = HKELIApp.data.apiStatus;
      var hasDeals = HKELIApp.data.eliDeals.length > 0;
      var activities = [];

      // First-run / no-deals state: just one welcome item.
      if (!hasDeals) {
        activities.push({
          icon: 'fas fa-rocket',
          iconClass: 'info',
          title: 'Welcome to HK ELI Portfolio Manager',
          description: 'Add your first deal in ELI Deals to start tracking barrier risk and live prices.',
          time: 'just now'
        });
      } else {
        activities.push({
          icon: 'fas fa-chart-line',
          iconClass: status.connected ? 'success' : 'error',
          title: status.connected ? 'Live Data Active' : 'Data Connection Issue',
          description: status.connected
            ? 'Real-time prices from ' + (status.source === 'finnhub' ? 'Finnhub' : 'Yahoo Finance')
            : 'Using last cached prices',
          time: status.lastSuccessfulRefresh ? formatTimeAgo(status.lastSuccessfulRefresh) : 'Never updated'
        });
        activities.push({
          icon: 'fas fa-sync-alt',
          iconClass: 'info',
          title: 'Data Refresh',
          description: 'Portfolio data last updated',
          time: HKELIApp.data.settings.lastRefresh ? formatTimeAgo(HKELIApp.data.settings.lastRefresh) : 'Never'
        });
        var knockIns = HKELIApp.data.eliDeals.filter(function (d) { return d.status === 'Knock-in Triggered'; }).length;
        if (knockIns > 0) {
          activities.push({
            icon: 'fas fa-exclamation-triangle',
            iconClass: 'warning',
            title: 'Market Risk',
            description: knockIns + ' position(s) showing knock-in risk',
            time: 'live'
          });
        }
      }

      activityList.innerHTML = activities.map(function (a) {
        var bg = {success: '3', warning: '2', error: '4', info: '1'}[a.iconClass] || '1';
        return '<div class="activity-item">' +
          '<div class="activity-icon bg-' + bg + '"><i class="' + a.icon + '"></i></div>' +
          '<div class="activity-content"><h4>' + a.title + '</h4><p>' + a.description + ' • ' + a.time + '</p></div>' +
        '</div>';
      }).join('');
    }
    // Hide the notification bell until the user has deals (no alerts to show).
    document.body.classList.toggle('no-deals', !hasDeals);
    renderQuickStats();
    renderPortfolioHealth();
  }

  function renderQuickStats() {
    var deals = HKELIApp.data.eliDeals;
    var approaching = deals.filter(function (d) { return d.status === 'Approaching Maturity'; }).length;
    var knockIn = deals.filter(function (d) { return d.status === 'Knock-in Triggered'; }).length;
    var avgCoupon = deals.length
      ? (deals.reduce(function (s, d) { return s + (d.couponRate || 0); }, 0) / deals.length).toFixed(2) + '%'
      : '—';
    var multiStock = deals.filter(function (d) { return (d.underlyingAssets || []).length > 1; }).length;

    var items = document.querySelectorAll('.stats-grid .stat-item');
    if (items.length >= 4) {
      items[0].querySelector('.stat-value').textContent = approaching + ' Deals';
      items[0].querySelector('.stat-value').className = 'stat-value ' + (approaching ? 'warning' : 'success');
      items[1].querySelector('.stat-value').textContent = knockIn + ' Deals';
      items[1].querySelector('.stat-value').className = 'stat-value ' + (knockIn ? 'warning' : 'success');
      items[2].querySelector('.stat-value').textContent = avgCoupon;
      items[3].querySelector('.stat-value').textContent = multiStock + ' Deals';
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Portfolio Health card (Dashboard)
  // ──────────────────────────────────────────────────────────────────
  function renderPortfolioHealth() {
    var gradeEl = document.getElementById('portfolio-health-grade');
    var totalEl = document.getElementById('portfolio-health-total');
    var barsEl = document.getElementById('portfolio-health-bars');
    var detailEl = document.getElementById('portfolio-health-detail');
    if (!gradeEl || !totalEl || !barsEl) return;
    var deals = HKELIApp.data.eliDeals;
    if (!deals.length) {
      gradeEl.textContent = '—';
      gradeEl.className = 'health-grade';
      totalEl.textContent = '0/100';
      barsEl.innerHTML = '<p class="form-help">Add a deal to see your portfolio health score.</p>';
      return;
    }
    if (typeof Health === 'undefined') return;
    var h = Health.portfolioHealth(deals);
    gradeEl.textContent = h.grade;
    gradeEl.className = 'health-grade grade-' + h.grade;
    totalEl.textContent = h.total + '/100';
    if (detailEl) detailEl.textContent = 'Health score = barrier safety + time to maturity + sector spread + issuer diversity.';
    barsEl.innerHTML = Health.AXES.map(function (axis) {
      var c = h[axis];
      return '<div class="health-bar-row">'
        + '<span class="health-bar-label">' + c.label + '</span>'
        + '<div class="health-bar"><div class="health-bar-fill" style="width: ' + (c.score / 25 * 100) + '%"></div></div>'
        + '<span class="health-bar-value">' + c.score + '/25</span>'
        + '<span class="health-bar-detail">' + c.detail + '</span>'
        + '</div>';
    }).join('');
  }

  // ──────────────────────────────────────────────────────────────────
  // Cash-Flow Calendar view
  // ──────────────────────────────────────────────────────────────────
  function renderCalendarView() {
    var horizonEl = document.getElementById('calendar-horizon');
    var statsEl = document.getElementById('calendar-summary-stats');
    var timelineEl = document.getElementById('calendar-timeline');
    var titleEl = document.getElementById('calendar-summary-title');
    if (!timelineEl) return;
    var days = horizonEl ? parseInt(horizonEl.value, 10) : 365;
    var to = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    var events = typeof Calendar !== 'undefined'
      ? Calendar.buildEvents(HKELIApp.data.eliDeals, { to: to, alerts: HKELIApp.data.alerts })
      : [];
    var coupons = events.filter(function (e) { return e.type === 'coupon'; });
    var maturities = events.filter(function (e) { return e.type === 'maturity'; });
    var totalCash = events.reduce(function (s, e) { return s + (e.amountHkd || 0); }, 0);
    if (titleEl) titleEl.textContent = 'Next ' + days + ' days';
    if (statsEl) {
      statsEl.innerHTML = ''
        + '<div class="calendar-stat"><span class="calendar-stat-num">' + events.length + '</span><span>events</span></div>'
        + '<div class="calendar-stat"><span class="calendar-stat-num">' + maturities.length + '</span><span>maturities</span></div>'
        + '<div class="calendar-stat"><span class="calendar-stat-num">' + coupons.length + '</span><span>coupons</span></div>'
        + '<div class="calendar-stat"><span class="calendar-stat-num">' + formatCurrency(totalCash) + '</span><span>total cash (HKD)</span></div>';
    }
    if (!events.length) {
      timelineEl.innerHTML = '<div class="card"><div class="card__body">' +
        emptyState('empty-calendar', 'No events in this window',
          'Add a deal with a maturity date to see upcoming coupons and maturities.',
          'A cash-flow timeline with coupon nodes and a maturity flag') +
        '</div></div>';
      return;
    }
    var grouped = Calendar.groupByMonth(events);
    var months = Object.keys(grouped).sort();
    var html = months.map(function (m) {
      var items = grouped[m].map(function (e) {
        var icon, label, amount, klass;
        if (e.type === 'coupon') { icon = 'fa-coins'; label = 'Coupon payment'; amount = formatCurrency(e.amountHkd); klass = 'event-coupon'; }
        else if (e.type === 'maturity') { icon = 'fa-flag-checkered'; label = 'Maturity'; amount = formatCurrency(e.amountHkd); klass = 'event-maturity'; }
        else { icon = 'fa-bell'; label = e.message || 'Price alert'; amount = e.symbol || ''; klass = 'event-alert'; }
        return '<div class="calendar-event ' + klass + '">'
          + '<span class="calendar-event-date">' + e.date + '</span>'
          + '<i class="fas ' + icon + '"></i>'
          + '<div class="calendar-event-body">'
          + '<strong>' + label + '</strong> · ' + e.dealName
          + (e.monthsAway != null ? ' <small>(' + e.monthsAway + 'mo)</small>' : '')
          + '</div>'
          + '<span class="calendar-event-amount">' + amount + '</span>'
          + '</div>';
      }).join('');
      return '<div class="calendar-month">'
        + '<h3>' + m + '</h3>'
        + items
        + '</div>';
    }).join('');
    timelineEl.innerHTML = html;
  }

  function updatePortfolioSummary() {
    var totalInvestment = HKELIApp.data.eliDeals.reduce(function (s, d) { return s + (d.purchasePrice || 0); }, 0);
    var currentValue = HKELIApp.data.eliDeals.reduce(function (s, d) { return s + (d.currentValue || 0); }, 0);
    var totalPnL = currentValue - totalInvestment;
    var totalInvestmentEl = document.getElementById('total-investment');
    var currentValueEl = document.getElementById('current-value');
    var totalPnlEl = document.getElementById('total-pnl');
    var activeDealsEl = document.getElementById('active-deals');
    if (totalInvestmentEl) totalInvestmentEl.textContent = formatCurrency(totalInvestment);
    if (currentValueEl) currentValueEl.textContent = formatCurrency(currentValue);
    if (totalPnlEl) {
      var pct = totalInvestment > 0 ? ((totalPnL / totalInvestment) * 100).toFixed(2) : '0.00';
      totalPnlEl.textContent = (totalPnL >= 0 ? '+' : '') + formatCurrency(totalPnL);
      totalPnlEl.className = totalPnL >= 0 ? 'positive' : 'negative';
      var card = totalPnlEl.closest('.card-content');
      if (card) {
        var p = card.querySelector('p');
        if (p) p.textContent = 'Total P&L (' + (totalPnL >= 0 ? '+' : '') + pct + '%)';
      }
    }
    if (activeDealsEl) activeDealsEl.textContent = HKELIApp.data.eliDeals.length;
  }

  // ──────────────────────────────────────────────────────────────────
  // Deals rendering (unchanged structure)
  // ──────────────────────────────────────────────────────────────────
  function renderDeals() {
    var dealsGrid = document.getElementById('deals-grid');
    if (!dealsGrid) return;
    refreshTagFilter();
    HKELIApp.filteredDeals = HKELIApp.data.eliDeals.slice();
    if (HKELIApp.filteredDeals.length === 0) {
      dealsGrid.innerHTML = '<div class="card"><div class="card__body">' +
        emptyState('empty-deals', 'No deals yet',
          'Click <strong>Add New HK ELI Deal</strong> to start tracking barrier risk and live prices.',
          'Candlestick chart breaking through a dashed barrier line') +
        '</div></div>';
      return;
    }
    dealsGrid.innerHTML = HKELIApp.filteredDeals.map(createDealCard).join('');
    setTimeout(function () {
      document.querySelectorAll('.deal-card').forEach(function (card) {
        card.addEventListener('click', function (e) {
          if (e.target.closest('.deal-actions')) return;
          showDealDetail(card.dataset.dealId);
        });
      });
      document.querySelectorAll('.deal-action-btn.edit').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          showEditDealModal(e.target.closest('.deal-card').dataset.dealId);
        });
      });
      document.querySelectorAll('.deal-action-btn.delete').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          showDeleteConfirmation(e.target.closest('.deal-card').dataset.dealId);
        });
      });
    }, 100);
  }

  function createDealCard(deal) {
    var pnlPct = deal.purchasePrice > 0 ? ((deal.pnl || 0) / deal.purchasePrice * 100).toFixed(2) : '0.00';
    var daysToMat = calculateDaysToMaturity(deal.maturityDate);
    var statusClass = getStatusClass(deal.status);
    var barrier = calculateBarrierDistance(deal);
    // Per-deal health (0-100 + letter grade)
    var healthBadge = '';
    if (typeof Health !== 'undefined') {
      var h = Health.computeHealth(deal, HKELIApp.data.eliDeals);
      var shortDetail = h.barrierSafety.detail.split(' ')[0] === 'No' ? h.timeToMaturity.detail : h.barrierSafety.score;
      healthBadge = '<span class="deal-health-badge grade-' + h.grade + '" title="Barrier: ' + h.barrierSafety.score
        + '/25 · Maturity: ' + h.timeToMaturity.score + '/25 · Sectors: ' + h.sectorSpread.score + '/25 · Issuer: ' + h.issuerDiversity.score + '/25">'
        + '<span class="deal-health-grade">' + h.grade + '</span>'
        + '<span class="deal-health-score">' + h.total + '</span>'
        + '</span>';
    }
    return '<div class="deal-card" data-deal-id="' + deal.id + '">' +
      '<div class="deal-header"><div class="deal-header-left">' +
        '<div class="stock-count-badge"><i class="fas fa-layer-group"></i>' +
        deal.numberOfStocks + ' Stock' + (deal.numberOfStocks > 1 ? 's' : '') + '</div>' +
        '<div class="deal-title">' + escapeHtml(deal.dealName) + '</div>' +
        '<div class="deal-id">' + deal.id + '</div>' +
        healthBadge +
      '</div>' +
      '<div class="deal-header-right">' +
        '<div class="deal-status ' + statusClass + '">' + escapeHtml(deal.status) + '</div>' +
        '<div class="deal-actions">' +
          '<button class="deal-action-btn edit" type="button" aria-label="Edit deal" title="Edit"><i class="fas fa-edit" aria-hidden="true"></i></button>' +
          '<button class="deal-action-btn delete" type="button" aria-label="Delete deal" title="Delete"><i class="fas fa-trash" aria-hidden="true"></i></button>' +
        '</div></div></div>' +
      '<div class="deal-pricing">' +
        '<div class="pricing-row"><span class="pricing-label">Nominal Amount:</span><span class="pricing-value hk-currency">' + formatCurrency(deal.nominalAmount) + '</span></div>' +
        '<div class="pricing-row"><span class="pricing-label">Purchase Price:</span><span class="pricing-value hk-currency">' + formatCurrency(deal.purchasePrice) + '</span></div>' +
        '<div class="pricing-row"><span class="pricing-label">Coupon Rate:</span><span class="pricing-value yield-impact">' + deal.couponRate + '%</span></div>' +
      '</div>' +
      '<div class="deal-metrics">' +
        '<div class="metric"><div class="metric-label">Current Value</div><div class="metric-value hk-currency">' + formatCurrency(deal.currentValue) + '</div></div>' +
        '<div class="metric"><div class="metric-label">P&L</div><div class="metric-value ' + ((deal.pnl || 0) >= 0 ? 'positive' : 'negative') + '">' +
          ((deal.pnl || 0) >= 0 ? '+' : '') + formatCurrency(deal.pnl) + ' (' + pnlPct + '%)</div></div>' +
        '<div class="metric"><div class="metric-label">Days to Maturity</div><div class="metric-value">' + (daysToMat > 0 ? daysToMat : 'Settled') + '</div></div>' +
        '<div class="metric"><div class="metric-label">Issuer</div><div class="metric-value">' + escapeHtml(deal.issuer) + '</div></div>' +
      '</div>' +
      '<div class="underlying-assets">' +
        (deal.underlyingAssets || []).map(function (a) {
          var change = calculatePriceChange(a);
          return '<div class="underlying-asset">' +
            '<div class="asset-info"><h4><span class="hk-stock-code">' + escapeHtml(a.symbol) + '</span>' + escapeHtml(a.name) +
              (deal.numberOfStocks > 1 ? '<span class="asset-weight">(' + (a.weight * 100).toFixed(1) + '%)</span>' : '') +
              '</h4><p>Strike: ' + formatHKPrice(a.strikePrice, 4) + ' | Barrier: ' + formatHKPrice(a.barrierLevel, 4) + '</p></div>' +
            '<div class="price-info"><div class="current-price hk-currency">' + formatCurrency(a.currentPrice) + '</div>' +
            '<div class="price-change ' + (change >= 0 ? 'positive' : 'negative') + '">' +
              (change >= 0 ? '+' : '') + change.toFixed(2) + '%</div></div></div>';
        }).join('') +
      '</div>' +
      '<div class="barrier-indicator">' +
        '<span class="barrier-text">Barrier Safety</span>' +
        '<div class="barrier-bar"><div class="barrier-fill ' + barrier.class + '" style="width: ' + barrier.percentage + '%"></div></div>' +
        '<span class="barrier-text">' + barrier.percentage.toFixed(0) + '%</span>' +
      '</div>' +
      renderTagChips(deal.tags) +
    '</div>';
  }

  function renderTagChips(tags) {
    if (!tags || !tags.length) return '';
    return '<div class="deal-tags">' + tags.map(function (t) {
      return '<span class="deal-tag">#' + escapeHtml(t) + '</span>';
    }).join('') + '</div>';
  }

  // ──────────────────────────────────────────────────────────────────
  // Empty-state illustrations
  // Renders an inline <img> pointing at assets/illustrations/<name>.svg
  // so empty states stay visually consistent and need no JS drawing.
  // ──────────────────────────────────────────────────────────────────
  function illustration(name, alt) {
    return '<img class="empty-illustration" src="assets/illustrations/' + name +
      '.svg" alt="' + escapeHtml(alt || '') + '" loading="lazy" decoding="async">';
  }

  function emptyState(name, title, message, alt) {
    return '<div class="empty-state">'
      + illustration(name, alt || title)
      + '<h3>' + escapeHtml(title) + '</h3>'
      + '<p>' + message + '</p>'
      + '</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }

  function calculatePriceChange(asset) {
    if (!asset.strikePrice) return 0;
    return ((asset.currentPrice || asset.strikePrice) - asset.strikePrice) / asset.strikePrice * 100;
  }

  function calculateBarrierDistance(deal) {
    var min = 100, level = 'safe';
    (deal.underlyingAssets || []).forEach(function (a) {
      if (!a.barrierLevel) return;
      var dist = ((a.currentPrice || a.strikePrice) - a.barrierLevel) / a.barrierLevel * 100;
      if (dist < min) min = dist;
    });
    if (min < 15) level = 'danger';
    else if (min < 30) level = 'warning';
    return { percentage: Math.max(0, Math.min(100, min)), class: level };
  }

  function getStatusClass(status) {
    return ({
      'Active': 'active',
      'Knock-in Triggered': 'knock-in',
      'Approaching Maturity': 'approaching',
      'Settled': 'settled'
    })[status] || 'active';
  }

  // ──────────────────────────────────────────────────────────────────
  // Modals — Add / Edit / Delete / Detail
  // ──────────────────────────────────────────────────────────────────
  function showAddDealModal() {
    var modal = document.getElementById('add-deal-modal');
    if (modal) { modal.classList.remove('hidden'); updateStockConfiguration(); }
  }
  function hideAddDealModal() {
    var modal = document.getElementById('add-deal-modal');
    if (modal) modal.classList.add('hidden');
    resetFormState();
  }
  function showDealDetail(dealId) {
    var deal = HKELIApp.data.eliDeals.find(function (d) { return d.id === dealId; });
    if (!deal) return;
    var t = document.getElementById('deal-detail-title');
    if (t) t.textContent = deal.dealName;
    var html = '<div class="deal-detail-grid">' +
      '<div class="detail-section"><h3>Deal Information</h3><div class="detail-list">' +
        detailRow('Deal ID', deal.id) +
        detailRow('Stocks', deal.numberOfStocks + ' HK Stock' + (deal.numberOfStocks > 1 ? 's' : '')) +
        detailRow('Investment Date', new Date(deal.investmentDate).toLocaleDateString()) +
        detailRow('Maturity Date', new Date(deal.maturityDate).toLocaleDateString()) +
        detailRow('Issuer', deal.issuer) +
      '</div></div>' +
      '<div class="detail-section"><h3>Pricing</h3><div class="detail-list">' +
        detailRow('Nominal Amount', formatCurrency(deal.nominalAmount), 'hk-currency') +
        detailRow('Purchase Price', formatCurrency(deal.purchasePrice), 'hk-currency') +
        detailRow('Current Value', formatCurrency(deal.currentValue), 'hk-currency') +
        detailRow('P&L', (deal.pnl >= 0 ? '+' : '') + formatCurrency(deal.pnl), deal.pnl >= 0 ? 'positive' : 'negative') +
      '</div></div></div>' +
      renderDealNotesBlock(deal) +
      renderDealAttributionBlock(deal);
    var c = document.getElementById('deal-detail-content');
    if (c) c.innerHTML = html;
    wireDealNotesSave(dealId);
    showDealDetailModal();
  }

  // Notes auto-save on blur (and on Ctrl+Enter), so you never lose the
  // thought you just typed by closing the modal.
  function wireDealNotesSave(dealId) {
    var ta = document.getElementById('deal-notes-input');
    if (!ta) return;
    ta.addEventListener('blur', function () {
      if (ta.dataset.dirty !== '1') return;
      ta.dataset.dirty = '';
      saveDealNotes(dealId, ta.value);
    });
    ta.addEventListener('input', function () { ta.dataset.dirty = '1'; });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ta.blur();
      }
    });
  }

  // Notes block inside the deal detail modal — editable inline, saved on blur.
  function renderDealNotesBlock(deal) {
    var note = (typeof AlertRules !== 'undefined') ? AlertRules.cleanNote(deal.notes) : (deal.notes || '');
    var cls = typeof AlertRules !== 'undefined' ? AlertRules.escapeHtml : escapeHtml;
    return '<div class="detail-section"><h3>Notes</h3>'
      + '<textarea class="form-control deal-notes-input" id="deal-notes-input" rows="4" '
      + 'placeholder="Why did you take this deal? What would make you exit?" '
      + 'aria-label="Deal notes">' + cls(note) + '</textarea>'
      + '<small class="form-help">Saved automatically when you click away.</small>'
      + '</div>';
  }

  // P&L attribution block inside the deal detail modal.
  function renderDealAttributionBlock(deal) {
    if (typeof AlertRules === 'undefined') return '';
    var rows = AlertRules.attributeDealPnl(deal);
    if (!rows.length) return '';
    var body = rows.map(function (r) {
      var cls = r.contribution >= 0 ? 'positive' : 'negative';
      return '<div class="attribution-row">'
        + '<span class="attribution-symbol"><strong>' + escapeHtml(r.symbol) + '</strong></span>'
        + '<div class="attribution-bar">'
        + '<div class="attribution-fill ' + cls + '" style="width: ' +
          Math.min(100, Math.abs(r.pctOfTotal)) + '%"></div>'
        + '</div>'
        + '<span class="attribution-value ' + cls + '">'
        + (r.contribution >= 0 ? '+' : '') + formatCurrency(r.contribution) + '</span>'
        + '</div>';
    }).join('');
    return '<div class="detail-section"><h3>P&amp;L by underlying</h3>'
      + '<p class="form-help">Settles on the worst leg, but this shows where the move came from.</p>'
      + body + '</div>';
  }

  function saveDealNotes(dealId, text) {
    var clean = (typeof AlertRules !== 'undefined') ? AlertRules.cleanNote(text) : String(text || '');
    Storage.updateDeal(dealId, { notes: clean });
    loadDealsIntoState();
    var deal = HKELIApp.data.eliDeals.find(function (d) { return d.id === dealId; });
    if (deal) deal.notes = clean;
    persistDeals();
    showToast('Notes saved', 'success');
  }
  function detailRow(label, value, cls) {
    return '<div class="detail-item"><span class="detail-label">' + label + '</span>' +
           '<span class="detail-value ' + (cls || '') + '">' + value + '</span></div>';
  }
  function showDealDetailModal() { document.getElementById('deal-detail-modal').classList.remove('hidden'); }
  function hideDealDetailModal() { document.getElementById('deal-detail-modal').classList.add('hidden'); }

  function showEditDealModal(dealId) {
    var deal = HKELIApp.data.eliDeals.find(function (d) { return d.id === dealId; });
    if (!deal) return;
    HKELIApp.editingDealId = dealId;
    var t = document.getElementById('modal-title'); if (t) t.textContent = 'Edit HK ELI Deal';
    var s = document.getElementById('submit-deal-btn'); if (s) s.textContent = 'Update Deal';
    populateEditForm(deal);
    showAddDealModal();
  }
  function populateEditForm(deal) {
    var form = document.getElementById('add-deal-form');
    if (!form) return;
    document.getElementById('edit-deal-id').value = deal.id;
    ['dealName', 'investmentDate', 'maturityDate', 'nominalAmount', 'purchasePrice',
     'couponRate', 'issuer', 'settlementMethod', 'numberOfStocks'].forEach(function (n) {
      var el = form.querySelector('[name="' + n + '"]');
      if (el) el.value = deal[n];
    });
    var tagsEl = form.querySelector('[name="tags"]');
    if (tagsEl) tagsEl.value = (deal.tags || []).join(', ');
    var notesEl = form.querySelector('[name="notes"]');
    if (notesEl) {
      notesEl.value = (typeof AlertRules !== 'undefined')
        ? AlertRules.cleanNote(deal.notes)
        : (deal.notes || '');
    }
    setTimeout(function () {
      updateStockConfiguration();
      setTimeout(function () { populateStockInputsFromDeal(deal); }, 50);
    }, 100);
  }

  // Parse a comma-separated tag string into a deduped, lowercased, trimmed array.
  function parseTagsInput(s) {
    if (!s) return [];
    return s.split(',').map(function (t) { return t.trim().toLowerCase(); })
      .filter(function (t) { return t.length > 0 && t.length <= 32; })
      .filter(function (t, i, arr) { return arr.indexOf(t) === i; });
  }
  function populateStockInputsFromDeal(deal) {
    if (!deal || !Array.isArray(deal.underlyingAssets)) return;
    var n = deal.numberOfStocks || deal.underlyingAssets.length;
    for (var i = 0; i < n; i++) {
      var a = deal.underlyingAssets[i]; if (!a) continue;
      var search = document.querySelector('input[name="stock_search_' + i + '"]');
      var hidden = document.querySelector('input[name="stock_' + i + '"]');
      var strike = document.querySelector('input[name="strike_' + i + '"]');
      var barrier = document.querySelector('input[name="barrier_' + i + '"]');
      var weight = document.querySelector('input[name="weight_' + i + '"]');
      if (search) search.value = a.symbol + ' - ' + (a.name || '');
      if (hidden) hidden.value = a.symbol || '';
      if (strike && typeof a.strikePrice === 'number') strike.value = a.strikePrice;
      if (barrier && typeof a.barrierLevel === 'number') barrier.value = a.barrierLevel;
      if (weight && typeof a.weight === 'number') weight.value = a.weight;
    }
  }
  function showDeleteConfirmation(dealId) {
    var deal = HKELIApp.data.eliDeals.find(function (d) { return d.id === dealId; });
    if (!deal) return;
    HKELIApp.deletingDealId = dealId;
    document.getElementById('delete-deal-name').textContent = deal.dealName;
    document.getElementById('delete-confirmation-modal').classList.remove('hidden');
  }
  function hideDeleteConfirmation() {
    document.getElementById('delete-confirmation-modal').classList.add('hidden');
    HKELIApp.deletingDealId = null;
  }
  function confirmDeleteDeal() {
    if (!HKELIApp.deletingDealId) return;
    // Keep a copy so the delete can be undone from a toast.
    var removed = HKELIApp.data.eliDeals.find(function (d) {
      return d.id === HKELIApp.deletingDealId;
    });
    if (removed) {
      HKELIApp.lastDeletedDeal = JSON.parse(JSON.stringify(removed));
    }
    Storage.deleteDeal(HKELIApp.deletingDealId);
    loadDealsIntoState();
    refreshDealViews();
    reassignELIIds();
    persistDeals();
    hideDeleteConfirmation();
    renderDashboard();
    if (HKELIApp.currentView === 'deals') renderDeals();
    showToastWithUndo('Deal deleted', 'success');
  }

  // ──────────────────────────────────────────────────────────────────
  // Undo toast
  // ──────────────────────────────────────────────────────────────────
  var UNDO_WINDOW_MS = 8000;

  /**
   * Toast with an optional Undo button that stays live for
   * UNDO_WINDOW_MS, then greys out rather than disappearing (so a late
   * click tells you it's too late instead of silently doing nothing).
   */
  function showToastWithUndo(message, type) {
    type = type || 'info';
    var title = ({ success: 'Success', error: 'Error', warning: 'Warning' })[type] || 'Notification';
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toastId = 'toast-' + Date.now();
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.id = toastId;
    toast.innerHTML =
      '<div class="toast-header">' +
        '<span class="toast-title">' + title + '</span>' +
        '<button class="toast-close" type="button" aria-label="Dismiss">×</button>' +
      '</div>' +
      '<p class="toast-message">' + message + '</p>' +
      '<button class="toast-undo" type="button">Undo</button>';
    container.appendChild(toast);

    var undoBtn = toast.querySelector('.toast-undo');
    var timer = setTimeout(function () {
      if (!undoBtn) return;
      undoBtn.disabled = true;
      undoBtn.textContent = 'Undo expired';
    }, UNDO_WINDOW_MS);

    undoBtn.addEventListener('click', function () {
      if (undoBtn.disabled) return;
      clearTimeout(timer);
      var deal = HKELIApp.lastDeletedDeal;
      if (deal) {
        Storage.addDeal(deal);
        loadDealsIntoState();
        reassignELIIds();
        refreshDealViews();
        renderDashboard();
        if (HKELIApp.currentView === 'deals') renderDeals();
        HKELIApp.lastDeletedDeal = null;
        showToast('Deal restored', 'success');
      }
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    });

    toast.querySelector('.toast-close').addEventListener('click', function () {
      clearTimeout(timer);
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    });

    setTimeout(function () {
      if (!toast.parentNode) return;
      toast.classList.add('removing');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, UNDO_WINDOW_MS + 2500);
  }

  // ──────────────────────────────────────────────────────────────────
  // Stock configuration (form inputs)
  // ──────────────────────────────────────────────────────────────────
  function updateStockConfiguration() {
    var numberOfStocksSelect = document.getElementById('number-of-stocks');
    var stockInputs = document.getElementById('stock-inputs');
    if (!numberOfStocksSelect || !stockInputs) return;
    var n = parseInt(numberOfStocksSelect.value, 10) || 1;
    var html = '';
    for (var i = 0; i < n; i++) {
      html += '<div class="stock-config" data-stock-index="' + i + '">' +
        '<h4>Stock ' + (i + 1) + '</h4>' +
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label">Search HK Stock</label>' +
            '<input type="text" class="form-control stock-search" name="stock_search_' + i + '" placeholder="Type to search HK stocks...">' +
            '<input type="hidden" name="stock_' + i + '">' +
            '<div class="stock-suggestions" id="stock-suggestions-' + i + '"></div>' +
          '</div>' +
          '<div class="form-group"><label class="form-label">Strike Price (HK$)</label>' +
            '<input type="number" class="form-control" name="strike_' + i + '" step="0.01" required>' +
          '</div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label">Barrier Level (HK$)</label>' +
            '<input type="number" class="form-control" name="barrier_' + i + '" step="0.01" required>' +
          '</div>' +
          (n > 1 ? '<div class="form-group"><label class="form-label">Weight</label>' +
            '<input type="number" class="form-control" name="weight_' + i + '" step="0.01" min="0" max="1" value="' + (1 / n).toFixed(2) + '">' +
          '</div>' : '') +
        '</div>' +
      '</div>';
    }
    stockInputs.innerHTML = html;
    // Wire up stock-search autocompletes
    stockInputs.querySelectorAll('.stock-search').forEach(function (input) {
      var idx = input.getAttribute('name').replace('stock_search_', '');
      wireStockAutocomplete(input, idx);
    });
  }

  function wireStockAutocomplete(input, idx) {
    var hidden = document.querySelector('input[name="stock_' + idx + '"]');
    var sug = document.getElementById('stock-suggestions-' + idx);
    if (!input || !hidden || !sug) return;
    input.addEventListener('input', function () {
      var q = input.value.toLowerCase();
      sug.innerHTML = '';
      if (!q) return;
      HKELIApp.data.hkStocks
        .filter(function (s) { return s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q); })
        .slice(0, 8)
        .forEach(function (s) {
          var div = document.createElement('div');
          div.className = 'suggestion-item';
          div.textContent = s.symbol + ' - ' + s.name;
          div.addEventListener('click', function () {
            input.value = s.symbol + ' - ' + s.name;
            hidden.value = s.symbol;
            sug.innerHTML = '';
          });
          sug.appendChild(div);
        });
    });
  }

  function handleDealFormSubmit(e) {
    e.preventDefault();
    var form = e.target;
    var editId = document.getElementById('edit-deal-id').value;
    var numberOfStocks = parseInt(form.numberOfStocks.value, 10);
    var assets = [];
    for (var i = 0; i < numberOfStocks; i++) {
      var sym = form.querySelector('input[name="stock_' + i + '"]').value;
      if (!sym) continue;
      var existing = (editId
        ? (HKELIApp.data.eliDeals.find(function (d) { return d.id === editId; }) || {}).underlyingAssets
        : []
      ).find(function (a) { return a.symbol === sym; }) || {};
      var stockMeta = HKELIApp.data.hkStocks.find(function (s) { return s.symbol === sym; }) || {};
      assets.push({
        symbol: sym,
        name: stockMeta.name || existing.name || sym,
        currentPrice: existing.currentPrice || parseFloat(form.querySelector('input[name="strike_' + i + '"]').value),
        strikePrice: parseFloat(form.querySelector('input[name="strike_' + i + '"]').value),
        barrierLevel: parseFloat(form.querySelector('input[name="barrier_' + i + '"]').value),
        weight: numberOfStocks > 1
          ? parseFloat(form.querySelector('input[name="weight_' + i + '"]').value) || 0
          : 1
      });
    }
    var payload = {
      dealName: form.dealName.value,
      investmentDate: form.investmentDate.value,
      maturityDate: form.maturityDate.value,
      nominalAmount: parseFloat(form.nominalAmount.value),
      purchasePrice: parseFloat(form.purchasePrice.value),
      numberOfStocks: assets.length,
      couponRate: parseFloat(form.couponRate.value),
      settlementMethod: form.settlementMethod.value,
      issuer: form.issuer.value,
      status: 'Active',
      underlyingAssets: assets,
      currentValue: parseFloat(form.purchasePrice.value),
      pnl: 0,
      tags: parseTagsInput(form.tags ? form.tags.value : ''),
      notes: (typeof AlertRules !== 'undefined')
        ? AlertRules.cleanNote(form.notes ? form.notes.value : '')
        : String((form.notes && form.notes.value) || '').trim()
    };
    if (editId) {
      Storage.updateDeal(editId, payload);
      showToast('Deal updated', 'success');
    } else {
      Storage.addDeal(payload);
      showToast('Deal added', 'success');
    }
    loadDealsIntoState();
    refreshDealViews();
    reassignELIIds();
    persistDeals();
    hideAddDealModal();
    renderDashboard();
    if (HKELIApp.currentView === 'deals') renderDeals();
    refreshPrices();
  }

  function resetFormState() {
    var f = document.getElementById('add-deal-form');
    if (f) f.reset();
    document.getElementById('edit-deal-id').value = '';
    HKELIApp.editingDealId = null;
    var t = document.getElementById('modal-title'); if (t) t.textContent = 'Add New HK ELI Deal';
    var s = document.getElementById('submit-deal-btn'); if (s) s.textContent = 'Add ELI Deal';
  }

  // ──────────────────────────────────────────────────────────────────
  // Charts (Chart.js) — Allocation, Performance, Stock Count
  // ──────────────────────────────────────────────────────────────────
  function setupCharts() {
    if (typeof Chart === 'undefined') return;
    var deals = HKELIApp.data.eliDeals;
    var bySymbol = {};
    var perfLabels = [], perfData = [];
    var stockCounts = {1: 0, 2: 0, 3: 0, 4: 0};
    deals.forEach(function (d) {
      (d.underlyingAssets || []).forEach(function (a) {
        bySymbol[a.symbol] = (bySymbol[a.symbol] || 0) + (d.currentValue || 0) * (a.weight || 0);
      });
      perfLabels.push(d.dealName);
      perfData.push((d.couponRate || 0));
      var n = (d.underlyingAssets || []).length;
      if (stockCounts[n] != null) stockCounts[n]++;
    });

    var symbols = Object.keys(bySymbol);
    var allocationEl = document.getElementById('allocation-chart');
    if (allocationEl && symbols.length) {
      if (HKELIApp.charts.allocation) HKELIApp.charts.allocation.destroy();
      HKELIApp.charts.allocation = new Chart(allocationEl.getContext('2d'), {
        type: 'doughnut',
        data: { labels: symbols, datasets: [{ data: symbols.map(function (s) { return bySymbol[s]; }) }] },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }
    var perfEl = document.getElementById('performance-chart');
    if (perfEl && perfLabels.length) {
      if (HKELIApp.charts.performance) HKELIApp.charts.performance.destroy();
      HKELIApp.charts.performance = new Chart(perfEl.getContext('2d'), {
        type: 'bar',
        data: { labels: perfLabels, datasets: [{ label: 'Coupon Rate (%)', data: perfData }] },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }
    var scEl = document.getElementById('stock-count-chart');
    if (scEl) {
      if (HKELIApp.charts.stockCount) HKELIApp.charts.stockCount.destroy();
      HKELIApp.charts.stockCount = new Chart(scEl.getContext('2d'), {
        type: 'bar',
        data: {
          labels: ['1 Stock', '2 Stocks', '3 Stocks', '4 Stocks'],
          datasets: [{ data: [stockCounts[1], stockCounts[2], stockCounts[3], stockCounts[4]] }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }

    // Sector concentration (uses Sectors module from js/sectors.js)
    if (typeof Sectors !== 'undefined') {
      var sectorEl = document.getElementById('sector-chart');
      var sectorTotals = {};
      deals.forEach(function (d) {
        (d.underlyingAssets || []).forEach(function (a) {
          var s = Sectors.lookup(a.symbol).sector;
          sectorTotals[s] = (sectorTotals[s] || 0) + (d.currentValue || 0) * (a.weight || 0);
        });
      });
      var sectorLabels = Object.keys(sectorTotals).sort(function (a, b) {
        return Sectors.SECTOR_ORDER.indexOf(a) - Sectors.SECTOR_ORDER.indexOf(b);
      });
      var sectorData = sectorLabels.map(function (k) { return sectorTotals[k]; });
      if (sectorEl) {
        if (HKELIApp.charts.sector) HKELIApp.charts.sector.destroy();
        HKELIApp.charts.sector = new Chart(sectorEl.getContext('2d'), {
          type: 'doughnut',
          data: { labels: sectorLabels, datasets: [{ data: sectorData }] },
          options: { responsive: true, maintainAspectRatio: false }
        });
      }
    }

    // Issuer exposure
    var issuerEl = document.getElementById('issuer-chart');
    var issuerTotals = {};
    deals.forEach(function (d) {
      issuerTotals[d.issuer || 'Unknown'] = (issuerTotals[d.issuer || 'Unknown'] || 0) + (d.currentValue || 0);
    });
    var issuerLabels = Object.keys(issuerTotals);
    var issuerData = issuerLabels.map(function (k) { return issuerTotals[k]; });
    if (issuerEl) {
      if (HKELIApp.charts.issuer) HKELIApp.charts.issuer.destroy();
      HKELIApp.charts.issuer = new Chart(issuerEl.getContext('2d'), {
        type: 'bar',
        data: { labels: issuerLabels, datasets: [{ label: 'HK$', data: issuerData }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          indexAxis: 'y',
          scales: { x: { ticks: { callback: function (v) { return 'HK$' + (v / 1000) + 'k'; } } } }
        }
      });
    }

    if (typeof updateRiskAnalytics === 'function') updateRiskAnalytics();
    renderMaxDrawdownList();
    renderPortfolioHistoryChart();
    renderPnlAttribution();
  }

  // ──────────────────────────────────────────────────────────────────
  // P&L attribution by underlying (Analytics)
  // ──────────────────────────────────────────────────────────────────
  function renderPnlAttribution() {
    var el = document.getElementById('pnl-attribution-list');
    if (!el || typeof AlertRules === 'undefined') return;
    var deals = HKELIApp.data.eliDeals || [];
    if (!deals.length) {
      el.innerHTML = '<p class="form-help">Add deals to see which underlying is driving your P&L.</p>';
      return;
    }
    var rows = AlertRules.attributePortfolioPnl(deals);
    if (!rows.length) {
      el.innerHTML = '<p class="form-help">No holdings to attribute yet.</p>';
      return;
    }
    // Scale bars against the largest absolute contribution so the
    // biggest mover always fills its bar regardless of sign.
    var maxAbs = rows.reduce(function (m, r) {
      return Math.max(m, Math.abs(r.contribution));
    }, 0) || 1;

    var html = rows.map(function (r) {
      var cls = r.contribution >= 0 ? 'positive' : 'negative';
      var pct = r.pctOfTotal;
      var pctLabel = isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%' : '—';
      var dealNames = r.deals.map(function (d) { return d.name; }).join(', ');
      return '<div class="attribution-row" title="' + AlertRules.escapeHtml(dealNames) + '">'
        + '<span class="attribution-symbol"><strong>' + escapeHtml(r.symbol) + '</strong>'
        + '<small>' + AlertRules.escapeHtml(r.deals.length > 1 ? r.deals.length + ' deals' : r.deals[0].name) + '</small></span>'
        + '<div class="attribution-bar">'
        + '<div class="attribution-fill ' + cls + '" style="width: '
        + Math.max(2, (Math.abs(r.contribution) / maxAbs) * 100) + '%"></div>'
        + '</div>'
        + '<span class="attribution-value ' + cls + '">'
        + (r.contribution >= 0 ? '+' : '') + formatCurrency(r.contribution) + '</span>'
        + '<span class="attribution-pct">' + pctLabel + '</span>'
        + '</div>';
    }).join('');
    el.innerHTML = html;
  }

  // ──────────────────────────────────────────────────────────────────
  // Portfolio value over time
  // Rebuilds a portfolio-level series from the per-symbol daily
  // snapshots in price_history. Each historical price is valued through
  // the same formula the app uses today, so the line is comparable
  // with the live current value.
  // ──────────────────────────────────────────────────────────────────
  function renderPortfolioHistoryChart() {
    var canvas = document.getElementById('portfolio-history-chart');
    var emptyEl = document.getElementById('portfolio-history-empty');
    if (!canvas || typeof Db === 'undefined') return;
    var rangeEl = document.getElementById('portfolio-history-range');
    var days = rangeEl ? (parseInt(rangeEl.value, 10) || 90) : 90;
    var since = Date.now() - days * 24 * 60 * 60 * 1000;

    var deals = HKELIApp.data.eliDeals || [];
    if (!deals.length) {
      if (HKELIApp.charts.portfolioHistory) { HKELIApp.charts.portfolioHistory.destroy(); HKELIApp.charts.portfolioHistory = null; }
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    var symbols = [];
    deals.forEach(function (d) {
      (d.underlyingAssets || []).forEach(function (a) {
        if (a.symbol && symbols.indexOf(a.symbol) === -1) symbols.push(a.symbol);
      });
    });

    Db.getPriceHistory(symbols, { since: since, limit: 2000 }).then(function (history) {
      // Union of all dates, ascending.
      var dateSet = {};
      Object.keys(history).forEach(function (sym) {
        (history[sym] || []).forEach(function (h) {
          dateSet[new Date(h.timestamp).toISOString().slice(0, 10)] = true;
        });
      });
      var dates = Object.keys(dateSet).sort();
      if (dates.length < 2) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (canvas.parentNode) canvas.parentNode.style.display = 'none';
        return;
      }
      if (emptyEl) emptyEl.classList.add('hidden');
      if (canvas.parentNode) canvas.parentNode.style.display = '';

      // Per-symbol lookup by date so we can value each deal on that date.
      var bySymDate = {};
      Object.keys(history).forEach(function (sym) {
        bySymDate[sym] = {};
        (history[sym] || []).forEach(function (h) {
          bySymDate[sym][new Date(h.timestamp).toISOString().slice(0, 10)] = h.price;
        });
      });

      // Value the whole portfolio on each date.
      var portfolioSeries = dates.map(function (date) {
        var total = 0;
        deals.forEach(function (deal) {
          (deal.underlyingAssets || []).forEach(function (a) {
            var px = (bySymDate[a.symbol] || {})[date];
            if (typeof px !== 'number') return;
            var effShares = (deal.purchasePrice || 0) / (a.strikePrice || 1);
            total += px * effShares * (a.weight || 0);
          });
        });
        return total;
      });

      // Cost basis line so the fill between the two is readable.
      var basis = deals.reduce(function (s, d) { return s + (d.purchasePrice || 0); }, 0);

      if (HKELIApp.charts.portfolioHistory) HKELIApp.charts.portfolioHistory.destroy();
      HKELIApp.charts.portfolioHistory = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: dates,
          datasets: [
            {
              label: 'Portfolio value',
              data: portfolioSeries,
              borderColor: '#4fc3f7',
              backgroundColor: 'rgba(79,195,247,0.12)',
              fill: true,
              tension: 0.25,
              pointRadius: dates.length > 45 ? 0 : 3,
              borderWidth: 2
            },
            {
              label: 'Cost basis',
              data: dates.map(function () { return basis; }),
              borderColor: 'rgba(167,139,250,0.75)',
              borderDash: [6, 5],
              borderWidth: 1.5,
              pointRadius: 0,
              fill: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: {
              ticks: { callback: function (v) { return formatCurrency(v); } },
              title: { display: true, text: 'Mark-to-market value' }
            },
            x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }
          },
          plugins: { legend: { position: 'bottom' } }
        }
      });
    }).catch(function (e) {
      console.warn('portfolio history chart failed', e);
    });
  }

  function setupPortfolioHistoryRange() {
    var sel = document.getElementById('portfolio-history-range');
    if (!sel || sel.dataset.bound) return;
    sel.dataset.bound = '1';
    sel.addEventListener('change', renderPortfolioHistoryChart);
  }

  // Per-deal max-drawdown list (reads price_history from SQLite)
  function renderMaxDrawdownList() {
    var el = document.getElementById('max-drawdown-list');
    if (!el) return;
    var deals = HKELIApp.data.eliDeals;
    if (!deals.length) { el.innerHTML = '<p class="form-help">No deals to analyze.</p>'; return; }
    if (typeof Db === 'undefined' || typeof Payoff === 'undefined') return;
    var symbols = [];
    deals.forEach(function (d) { (d.underlyingAssets || []).forEach(function (a) {
      if (symbols.indexOf(a.symbol) === -1) symbols.push(a.symbol);
    }); });
    Db.getPriceHistory(symbols).then(function (history) {
      var rows = deals.map(function (d) {
        var best = null;
        (d.underlyingAssets || []).forEach(function (a) {
          var h = history[a.symbol] || [];
          var dd = Payoff.maxDrawdown(h);
          if (!best || dd.maxDrawdownPct < best.dd.maxDrawdownPct) {
            best = { symbol: a.symbol, dd: dd, current: a.currentPrice };
          }
        });
        if (!best) return '';
        var ddPct = best.dd.maxDrawdownPct;            // negative = loss
        var ddMag = Math.abs(ddPct);
        var klass = ddMag >= 30 ? 'negative' : ddMag >= 15 ? 'warning' : 'positive';
        return '<div class="drawdown-row">'
          + '<div class="drawdown-deal"><strong>' + escapeHtml(d.dealName) + '</strong><br><small class="form-help">' + escapeHtml(best.symbol) + '</small></div>'
          + '<div class="drawdown-bar"><div class="drawdown-fill ' + klass + '" style="width: ' + Math.min(100, ddMag * 2) + '%"></div></div>'
          + '<div class="drawdown-value ' + klass + '">' + (ddPct >= 0 ? '+' : '') + ddPct.toFixed(1) + '%</div>'
          + '</div>';
      }).join('');
      el.innerHTML = rows || '<p class="form-help">No history yet — prices recorded from every refresh will appear here.</p>';
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Risk analytics (simple calculations, same logic as original)
  // ──────────────────────────────────────────────────────────────────
  function calculateHKMarketConcentration() {
    var deals = HKELIApp.data.eliDeals;
    if (!deals.length) return { percentage: 0, level: 'None', class: 'success' };
    var total = deals.reduce(function (s, d) { return s + (d.currentValue || 0); }, 0);
    if (!total) return { percentage: 0, level: 'None', class: 'success' };
    var hk = 0;
    deals.forEach(function (d) {
      (d.underlyingAssets || []).forEach(function (a) {
        if (a.symbol && a.symbol.endsWith('.HK')) {
          hk += (d.currentValue || 0) * (a.weight || 0);
        }
      });
    });
    var pct = (hk / total) * 100;
    var klass = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : pct >= 50 ? 'warning' : 'success';
    var lvl = pct >= 90 ? 'Very High' : pct >= 70 ? 'High' : pct >= 50 ? 'Medium' : 'Low';
    return { percentage: Math.round(pct), level: lvl, class: klass };
  }
  function calculateBarrierRiskExposure() {
    var deals = HKELIApp.data.eliDeals;
    if (!deals.length) return { percentage: 0, level: 'None', class: 'success' };
    var total = 0, atRisk = 0;
    deals.forEach(function (d) {
      total += (d.currentValue || 0);
      var risk = false;
      (d.underlyingAssets || []).forEach(function (a) {
        if (a.barrierLevel && a.currentPrice) {
          var dist = (a.currentPrice - a.barrierLevel) / a.barrierLevel;
          if (dist <= 0.15) risk = true;
        }
      });
      if (risk) atRisk += (d.currentValue || 0);
    });
    var pct = total > 0 ? (atRisk / total) * 100 : 0;
    var klass = pct >= 60 ? 'danger' : pct >= 40 ? 'danger' : pct >= 20 ? 'warning' : 'success';
    var lvl = pct >= 60 ? 'Very High' : pct >= 40 ? 'High' : pct >= 20 ? 'Medium' : 'Low';
    return { percentage: Math.round(pct), level: lvl, class: klass };
  }
  function calculateMultiStockDiversification() {
    var deals = HKELIApp.data.eliDeals;
    if (!deals.length) return { percentage: 0, level: 'None', class: 'danger' };
    var uniq = new Set();
    var totalDeals = 0, multiStock = 0;
    deals.forEach(function (d) {
      totalDeals++;
      if ((d.underlyingAssets || []).length > 1) multiStock++;
      (d.underlyingAssets || []).forEach(function (a) { uniq.add(a.symbol); });
    });
    var multi = totalDeals ? (multiStock / totalDeals) : 0;
    var stockRatio = totalDeals ? Math.min(uniq.size / totalDeals, 2) / 2 : 0;
    var score = (multi * 0.6 + stockRatio * 0.4) * 100;
    var klass = score >= 70 ? 'success' : score >= 40 ? 'warning' : 'danger';
    var lvl = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
    return { percentage: Math.round(score), level: lvl, class: klass };
  }
  function updateRiskAnalytics() {
    var hk = calculateHKMarketConcentration();
    var br = calculateBarrierRiskExposure();
    var dv = calculateMultiStockDiversification();
    var items = document.querySelectorAll('.risk-item');
    function apply(item, metric) {
      if (!item) return;
      var bar = item.querySelector('.risk-fill');
      var val = item.querySelector('.risk-value');
      if (bar) { bar.style.width = metric.percentage + '%'; bar.className = 'risk-fill ' + metric.class; }
      if (val) val.textContent = metric.level;
    }
    apply(items[0], hk);
    apply(items[1], br);
    apply(items[2], dv);
  }

  // ──────────────────────────────────────────────────────────────────
  // Alerts
  // ──────────────────────────────────────────────────────────────────
  function rebuildAlertsFromState() {
    var newAlerts = [];
    var thresholdInput = document.getElementById('alert-threshold');
    var thresholdPct = (parseInt(thresholdInput && thresholdInput.value, 10) || 10) / 100;
    var now = Date.now();
    HKELIApp.data.eliDeals.forEach(function (deal) {
      var daysToMat = calculateDaysToMaturity(deal.maturityDate);
      if (daysToMat > 0 && daysToMat <= 30) {
        newAlerts.push({
          id: 'ALERT-' + deal.id + '-MAT',
          type: 'Maturity Notice',
          message: deal.dealName + ' matures in ' + daysToMat + ' days',
          timestamp: now,
          severity: 'info',
          dealId: deal.id,
          read: false
        });
      }
      (deal.underlyingAssets || []).forEach(function (a) {
        if (!a.barrierLevel || !a.currentPrice) return;
        var dist = (a.currentPrice - a.barrierLevel) / a.barrierLevel;
        if (dist <= 0) {
          newAlerts.push({
            id: 'ALERT-' + deal.id + '-' + a.symbol + '-BREACH',
            type: 'Barrier Breach',
            message: a.symbol + ' breached barrier (' + a.currentPrice.toFixed(2) + ' ≤ ' + a.barrierLevel.toFixed(2) + ')',
            timestamp: now,
            severity: 'critical',
            dealId: deal.id,
            read: false
          });
        } else if (dist <= thresholdPct) {
          newAlerts.push({
            id: 'ALERT-' + deal.id + '-' + a.symbol + '-PROX',
            type: 'Barrier Proximity',
            message: a.symbol + ' within ' + (thresholdPct * 100).toFixed(0) + '% of barrier',
            timestamp: now,
            severity: 'warning',
            dealId: deal.id,
            read: false
          });
        }
      });
    });
    HKELIApp.data.alerts = newAlerts;
    // Acknowledge-aware: an alert the user already dealt with keeps its
    // read state across the rebuild, so the badge can actually drop to
    // zero instead of snapping back up on the next price tick.
    if (typeof AlertRules !== 'undefined') {
      AlertRules.applyAcknowledgements(HKELIApp.data.alerts);
    }
    maybeNotifyForNewAlerts(HKELIApp.data.alerts);
    updateNotificationBadge();
  }

  // ──────────────────────────────────────────────────────────────────
  // Browser notifications — opt-in, fires once per unread alert while
  // the tab is in the background. Without this, every alert the app
  // builds is invisible unless you're already looking at the tab.
  // ──────────────────────────────────────────────────────────────────
  function notificationsSupported() {
    return typeof Notification !== 'undefined';
  }

  function notificationsGranted() {
    return notificationsSupported() && Notification.permission === 'granted';
  }

  /** Ask for permission. Must be called from a user gesture. */
  async function requestNotificationPermission() {
    if (!notificationsSupported()) {
      showToast('This browser does not support notifications', 'warning');
      return 'unsupported';
    }
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') {
      showToast('Notifications are blocked for this site — enable them in your browser settings', 'warning');
      return 'denied';
    }
    var result = await Notification.requestPermission();
    updateNotificationSettingsUI();
    if (result === 'granted') {
      showToast('Desktop notifications enabled', 'success');
      try { new Notification('HK ELI', { body: 'Alerts will appear here while the tab is in the background.' }); }
      catch (e) { /* some browsers require a service worker; ignore */ }
    } else {
      showToast('Notifications not enabled', 'info');
    }
    return result;
  }

  function updateNotificationSettingsUI() {
    var btn = document.getElementById('enable-notifications');
    var note = document.getElementById('notification-permission-note');
    if (!btn) return;
    if (!notificationsSupported()) {
      btn.disabled = true;
      if (note) note.textContent = 'This browser does not support the Notifications API.';
      return;
    }
    if (Notification.permission === 'granted') {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-check"></i> Notifications enabled';
      if (note) note.textContent = 'Alerts fire even when this tab is in the background.';
      return;
    }
    if (Notification.permission === 'denied') {
      btn.disabled = true;
      if (note) note.textContent = 'Blocked for this site. Re-enable it in your browser\u2019s site settings.';
      return;
    }
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-bell"></i> Enable desktop notifications';
    if (note) note.textContent = 'Get alerted about barrier breaches and custom rules even when this tab is in the background.';
  }

  /**
   * Fire a desktop notification for each alert that is unread AND that
   * we haven't notified about in this session. No-op when the tab is
   * visible (you're already looking at it) or permission wasn't granted.
   */
  function maybeNotifyForNewAlerts(alerts) {
    if (!notificationsGranted()) return;
    // Already watching the tab — don't be annoying.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
    var fresh = (alerts || []).filter(function (a) { return !a.read && !a.__notified; });
    if (!fresh.length) return;
    // Cap the burst so one bad refresh can't spam 20 notifications.
    fresh.slice(0, 3).forEach(function (a) {
      a.__notified = true;
      try {
        var n = new Notification('HK ELI — ' + a.type, {
          body: a.message,
          tag: a.id,
          icon: 'assets/icon-192.svg',
          silent: false
        });
        n.onclick = function () {
          try { window.focus(); } catch (e) {}
          switchView('alerts');
          n.close();
        };
      } catch (e) { /* service worker-only platforms: skip */ }
    });
    if (fresh.length > 3) {
      try {
        var more = new Notification('HK ELI — ' + (fresh.length - 3) + ' more alerts', {
          body: 'Open the app to review the rest.',
          tag: 'hk-eli-more'
        });
        more.onclick = function () { try { window.focus(); } catch (e) {} switchView('alerts'); };
      } catch (e) { /* ignore */ }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Custom alert rules (js/alerts.js)
  // ──────────────────────────────────────────────────────────────────
  function getAlertRules() {
    var s = getCurrentSettings();
    return Array.isArray(s.alertRules) ? s.alertRules : [];
  }

  function saveAlertRules(rules) {
    Storage.setSettings({ alertRules: rules });
  }

  /** Portfolio-level helpers the rule evaluator needs. */
  function alertRuleHelpers() {
    var deals = HKELIApp.data.eliDeals;
    var portfolioPnl = deals.reduce(function (s, d) { return s + (d.pnl || 0); }, 0);
    return {
      portfolioPnl: portfolioPnl,
      dealHealth: (typeof Health !== 'undefined')
        ? function (d) { return Health.computeHealth(d, deals); }
        : null
    };
  }

  function rebuildCustomAlerts() {
    if (typeof AlertRules === 'undefined') return;
    var rules = getAlertRules();
    if (!rules.length) return;
    var fired = AlertRules.evaluateRules(
      rules, HKELIApp.data.eliDeals, alertRuleHelpers()
    );
    // Custom alerts live alongside the built-ins but are kept separate so
    // clearing built-ins doesn't wipe user rules and vice versa.
    HKELIApp.data.customAlerts = fired;
    HKELIApp.data.alerts = HKELIApp.data.alerts.concat(fired);
    updateNotificationBadge();
  }

  /** Populate the rule-target dropdown for the currently selected rule type. */
  function refreshAlertRuleTargets() {
    var typeSel = document.getElementById('alert-rule-type');
    var targetSel = document.getElementById('alert-rule-target');
    if (!typeSel || !targetSel) return;
    var type = typeSel.value;
    var meta = (typeof AlertRules !== 'undefined') ? AlertRules.TYPE_META[type] : null;
    if (!meta) return;
    var opts = ['<option value="">— target —</option>'];
    var seenSymbols = {};
    var seenTags = {};
    var seenSectors = {};

    if (meta.scope === 'symbol') {
      HKELIApp.data.eliDeals.forEach(function (d) {
        (d.underlyingAssets || []).forEach(function (a) {
          if (a.symbol && !seenSymbols[a.symbol]) {
            seenSymbols[a.symbol] = true;
            opts.push('<option value="' + escapeHtml(a.symbol) + '">' + escapeHtml(a.symbol) + '</option>');
          }
        });
      });
    } else if (meta.scope === 'tag') {
      HKELIApp.data.eliDeals.forEach(function (d) {
        (d.tags || []).forEach(function (t) {
          if (!seenTags[t]) {
            seenTags[t] = true;
            opts.push('<option value="' + escapeHtml(t) + '">#' + escapeHtml(t) + '</option>');
          }
        });
      });
      if (!opts.length) opts.push('<option value="" disabled>(no tags in use)</option>');
    } else if (meta.scope === 'sector') {
      if (typeof Sectors !== 'undefined') {
        HKELIApp.data.eliDeals.forEach(function (d) {
          (d.underlyingAssets || []).forEach(function (a) {
            var s = Sectors.lookup(a.symbol).sector;
            if (s && !seenSectors[s]) {
              seenSectors[s] = true;
              opts.push('<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>');
            }
          });
        });
      }
      if (opts.length === 1) opts.push('<option value="" disabled>(no sectors in use)</option>');
    } else {
      // deal scope — offer the whole portfolio plus each deal
      opts.push('<option value="portfolio">Whole portfolio</option>');
      HKELIApp.data.eliDeals.forEach(function (d) {
        opts.push('<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.dealName) + '</option>');
      });
    }
    targetSel.innerHTML = opts.join('');
    var valEl = document.getElementById('alert-rule-value');
    if (valEl) valEl.placeholder = meta.unit === 'days' ? 'days' : (meta.unit === '/100' ? 'score' : (meta.unit === 'HK$' ? 'HK$' : ''));
  }

  function renderAlertRulesList() {
    var el = document.getElementById('alert-rules-list');
    if (!el || typeof AlertRules === 'undefined') return;
    var rules = getAlertRules();
    if (!rules.length) {
      el.innerHTML = '<p class="form-help">No custom rules yet.</p>';
      return;
    }
    var esc = AlertRules.escapeHtml;
    el.innerHTML = rules.map(function (r) {
      var meta = AlertRules.TYPE_META[r.type] || { label: r.type, unit: '' };
      var label = meta.label + ' ' + (meta.unit === 'HK$' ? 'HK$' + r.value : r.value + (meta.unit === '/100' ? '/100' : (meta.unit === 'days' ? ' days' : '')));
      return '<div class="alert-rule-row' + (r.enabled === false ? ' disabled' : '') + '">'
        + '<label class="alert-rule-toggle">'
        + '<input type="checkbox" data-rule-toggle="' + esc(r.id) + '"' + (r.enabled === false ? '' : ' checked') + '>'
        + '</label>'
        + '<span class="alert-rule-text">' + esc(r.target) + ' · ' + esc(label) + '</span>'
        + '<button type="button" class="alert-rule-remove" data-rule-remove="' + esc(r.id) + '" aria-label="Remove rule">'
        + '<i class="fas fa-trash"></i></button>'
        + '</div>';
    }).join('');

    el.querySelectorAll('[data-rule-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        saveAlertRules(AlertRules.removeRule(getAlertRules(), b.dataset.ruleRemove));
        renderAlertRulesList();
        rebuildAlertsFromState();
      rebuildCustomAlerts();
        refreshDealViews();
        showToast('Rule removed', 'info');
      });
    });
    el.querySelectorAll('[data-rule-toggle]').forEach(function (c) {
      c.addEventListener('change', function () {
        saveAlertRules(AlertRules.toggleRule(getAlertRules(), c.dataset.ruleToggle));
        renderAlertRulesList();
        rebuildAlertsFromState();
      rebuildCustomAlerts();
        refreshDealViews();
      });
    });
  }

  function setupAlertRuleUI() {
    if (document.getElementById('alert-rule-add') && document.getElementById('alert-rule-add').dataset.bound) return;
    var typeSel = document.getElementById('alert-rule-type');
    var addBtn = document.getElementById('alert-rule-add');
    if (!typeSel || !addBtn) return;
    addBtn.dataset.bound = '1';

    typeSel.addEventListener('change', refreshAlertRuleTargets);

    addBtn.addEventListener('click', function () {
      var type = typeSel.value;
      var target = (document.getElementById('alert-rule-target') || {}).value;
      var value = (document.getElementById('alert-rule-value') || {}).value;
      var res = AlertRules.addRule(getAlertRules(), { type: type, target: target, value: value });
      if (!res.added) { showToast('Pick a target and a numeric value', 'warning'); return; }
      saveAlertRules(res.rules);
      document.getElementById('alert-rule-value').value = '';
      renderAlertRulesList();
      rebuildAlertsFromState();
      rebuildCustomAlerts();
      refreshDealViews();
      showToast('Rule added — it will be checked on every refresh', 'success');
    });
  }
  function renderAlerts() {
    var list = document.getElementById('alerts-list');
    if (!list) return;
    if (!HKELIApp.data.alerts.length) {
      list.innerHTML = '<div class="card"><div class="card__body">' +
        emptyState('empty-alerts', 'All clear',
          'No alerts. Add ELI deals to start monitoring barrier and maturity risks.',
          'A calm bell with a checkmark') +
        '</div></div>';
      return;
    }
    var unread = (typeof AlertRules !== 'undefined')
      ? AlertRules.unreadCount(HKELIApp.data.alerts)
      : HKELIApp.data.alerts.length;

    var rows = HKELIApp.data.alerts.map(function (a) {
      var esc = typeof AlertRules !== 'undefined' ? AlertRules.escapeHtml : escapeHtml;
      var icon = a.severity === 'critical' ? 'triangle' : (a.severity === 'warning' ? 'exclamation' : 'circle');
      return '<div class="alert-item severity-' + a.severity + (a.read ? ' read' : '') + '">' +
        '<div class="alert-icon"><i class="fas fa-exclamation-' + icon + '"></i></div>' +
        '<div class="alert-content">' +
          '<h4>' + esc(a.type) + (a.custom ? ' <span class="badge badge-par">rule</span>' : '') + '</h4>' +
          '<p>' + esc(a.message) + '</p>' +
          '<span class="alert-time">' + formatTimeAgo(a.timestamp) + '</span>' +
        '</div>' +
        '<div class="alert-actions">' +
          (a.read
            ? '<span class="alert-acked">Acknowledged</span>'
            : '<button type="button" class="alert-ack-btn" data-ack-id="' + esc(a.id) + '">Acknowledge</button>') +
        '</div>' +
      '</div>';
    }).join('');

    list.innerHTML =
      '<div class="alert-toolbar">' +
        '<span class="alert-toolbar-count">' + unread + ' unread of ' + HKELIApp.data.alerts.length + '</span>' +
        '<div class="alert-toolbar-actions">' +
          '<button type="button" class="btn btn--secondary btn--sm" id="ack-all-btn">Acknowledge all</button>' +
          '<button type="button" class="btn btn--outline btn--sm" id="reset-acks-btn">Reset</button>' +
          '<button type="button" class="btn btn--outline btn--sm" id="clear-alerts-btn">Clear list</button>' +
        '</div>' +
      '</div>' + rows;

    list.querySelectorAll('[data-ack-id]').forEach(function (b) {
      b.addEventListener('click', function () { acknowledgeAlert(b.dataset.ackId); });
    });
    var ackAll = document.getElementById('ack-all-btn');
    if (ackAll) ackAll.addEventListener('click', acknowledgeAllAlerts);
    var resetBtn = document.getElementById('reset-acks-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetAlertAcks);
    var clearBtn = document.getElementById('clear-alerts-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearAllAlerts);
  }

  // ──────────────────────────────────────────────────────────────────
  // Payoff view (worst-performer projection per deal)
  // ──────────────────────────────────────────────────────────────────
  var payoffCharts = {};
  function populatePayoffDealSelect() {
    var sel = document.getElementById('payoff-deal-select');
    if (!sel) return;
    var prev = sel.value;
    var opts = '<option value="">— Select a deal —</option>'
      + HKELIApp.data.eliDeals.map(function (d) {
          return '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.dealName) + ' (' + escapeHtml(d.id) + ')</option>';
        }).join('');
    sel.innerHTML = opts;
    if (prev && HKELIApp.data.eliDeals.some(function (d) { return d.id === prev; })) {
      sel.value = prev;
    }
  }

  function payoffCurrentShockPct() {
    var el = document.getElementById('payoff-shock-input');
    return el ? (parseFloat(el.value) / 100) : 0;
  }

  function renderPayoffView() {
    var sel = document.getElementById('payoff-deal-select');
    var empty = document.getElementById('payoff-empty');
    var detail = document.getElementById('payoff-detail');
    if (!sel) return;
    if (!sel.value) {
      if (empty) empty.classList.remove('hidden');
      if (detail) detail.classList.add('hidden');
      return;
    }
    var deal = HKELIApp.data.eliDeals.find(function (d) { return d.id === sel.value; });
    if (!deal) {
      if (empty) empty.classList.remove('hidden');
      if (detail) detail.classList.add('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    if (detail) detail.classList.remove('hidden');

    var shock = payoffCurrentShockPct();
    var shockClone = JSON.parse(JSON.stringify(deal));
    (shockClone.underlyingAssets || []).forEach(function (a) {
      a.hypotheticalPrice = (a.currentPrice || a.strikePrice) * (1 + shock);
    });
    var proj = Payoff.projectPayoff(shockClone);

    var cashEl = document.getElementById('payoff-cash');
    var coupEl = document.getElementById('payoff-coupon');
    var totalEl = document.getElementById('payoff-total');
    var knockinEl = document.getElementById('payoff-knockin');
    var worstEl = document.getElementById('payoff-worst');
    if (cashEl) cashEl.textContent = formatCurrency(proj.cashPayoff);
    if (coupEl) coupEl.textContent = formatCurrency(proj.coupon);
    if (totalEl) {
      totalEl.textContent = (proj.totalReturn >= 0 ? '+' : '') + formatCurrency(proj.totalReturn)
        + ' (' + (proj.totalReturnPct * 100).toFixed(2) + '%)';
      totalEl.className = proj.totalReturn >= 0 ? 'positive' : 'negative';
    }
    if (knockinEl) {
      knockinEl.textContent = proj.knockInTriggered ? 'Knock-in triggered' : 'No knock-in';
      knockinEl.className = proj.knockInTriggered ? 'negative' : 'positive';
    }
    if (worstEl) {
      var pct = (proj.worstReturnPct * 100).toFixed(2);
      worstEl.textContent = 'Worst: ' + proj.worstSymbol + ' (' + pct + '%)';
    }

    // Per-symbol table
    var tbl = document.getElementById('payoff-table');
    if (tbl) {
      var rows = (deal.underlyingAssets || []).map(function (a) {
        var hp = (a.currentPrice || a.strikePrice) * (1 + shock);
        var ret = a.strikePrice ? ((hp - a.strikePrice) / a.strikePrice) * 100 : 0;
        var distBarrier = a.barrierLevel ? ((hp - a.barrierLevel) / a.barrierLevel) * 100 : null;
        var tag = Sectors.lookup(a.symbol);
        return '<tr>'
          + '<td><strong>' + escapeHtml(a.symbol) + '</strong><br><small class="form-help">' + escapeHtml(a.name || '') + '</small></td>'
          + '<td><span class="badge badge-sector">' + tag.sector + '</span></td>'
          + '<td>' + formatHKPrice(a.strikePrice) + '</td>'
          + '<td>' + formatHKPrice(a.barrierLevel) + '</td>'
          + '<td>' + formatHKPrice(a.currentPrice) + '</td>'
          + '<td>' + formatHKPrice(hp) + '</td>'
          + '<td class="' + (ret >= 0 ? 'positive' : 'negative') + '">' + (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%</td>'
          + '<td class="' + (distBarrier == null ? '' : (distBarrier <= 0 ? 'negative' : (distBarrier < 10 ? 'warning' : ''))) + '">'
          + (distBarrier == null ? '—' : (distBarrier.toFixed(2) + '% above'))
          + '</td>'
          + '<td>' + ((a.weight * 100).toFixed(0)) + '%</td>'
          + '</tr>';
      }).join('');
      tbl.innerHTML = '<thead><tr><th>Symbol</th><th>Sector</th><th>Strike</th><th>Barrier</th>'
        + '<th>Current</th><th>Hypothetical</th><th>Return</th><th>vs Barrier</th><th>Weight</th></tr></thead>'
        + '<tbody>' + rows + '</tbody>';
    }

    // Payoff curve sweep
    var sweep = Payoff.sweepShocks(deal, { from: -0.5, to: 0.2, steps: 15 });
    var curveCanvas = document.getElementById('payoff-curve-chart');
    if (curveCanvas && typeof Chart !== 'undefined') {
      if (payoffCharts.curve) payoffCharts.curve.destroy();
      var labels = sweep.shocks.map(function (s) { return (s * 100).toFixed(0) + '%'; });
      var data = sweep.returns.map(function (r) { return +(r * 100).toFixed(3); });
      payoffCharts.curve = new Chart(curveCanvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Total return (%)',
            data: data,
            borderColor: '#4fc3f7',
            backgroundColor: 'rgba(79,195,247,0.15)',
            fill: true,
            tension: 0.25,
            pointRadius: 3
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            y: { ticks: { callback: function (v) { return v + '%'; } } },
            x: { title: { display: true, text: 'Uniform shock to all underlyings' } }
          }
        }
      });
    }

    renderPayoffHistoryChart(deal);
  }

  function renderPayoffHistoryChart(deal) {
    var canvas = document.getElementById('payoff-history-chart');
    var emptyEl = document.getElementById('payoff-history-empty');
    if (!canvas || typeof Chart === 'undefined' || typeof Db === 'undefined') return;
    Db.getPriceHistory(
      (deal.underlyingAssets || []).map(function (a) { return a.symbol; }),
      { limit: 90 }
    ).then(function (history) {
      var any = Object.keys(history).some(function (k) { return history[k].length > 1; });
      if (emptyEl) emptyEl.classList.toggle('hidden', any);
      var dateSet = Object.create(null);
      Object.keys(history).forEach(function (sym) {
        history[sym].forEach(function (h) {
          dateSet[new Date(h.timestamp).toISOString().slice(0, 10)] = true;
        });
      });
      var dates = Object.keys(dateSet).sort();
      var palette = ['#4fc3f7', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6'];
      var datasets = Object.keys(history).map(function (sym, idx) {
        var points = dates.map(function (d) {
          var match = history[sym].find(function (h) {
            return new Date(h.timestamp).toISOString().slice(0, 10) === d;
          });
          return match ? match.price : null;
        });
        return {
          label: sym,
          data: points,
          borderColor: palette[idx % palette.length],
          backgroundColor: 'transparent',
          spanGaps: true,
          tension: 0.2,
          pointRadius: 2
        };
      });
      if (payoffCharts.history) payoffCharts.history.destroy();
      payoffCharts.history = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: dates, datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            y: { ticks: { callback: function (v) { return 'HK$' + v; } } },
            x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }
          },
          plugins: { legend: { position: 'bottom' } }
        }
      });
    });
  }

  function setupPayoffEventListeners() {
    var sel = document.getElementById('payoff-deal-select');
    var slider = document.getElementById('payoff-shock-input');
    var shockVal = document.getElementById('payoff-shock-value');
    if (sel) sel.addEventListener('change', renderPayoffView);
    if (slider) {
      slider.addEventListener('input', function () {
        if (shockVal) shockVal.textContent = slider.value + '%';
      });
      slider.addEventListener('change', renderPayoffView);
    }
  }

  function setupCalendarEventListeners() {
    var horizon = document.getElementById('calendar-horizon');
    var refresh = document.getElementById('calendar-refresh');
    if (horizon && !horizon.dataset.bound) {
      horizon.dataset.bound = '1';
      horizon.addEventListener('change', renderCalendarView);
    }
    if (refresh && !refresh.dataset.bound) {
      refresh.dataset.bound = '1';
      refresh.addEventListener('click', renderCalendarView);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Scenarios view (uniform or worst-of stress test across portfolio)
  // ──────────────────────────────────────────────────────────────────
  function renderScenariosView() {
    var mode = document.getElementById('scenario-mode');
    var slider = document.getElementById('scenario-shock-input');
    var valEl = document.getElementById('scenario-shock-value');
    var runBtn = document.getElementById('scenario-run-btn');
    var tbl = document.getElementById('scenario-table');
    if (!slider || !tbl) return;

    function shock() { return parseFloat(slider.value) / 100; }

    function refreshSlider() {
      if (valEl) valEl.textContent = (slider.value > 0 ? '+' : '') + slider.value + '%';
    }
    refreshSlider();

    function run() {
      var deals = HKELIApp.data.eliDeals;
      if (!deals.length) {
        tbl.innerHTML = '<tr><td>No deals yet.</td></tr>';
        return;
      }
      var modeVal = mode ? mode.value : 'uniform';
      var s = shock();
      var totals = { before: 0, after: 0, knockIn: 0 };
      var rows = deals.map(function (deal) {
        var clone = JSON.parse(JSON.stringify(deal));
        if (modeVal === 'uniform') {
          (clone.underlyingAssets || []).forEach(function (a) {
            a.hypotheticalPrice = (a.currentPrice || a.strikePrice) * (1 + s);
          });
        } else {
          var w = Payoff.worstPerformer(clone.underlyingAssets);
          if (w) {
            (clone.underlyingAssets || []).forEach(function (a) {
              if (a.symbol === w.asset.symbol) {
                a.hypotheticalPrice = (a.currentPrice || a.strikePrice) * (1 + s);
              } else {
                a.hypotheticalPrice = a.currentPrice;
              }
            });
          }
        }
        var proj = Payoff.projectPayoff(clone);
        totals.before += deal.currentValue || 0;
        totals.after += proj.cashPayoff;
        if (proj.knockInTriggered) totals.knockIn++;
        var pnlClass = proj.totalReturn >= 0 ? 'positive' : 'negative';
        return '<tr>'
          + '<td><strong>' + escapeHtml(deal.dealName) + '</strong><br><small class="form-help">' + escapeHtml(deal.id) + '</small></td>'
          + '<td>' + formatCurrency(deal.currentValue) + '</td>'
          + '<td>' + (proj.knockInTriggered ? '<span class="badge badge-knockin">Knock-in</span>' : '<span class="badge badge-par">Par</span>') + '</td>'
          + '<td>' + formatCurrency(proj.cashPayoff) + '</td>'
          + '<td class="' + pnlClass + '">' + (proj.totalReturn >= 0 ? '+' : '') + formatCurrency(proj.totalReturn)
          + '<br><small>' + (proj.totalReturnPct * 100).toFixed(2) + '%</small></td>'
          + '<td>' + proj.worstSymbol + '<br><small>(' + (proj.worstReturnPct * 100).toFixed(2) + '%)</small></td>'
          + '</tr>';
      }).join('');
      var totPnl = totals.after - totals.before;
      var totPct = totals.before > 0 ? (totPnl / totals.before) * 100 : 0;
      var header = '<tr>'
        + '<th>Deal</th><th>Current value</th><th>Status</th><th>Cash at maturity</th><th>P&L (vs current)</th><th>Worst performer</th>'
        + '</tr>';
      tbl.innerHTML = '<thead>' + header + '</thead><tbody>' + rows
        + '<tr style="font-weight:600; border-top:2px solid var(--color-border);">'
        + '<td>Total</td>'
        + '<td>' + formatCurrency(totals.before) + '</td>'
        + '<td>' + totals.knockIn + ' knock-ins</td>'
        + '<td>' + formatCurrency(totals.after) + '</td>'
        + '<td class="' + (totPnl >= 0 ? 'positive' : 'negative') + '">'
        + (totPnl >= 0 ? '+' : '') + formatCurrency(totPnl)
        + '<br><small>' + totPct.toFixed(2) + '%</small></td>'
        + '<td>—</td>'
        + '</tr></tbody>';

      var resultEl = document.getElementById('scenario-result');
      if (resultEl) {
        var label = (s >= 0 ? '+' : '') + (s * 100).toFixed(0) + '%';
        var desc = modeVal === 'uniform'
          ? 'Every underlying dropped/gained ' + label + '.'
          : 'Only the current worst performer dropped/gained ' + label + '.';
        resultEl.innerHTML = '<div class="card"><div class="card__body"><h3>Scenario: ' + desc + '</h3>'
          + '<p>Portfolio cash at maturity: <strong>' + formatCurrency(totals.after)
          + '</strong> (currently ' + formatCurrency(totals.before) + ').</p></div></div>';
      }
    }

    renderHeatmapTable();
  }

  // Stress-test heatmap: portfolio cash at maturity across (shock, months-left).
  function renderHeatmapTable() {
    var tbl = document.getElementById('heatmap-table');
    if (!tbl || typeof Payoff === 'undefined') return;
    var deals = HKELIApp.data.eliDeals;
    if (!deals.length) {
      tbl.innerHTML = '<tr><td>' +
        emptyState('empty-scenarios', 'No deals to stress-test',
          'Add an ELI deal to see how the portfolio settles across shock levels and time horizons.',
          'A heatmap grid grading from red losses to green gains') +
        '</td></tr>';
      return;
    }
    var shocks = [-0.50, -0.40, -0.30, -0.20, -0.10, 0, 0.20];
    var horizons = [3, 6, 12, 24, 36];
    var portfolioCurrent = deals.reduce(function (s, d) { return s + (d.currentValue || 0); }, 0);
    var html = '<thead><tr><th>Shock \\ Months left</th>';
    horizons.forEach(function (m) { html += '<th>' + m + 'mo</th>'; });
    html += '</tr></thead><tbody>';
    shocks.forEach(function (shock) {
      html += '<tr><th>' + (shock * 100).toFixed(0) + '%</th>';
      horizons.forEach(function (m) {
        var totalPayoff = 0;
        var knockInCount = 0;
        deals.forEach(function (d) {
          var clone = JSON.parse(JSON.stringify(d));
          (clone.underlyingAssets || []).forEach(function (a) {
            a.hypotheticalPrice = (a.currentPrice || a.strikePrice) * (1 + shock);
          });
          var proj = Payoff.projectPayoff(clone);
          // Coupon earned over the shortened term (assume quarterly payments)
          var couponTotal = (d.nominalAmount || 0) * (d.couponRate || 0) / 100 * (m / 12);
          totalPayoff += proj.cashPayoff + couponTotal;
          if (proj.knockInTriggered) knockInCount++;
        });
        var delta = totalPayoff - portfolioCurrent;
        var pct = (delta / Math.max(portfolioCurrent, 1)) * 100;
        // Color gradient: deeper red for bigger losses, deeper green for gains
        var intensity = Math.min(1, Math.abs(pct) / 30);
        var bg = delta >= 0
          ? 'rgba(74,222,128,' + (0.10 + intensity * 0.40) + ')'
          : 'rgba(248,113,113,' + (0.10 + intensity * 0.40) + ')';
        var title = 'Shock ' + (shock*100).toFixed(0) + '% at ' + m + 'mo → cash ' + formatCurrency(totalPayoff)
          + ' (' + (delta >= 0 ? '+' : '') + pct.toFixed(1) + '%, ' + knockInCount + ' knock-ins)';
        html += '<td style="background:' + bg + '" title="' + title + '">'
          + '<strong>' + formatCurrency(totalPayoff) + '</strong>'
          + '<br><small>' + (delta >= 0 ? '+' : '') + pct.toFixed(1) + '%</small>'
          + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody>';
    tbl.innerHTML = html;

    if (slider && !slider.dataset.boundRun) {
      slider.dataset.boundRun = '1';
      slider.addEventListener('input', refreshSlider);
    }
    if (runBtn && !runBtn.dataset.boundRun) {
      runBtn.dataset.boundRun = '1';
      runBtn.addEventListener('click', run);
    }
    if (mode && !mode.dataset.boundRun) {
      mode.dataset.boundRun = '1';
      mode.addEventListener('change', run);
    }
    run();
  }

  // ──────────────────────────────────────────────────────────────────
  // Watchlist view
  // ──────────────────────────────────────────────────────────────────
  function renderWatchlistView() {
    var sel = document.getElementById('watch-symbol');
    if (sel && sel.options.length <= 1) {
      // Populate from the hard-coded HK stock catalog.
      var opts = '<option value="">— pick a stock —</option>';
      (HKELIApp.data.hkStocks || []).forEach(function (s) {
        opts += '<option value="' + s.symbol + '">' + s.symbol + ' — ' + s.name + '</option>';
      });
      sel.innerHTML = opts;
    }
    var list = typeof Watchlist !== 'undefined' ? Watchlist.list() : [];
    var container = document.getElementById('watchlist-table');
    var titleEl = document.getElementById('watchlist-count-title');
    if (titleEl) titleEl.textContent = 'Tracked stocks (' + list.length + ')';
    if (!container) return;
    if (!list.length) {
      container.innerHTML = emptyState('empty-watchlist', 'No stocks tracked yet',
        'Add one above to monitor entry opportunities.',
        'An eye over a stock ticker row');
      return;
    }
    // Look up live price for each watch entry.
    var rows = list.map(function (e) {
      var live = null;
      (HKELIApp.data.eliDeals || []).forEach(function (d) {
        (d.underlyingAssets || []).forEach(function (a) {
          if (a.symbol === e.symbol) live = a.currentPrice;
        });
      });
      var dist = (typeof e.targetEntry === 'number' && live) ? ((e.targetEntry - live) / live * 100) : null;
      return '<tr>'
        + '<td><strong>' + e.symbol + '</strong></td>'
        + '<td>' + formatCurrency(live) + (live ? ' <small class="form-help">live</small>' : ' <small class="form-help">—</small>') + '</td>'
        + '<td>' + (typeof e.targetEntry === 'number' ? formatCurrency(e.targetEntry) : '<span class="form-help">—</span>') + '</td>'
        + '<td>' + (dist == null ? '<span class="form-help">—</span>' : (dist >= 0 ? '+' : '') + dist.toFixed(1) + '% to target') + '</td>'
        + '<td>' + escapeHtml(e.note || '') + '</td>'
        + '<td><button class="watch-remove-btn" data-symbol="' + e.symbol + '" type="button" aria-label="Remove"><i class="fas fa-trash"></i></button></td>'
        + '</tr>';
    }).join('');
    container.innerHTML = '<div class="table-wrap"><table class="payoff-table">'
      + '<thead><tr><th>Symbol</th><th>Current</th><th>Target</th><th>Distance</th><th>Note</th><th></th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>';
    // Wire remove buttons
    container.querySelectorAll('.watch-remove-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (typeof Watchlist !== 'undefined') {
          Watchlist.remove(btn.dataset.symbol);
          renderWatchlistView();
        }
      });
    });
  }

  function setupWatchlistListeners() {
    var addBtn = document.getElementById('watch-add-btn');
    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', function () {
        var sym = document.getElementById('watch-symbol').value;
        if (!sym) { showToast('Pick a stock first', 'warning'); return; }
        var target = parseFloat(document.getElementById('watch-target').value);
        var note = document.getElementById('watch-note').value;
        if (typeof Watchlist !== 'undefined') {
          Watchlist.add({ symbol: sym, targetEntry: isNaN(target) ? null : target, note: note });
          showToast(sym + ' added to watchlist', 'success');
          document.getElementById('watch-target').value = '';
          document.getElementById('watch-note').value = '';
          renderWatchlistView();
        }
      });
    }
  }

  function setupCompareListeners() {
    var a = document.getElementById('compare-deal-a');
    var b = document.getElementById('compare-deal-b');
    if (a && !a.dataset.bound) {
      a.dataset.bound = '1';
      a.addEventListener('change', renderCompareView);
    }
    if (b && !b.dataset.bound) {
      b.dataset.bound = '1';
      b.addEventListener('change', renderCompareView);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Compare view (side-by-side two-deal comparison)
  // ──────────────────────────────────────────────────────────────────
  function populateCompareDealSelects() {
    var a = document.getElementById('compare-deal-a');
    var b = document.getElementById('compare-deal-b');
    if (!a || !b) return;
    // Idempotent: only rebuild if the option list is stale (missing deals).
    if (a.dataset.populatedFor === String(HKELIApp.data.eliDeals.length) &&
        b.dataset.populatedFor === String(HKELIApp.data.eliDeals.length)) {
      return;
    }
    var opts = '<option value="">— pick a deal —</option>'
      + HKELIApp.data.eliDeals.map(function (d) {
          return '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.dealName) + ' (' + escapeHtml(d.id) + ')</option>';
        }).join('');
    a.innerHTML = opts;
    b.innerHTML = opts;
    a.dataset.populatedFor = String(HKELIApp.data.eliDeals.length);
    b.dataset.populatedFor = String(HKELIApp.data.eliDeals.length);
  }

  function renderCompareView() {
    populateCompareDealSelects();
    var a = document.getElementById('compare-deal-a');
    var b = document.getElementById('compare-deal-b');
    var out = document.getElementById('compare-result');
    if (!out) return;
    var idA = a && a.value, idB = b && b.value;
    if (!idA || !idB) {
      out.innerHTML = '<div class="card"><div class="card__body">' +
        emptyState('empty-compare', 'Pick two deals to compare',
          'Choose a deal above for both A and B to see a side-by-side comparison.',
          'Two panels side by side, one marked better') +
        '</div></div>';
      return;
    }
    var dealA = HKELIApp.data.eliDeals.find(function (d) { return d.id === idA; });
    var dealB = HKELIApp.data.eliDeals.find(function (d) { return d.id === idB; });
    if (!dealA || !dealB) { out.innerHTML = '<p>One of the deals was not found.</p>'; return; }
    var hA = Health.computeHealth(dealA, HKELIApp.data.eliDeals);
    var hB = Health.computeHealth(dealB, HKELIApp.data.eliDeals);
    var pA = Payoff.projectPayoff(dealA);
    var pB = Payoff.projectPayoff(dealB);
    var better = (hA.total === hB.total) ? null : (hA.total > hB.total ? 'A' : 'B');
    function row(label, va, vb, fmt) {
      fmt = fmt || function (v) { return v; };
      var betterMark = (better === 'A' && va > vb) ? ' <span class="badge badge-par">better</span>'
                    : (better === 'B' && vb > va) ? ' <span class="badge badge-par">better</span>'
                    : '';
      return '<tr><td>' + label + '</td>'
        + '<td class="' + (better === 'A' && va > vb ? 'positive' : '') + '">' + fmt(va) + betterMark + '</td>'
        + '<td class="' + (better === 'B' && vb > va ? 'positive' : '') + '">' + fmt(vb) + (betterMark ? '' : '') + '</td></tr>';
    }
    out.innerHTML = '<div class="card"><div class="card__body">'
      + '<h3>Comparison</h3>'
      + '<div class="table-wrap"><table class="payoff-table">'
      + '<thead><tr><th></th><th>Deal A: ' + escapeHtml(dealA.dealName) + '</th><th>Deal B: ' + escapeHtml(dealB.dealName) + '</th></tr></thead>'
      + '<tbody>'
      + row('Health (0-100)', hA.total, hB.total, function (v) { return v + ' (' + v.toFixed(0) + ')'; })
      + row('Health grade', hA.grade, hB.grade)
      + row('Current value', dealA.currentValue, dealB.currentValue, formatCurrency)
      + row('Purchase price', dealA.purchasePrice, dealB.purchasePrice, formatCurrency)
      + row('P&L', dealA.pnl, dealB.pnl, function (v) { return (v >= 0 ? '+' : '') + formatCurrency(v); })
      + row('Coupon rate', dealA.couponRate, dealB.couponRate, function (v) { return v + '%'; })
      + row('Issuer', escapeHtml(dealA.issuer), escapeHtml(dealB.issuer), function (v) { return v; })
      + row('Settlement', escapeHtml(dealA.settlementMethod), escapeHtml(dealB.settlementMethod), function (v) { return v; })
      + row('Knock-in at current?', pA.knockInTriggered ? 'Yes' : 'No', pB.knockInTriggered ? 'Yes' : 'No')
      + row('Payoff if settles now', pA.cashPayoff, pB.cashPayoff, formatCurrency)
      + row('Worst performer', pA.worstSymbol, pB.worstSymbol)
      + row('Worst return vs strike', pA.worstReturnPct, pB.worstReturnPct, function (v) { return (v * 100).toFixed(1) + '%'; })
      + '</tbody></table></div>'
      + '</div></div>';
  }

  function updateNotificationBadge() {
    var badge = document.getElementById('notification-count');
    if (!badge) return;
    // Count only unacknowledged alerts — acknowledging one must visibly
    // move the number, otherwise "Clear All" looks broken.
    var n = (typeof AlertRules !== 'undefined')
      ? AlertRules.unreadCount(HKELIApp.data.alerts)
      : HKELIApp.data.alerts.length;
    badge.textContent = n;
    badge.classList.toggle('zero', n === 0);
    var bell = document.getElementById('notifications-bell');
    if (bell) bell.setAttribute('aria-label', n === 1 ? '1 unread alert' : n + ' unread alerts');
  }

  /** Acknowledge one alert by id and re-render. */
  function acknowledgeAlert(alertId) {
    if (typeof AlertRules === 'undefined') return;
    AlertRules.acknowledge(alertId);
    AlertRules.applyAcknowledgements(HKELIApp.data.alerts);
    renderAlerts();
    updateNotificationBadge();
  }

  /** Acknowledge every currently-visible alert. */
  function acknowledgeAllAlerts() {
    if (typeof AlertRules === 'undefined') return;
    var ids = HKELIApp.data.alerts.map(function (a) { return a.id; });
    if (!ids.length) { showToast('No alerts to acknowledge', 'info'); return; }
    AlertRules.acknowledgeAll(ids);
    AlertRules.applyAcknowledgements(HKELIApp.data.alerts);
    renderAlerts();
    updateNotificationBadge();
    showToast('Acknowledged ' + ids.length + ' alert(s)', 'success');
  }

  /** Bring acknowledged alerts back (they can fire again). */
  function resetAlertAcks() {
    if (typeof AlertRules === 'undefined') return;
    AlertRules.resetAcknowledgements();
    AlertRules.applyAcknowledgements(HKELIApp.data.alerts);
    renderAlerts();
    updateNotificationBadge();
    showToast('Alerts reset — acknowledged items will fire again', 'info');
  }
  function toggleAlertPopover() {
    var pop = document.getElementById('alert-popover');
    if (!pop) return;
    if (pop.classList.contains('hidden')) {
      pop.classList.remove('hidden');
      var c = document.getElementById('alert-popover-content');
      if (c) {
        c.innerHTML = HKELIApp.data.alerts.slice(0, 5).map(function (a) {
          return '<div class="popover-alert"><strong>' + a.type + '</strong><p>' + a.message + '</p></div>';
        }).join('') || '<p>No alerts.</p>';
      }
    } else {
      pop.classList.add('hidden');
    }
  }
  // "Clear list" only empties the current view — it does NOT acknowledge,
  // because alerts are rebuilt from live state on the next price tick.
  // The header button acknowledges instead, which is what actually clears
  // the badge.
  function clearAllAlerts() {
    HKELIApp.data.alerts = [];
    updateNotificationBadge();
    if (HKELIApp.currentView === 'alerts') renderAlerts();
  }

  // ──────────────────────────────────────────────────────────────────
  // Filters
  // ──────────────────────────────────────────────────────────────────
  function applyFilters() {
    var status = document.getElementById('status-filter');
    var cnt = document.getElementById('stock-count-filter');
    var iss = document.getElementById('issuer-filter');
    var tag = document.getElementById('tag-filter');
    var search = document.getElementById('search-deals');
    var sv = status ? status.value : '';
    var cv = cnt ? cnt.value : '';
    var iv = iss ? iss.value : '';
    var tv = tag ? tag.value : '';
    var xv = search ? search.value.toLowerCase() : '';
    HKELIApp.filteredDeals = HKELIApp.data.eliDeals.filter(function (deal) {
      var okS = !sv || deal.status === sv;
      var okC = !cv || String(deal.numberOfStocks) === cv;
      var okI = !iv || deal.issuer === iv;
      var okT = !tv || (deal.tags || []).indexOf(tv) !== -1;
      var okX = !xv || deal.dealName.toLowerCase().includes(xv) ||
        (deal.id || '').toLowerCase().includes(xv) ||
        (deal.underlyingAssets || []).some(function (a) {
          return a.symbol.toLowerCase().includes(xv) || (a.name || '').toLowerCase().includes(xv);
        }) ||
        (deal.tags || []).some(function (t) { return t.toLowerCase().includes(xv); });
      return okS && okC && okI && okT && okX;
    });
    renderDeals();
  }

  // Populate the tag filter with all unique tags currently in use.
  function refreshTagFilter() {
    var sel = document.getElementById('tag-filter');
    if (!sel) return;
    var current = sel.value;
    var allTags = {};
    HKELIApp.data.eliDeals.forEach(function (d) {
      (d.tags || []).forEach(function (t) { allTags[t] = true; });
    });
    var sorted = Object.keys(allTags).sort();
    sel.innerHTML = '<option value="">All Tags</option>' +
      sorted.map(function (t) {
        var sel2 = t === current ? ' selected' : '';
        return '<option value="' + escapeHtml(t) + '"' + sel2 + '>#' + escapeHtml(t) + '</option>';
      }).join('');
  }

  // ──────────────────────────────────────────────────────────────────
  // Settings display + manual refresh
  // ──────────────────────────────────────────────────────────────────
  function updateRefreshDisplay() {
    var last = document.getElementById('last-refresh-time');
    if (last) {
      var t = HKELIApp.data.settings.lastRefresh;
      last.textContent = t ? new Date(t).toLocaleTimeString() + ' HKT' : 'Just now';
    }
    updateRefreshCountdown();
  }
  function performManualRefresh() { refreshPrices({ force: true }); }

  // ──────────────────────────────────────────────────────────────────
  // Export / Import
  // ──────────────────────────────────────────────────────────────────
  function exportCSV() {
    var rows = HKELIApp.data.eliDeals.map(function (deal) {
      return {
        'Deal ID': deal.id,
        'Deal Name': deal.dealName,
        'Investment Date': deal.investmentDate,
        'Maturity Date': deal.maturityDate,
        'Nominal Amount': deal.nominalAmount,
        'Purchase Price': deal.purchasePrice,
        'Number of Stocks': deal.numberOfStocks,
        'Coupon Rate': deal.couponRate,
        'Settlement Method': deal.settlementMethod,
        'Issuer': deal.issuer,
        'Status': deal.status,
        'Current Value': deal.currentValue,
        'P&L': deal.pnl,
        'Tags': (deal.tags || []).join('|'),
        // Full underlying payload so a CSV round-trip is lossless.
        // Format: SYMBOL|NAME|strike|barrier|weight|price  (grouped by ';')
        'Underlying Assets': (deal.underlyingAssets || []).map(function (a) {
          return [
            a.symbol,
            a.name,
            a.strikePrice,
            a.barrierLevel,
            a.weight,
            a.currentPrice
          ].join('|');
        }).join(';')
      };
    });
    var csv = Papa.unparse(rows);
    downloadBlob(csv, 'text/csv;charset=utf-8;', 'HK_ELI_Portfolio_' + isoDate() + '.csv');
    showToast('Portfolio data exported as CSV', 'success');
  }

  function exportJSON() {
    var payload = Storage.exportAll();
    downloadBlob(JSON.stringify(payload, null, 2), 'application/json;charset=utf-8;',
      'HK_ELI_Backup_' + isoDate() + '.json');
    showToast('Portfolio data exported as JSON', 'success');
  }

  // ──────────────────────────────────────────────────────────────────
  // Print summary — builds a clean sheet and hands it to the browser's
  // print dialog, so "Print → Save as PDF" produces a usable document.
  // ──────────────────────────────────────────────────────────────────
  function buildPrintSummary() {
    var deals = HKELIApp.data.eliDeals || [];
    var investment = deals.reduce(function (s, d) { return s + (d.purchasePrice || 0); }, 0);
    var value = deals.reduce(function (s, d) { return s + (d.currentValue || 0); }, 0);
    var pnl = value - investment;
    var pnlPct = investment > 0 ? (pnl / investment) * 100 : 0;
    var health = (typeof Health !== 'undefined' && deals.length)
      ? Health.portfolioHealth(deals) : null;

    var rows = deals.map(function (d) {
      var barrier = calculateBarrierDistance(d);
      return '<tr>'
        + '<td>' + escapeHtml(d.dealName) + '</td>'
        + '<td>' + escapeHtml(d.issuer || '—') + '</td>'
        + '<td>' + formatCurrency(d.purchasePrice) + '</td>'
        + '<td>' + formatCurrency(d.currentValue) + '</td>'
        + '<td>' + (d.pnl >= 0 ? '+' : '') + formatCurrency(d.pnl) + '</td>'
        + '<td>' + escapeHtml(d.status) + '</td>'
        + '<td>' + barrier.percentage.toFixed(0) + '%</td>'
        + '</tr>';
    }).join('');

    var holdings = deals.map(function (d) {
      return (d.underlyingAssets || []).map(function (a) {
        return '<tr>'
          + '<td>' + escapeHtml(d.dealName) + '</td>'
          + '<td>' + escapeHtml(a.symbol) + '</td>'
          + '<td>' + escapeHtml(a.name || '') + '</td>'
          + '<td>' + formatCurrency(a.strikePrice) + '</td>'
          + '<td>' + formatCurrency(a.barrierLevel) + '</td>'
          + '<td>' + formatCurrency(a.currentPrice) + '</td>'
          + '</tr>';
      }).join('');
    }).join('');

    return '<h1>HK ELI Portfolio Summary</h1>'
      + '<p class="print-meta">Generated ' + new Date().toLocaleString()
      + ' (HKT) · ' + deals.length + ' deal(s) · '
      + 'prices ' + (HKELIApp.data.apiStatus.lastSuccessfulRefresh
          ? new Date(HKELIApp.data.apiStatus.lastSuccessfulRefresh).toLocaleString()
          : 'unknown')
      + '</p>'
      + '<h2>Summary</h2>'
      + '<table><tbody>'
      + '<tr><th>Total invested</th><td>' + formatCurrency(investment) + '</td></tr>'
      + '<tr><th>Current value</th><td>' + formatCurrency(value) + '</td></tr>'
      + '<tr><th>Unrealised P&amp;L</th><td>' + (pnl >= 0 ? '+' : '') + formatCurrency(pnl)
      + ' (' + (pnl >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%)</td></tr>'
      + (health ? '<tr><th>Portfolio health</th><td>' + health.total + '/100 (grade ' + health.grade + ')</td></tr>' : '')
      + '</tbody></table>'
      + '<h2>Deals</h2>'
      + '<table><thead><tr><th>Deal</th><th>Issuer</th><th>Invested</th><th>Value</th>'
      + '<th>P&amp;L</th><th>Status</th><th>Barrier</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<h2>Underlying holdings</h2>'
      + '<table><thead><tr><th>Deal</th><th>Symbol</th><th>Name</th><th>Strike</th>'
      + '<th>Barrier</th><th>Current</th></tr></thead><tbody>' + holdings + '</tbody></table>'
      + '<h2>Disclaimer</h2>'
      + '<p class="print-meta">For portfolio-tracking and educational purposes only. '
      + 'Not investment advice. Market data may be delayed or inaccurate.</p>';
  }

  function printSummary() {
    var deals = HKELIApp.data.eliDeals || [];
    if (!deals.length) { showToast('Nothing to print — no deals yet', 'warning'); return; }
    var el = document.getElementById('print-summary');
    if (!el) {
      el = document.createElement('div');
      el.id = 'print-summary';
      document.body.appendChild(el);
    }
    el.innerHTML = buildPrintSummary();
    document.body.classList.add('printing-portfolio');
    // Let layout settle before opening the dialog.
    setTimeout(function () {
      window.print();
      setTimeout(function () {
        document.body.classList.remove('printing-portfolio');
      }, 400);
    }, 60);
  }

  // ──────────────────────────────────────────────────────────────────
  // CSV import — header mapping, lossless round-trip, safe merge
  // ──────────────────────────────────────────────────────────────────

  // Accepted spellings for each field, so a hand-edited CSV or a
  // differently-cased export still imports without editing.
  var CSV_FIELD_ALIASES = {
    dealName:       ['Deal Name', 'Name', 'Deal'],
    investmentDate: ['Investment Date', 'Issue Date', 'Start Date'],
    maturityDate:   ['Maturity Date', 'Maturity', 'End Date'],
    nominalAmount:  ['Nominal Amount', 'Nominal', 'Face Value'],
    purchasePrice:  ['Purchase Price', 'Issue Price', 'Invested'],
    numberOfStocks: ['Number of Stocks', 'Stocks', 'Legs'],
    couponRate:     ['Coupon Rate', 'Coupon', 'Coupon %'],
    settlementMethod: ['Settlement Method', 'Settlement'],
    issuer:         ['Issuer', 'Bank'],
    status:         ['Status'],
    currentValue:   ['Current Value', 'Value', 'Market Value'],
    pnl:            ['P&L', 'P/L', 'Profit', 'Gain'],
    tags:           ['Tags', 'Labels'],
    underlyingAssets: ['Underlying Assets', 'Underlyings', 'Symbols', 'Basket']
  };

  // Find the first header in `headers` matching any alias for `field`
  // (case-insensitive).
  function matchHeader(headers, field) {
    var aliases = (CSV_FIELD_ALIASES[field] || [field]).map(function (a) {
      return String(a).toLowerCase();
    });
    for (var i = 0; i < headers.length; i++) {
      if (aliases.indexOf(String(headers[i]).trim().toLowerCase()) !== -1) return headers[i];
    }
    return null;
  }

  // Parse the 'Underlying Assets' cell.
  // Current format: SYMBOL|NAME|strike|barrier|weight|price  (';'-joined)
  // Legacy format : SYMBOL:name:weight  — still accepted. It carries no
  //                 strike or barrier, so those come back null and the
  //                 caller decides what to do (see buildDealsFromCsvRows).
  function parseUnderlyingCell(cell) {
    if (!cell) return [];
    return String(cell).split(';').map(function (chunk) {
      chunk = String(chunk).trim();
      if (!chunk) return null;
      var isLegacy = chunk.indexOf('|') === -1;
      var parts = (isLegacy ? chunk.split(':') : chunk.split('|'));
      var sym = String(parts[0] || '').trim();
      if (!sym) return null;
      var meta = (HKELIApp.data.hkStocks || []).find(function (s) {
        return s.symbol.toUpperCase() === sym.toUpperCase();
      });
      var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : null; };

      if (isLegacy) {
        // SYMBOL:name:weight — no strike/barrier/price information.
        return {
          symbol: sym,
          name: (parts[1] || (meta && meta.name) || sym).trim(),
          strikePrice: null,
          barrierLevel: null,
          weight: num(parts[2]),
          currentPrice: null,
          __incomplete: true
        };
      }

      return {
        symbol: sym,
        name: (parts[1] || (meta && meta.name) || sym).trim(),
        strikePrice: num(parts[2]),
        barrierLevel: num(parts[3]),
        weight: num(parts[4]),
        currentPrice: num(parts[5]),
        __incomplete: num(parts[2]) == null
      };
    }).filter(Boolean);
  }

  /**
   * Repair underlyings the CSV didn't fully specify.
   * Strike/barrier are required by the payoff math, so an incomplete row
   * gets strike = price and barrier = 80% of price, and the deal is
   * counted in `issues` so the UI can warn rather than quietly lie.
   */
  function normalizeImportedAssets(assets) {
    var repaired = 0;
    assets.forEach(function (a) {
      if (a.strikePrice == null) {
        var ref = a.currentPrice;
        if (ref == null || ref <= 0) ref = 100;   // nothing usable — flag it
        a.strikePrice = ref;
        a.barrierLevel = a.barrierLevel != null ? a.barrierLevel : ref * 0.8;
        a.currentPrice = a.currentPrice != null ? a.currentPrice : ref;
        repaired++;
      }
    });
    return repaired;
  }

  /** Turn parsed CSV rows into deals. Reports what it couldn't read. */
  function buildDealsFromCsvRows(rows) {
    var headers = Object.keys(rows[0] || {});
    var col = {};
    Object.keys(CSV_FIELD_ALIASES).forEach(function (field) {
      col[field] = matchHeader(headers, field);
    });

    var issues = [];
    if (!col.dealName) issues.push('no "Deal Name" column found');
    if (!col.underlyingAssets) issues.push('no "Underlying Assets" column — deals would have no holdings');

    var today = new Date().toISOString().split('T')[0];
    var oneYear = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
    var incompleteAssets = 0;

    var deals = rows.map(function (row, index) {
      var num = function (key, fallback) {
        if (!col[key]) return fallback;
        var v = parseFloat(row[col[key]]);
        return isFinite(v) ? v : fallback;
      };
      var str = function (key, fallback) {
        if (!col[key]) return fallback;
        var v = row[col[key]];
        return (v === undefined || v === null || v === '') ? fallback : String(v).trim();
      };

      var declared = num('numberOfStocks', 0);
      var assets = col.underlyingAssets ? parseUnderlyingCell(row[col.underlyingAssets]) : [];
      var repaired = normalizeImportedAssets(assets);
      if (repaired) incompleteAssets += repaired;
      var n = assets.length || declared || 1;
      // Fill in missing weights as an equal split across the basket.
      assets.forEach(function (a) {
        if (a.weight == null) a.weight = 1 / n;
        delete a.__incomplete;
      });

      return {
        id: 'ELI-HK' + String(index + 1).padStart(3, '0'),
        dealName: str('dealName', 'Imported Deal ' + (index + 1)),
        investmentDate: str('investmentDate', today),
        maturityDate: str('maturityDate', oneYear),
        nominalAmount: num('nominalAmount', 0),
        purchasePrice: num('purchasePrice', 0),
        numberOfStocks: n,
        couponRate: num('couponRate', 0),
        settlementMethod: str('settlementMethod', 'Cash Settlement'),
        issuer: str('issuer', 'Unknown'),
        status: str('status', 'Active'),
        currentValue: num('currentValue', 0),
        pnl: num('pnl', 0),
        tags: col.tags
          ? String(row[col.tags] || '').split(/[|;]/).map(function (t) {
              return t.trim().toLowerCase();
            }).filter(Boolean)
          : [],
        underlyingAssets: assets
      };
    });

    if (incompleteAssets) {
      issues.push(incompleteAssets + ' underlying(s) had no strike/barrier — filled with placeholder values, please review');
    }
    return { issues: issues, deals: deals };
  }

  function importCSV(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var result;
      try {
        var parsed = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
        if (!parsed.data || !parsed.data.length) { showToast('CSV has no data rows', 'error'); return; }
        result = buildDealsFromCsvRows(parsed.data);
      } catch (err) {
        showToast('Error parsing CSV: ' + err.message, 'error');
        return;
      }

      if (result.issues.length) {
        showToast('CSV import: ' + result.issues.join('; '), 'warning');
      }
      if (!result.deals.some(function (d) { return d.underlyingAssets.length; })) {
        if (!confirm(
          'None of the ' + result.deals.length + ' row(s) had readable underlyings.\n\n' +
          'The CSV needs an "Underlying Assets" column like:\n' +
          '  0700.HK|Tencent|380|304|0.5|412\n\n' +
          'Cancel to abort the import.'
        )) return;
      }

      // Never silently wipe existing deals — merge by deal name.
      var existing = Storage.getDeals();
      var incoming = result.deals;
      var dupes = incoming.filter(function (d) {
        return existing.some(function (x) { return x.dealName === d.dealName; });
      });

      if (dupes.length) {
        var update = confirm(
          'Found ' + dupes.length + ' deal(s) already in your portfolio:\n\n' +
          dupes.map(function (d) { return '• ' + d.dealName; }).join('\n') +
          '\n\nOK = update those deals in place' +
          '\nCancel = skip them and import only the new ones'
        );
        if (update) {
          var merged = existing.map(function (x) {
            var match = incoming.find(function (d) { return d.dealName === x.dealName; });
            if (!match) return x;
            return Object.assign({}, match, {
              id: x.id,
              createdAt: x.createdAt,
              underlyingAssets: match.underlyingAssets.map(function (a) {
                var prev = (x.underlyingAssets || []).find(function (p) {
                  return p.symbol === a.symbol;
                });
                // Keep the live price already on file if the CSV had none.
                return (prev && !a.currentPrice)
                  ? Object.assign({}, a, { currentPrice: prev.currentPrice })
                  : a;
              })
            });
          });
          Storage.replaceAllDeals(merged);
          showToast('Updated ' + dupes.length + ' deal(s) from CSV', 'success');
        } else {
          var have = {};
          existing.forEach(function (x) { have[x.dealName] = true; });
          var toAdd = incoming.filter(function (d) { return !have[d.dealName]; });
          if (!toAdd.length) { showToast('Nothing new to import', 'info'); return; }
          Storage.replaceAllDeals(existing.concat(toAdd));
          showToast('Imported ' + toAdd.length + ' new deal(s)', 'success');
        }
      } else {
        Storage.replaceAllDeals(existing.concat(incoming));
        showToast('Imported ' + incoming.length + ' deal(s) from CSV', 'success');
      }

      loadDealsIntoState();
      reassignELIIds();
      refreshDealViews();
      refreshPrices();
    };
    reader.readAsText(file);
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var payload = JSON.parse(e.target.result);
        Storage.importAll(payload);
        loadDealsIntoState();
        refreshDealViews();
        renderDashboard();
        if (HKELIApp.currentView === 'deals') renderDeals();
        if (HKELIApp.currentView === 'alerts') renderAlerts();
        if (typeof updateRiskAnalytics === 'function') updateRiskAnalytics();
        showToast('Imported ' + HKELIApp.data.eliDeals.length + ' deals from JSON', 'success');
        refreshPrices();
      } catch (err) { showToast('Error importing JSON: ' + err.message, 'error'); }
    };
    reader.readAsText(file);
  }

  function clearAllData() {
    if (!confirm(
      'Clear ALL portfolio data?\n\n' +
      'This erases deals, price history, cached prices, alert rules and\n' +
      'settings (including any saved Finnhub API key) from this browser.\n' +
      'It cannot be undone — export first if you want a backup.'
    )) return;

    // The old path (Storage.replaceAllDeals([])) only touched the `deals`
    // table. price_history, price_cache and settings — including the
    // Finnhub API key — survived on disk. Wipe the whole database.
    if (window.Db && typeof Db.clearAll === 'function') {
      Db.clearAll().catch(function (e) {
        console.error('Db.clearAll failed', e);
        showToast('Database clear failed — some data may remain', 'error');
      });
    }

    // localStorage mirrors: deals, settings, price cache, plus the keys
    // owned by the alert / watchlist / fx modules.
    [
      'eli_deals_v1', 'eli_settings_v1', 'eli_price_cache_v1',
      'eli_watchlist_v1', 'eli_fx_cache_v1', 'eli_alert_acks_v1',
      'eli_schema_version'
    ].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    });
    try { sessionStorage.removeItem('eli_banner_dismissed'); } catch (e) {}

    // In-memory mirrors.
    HKELIApp.data.eliDeals = [];
    HKELIApp.data.alerts = [];
    HKELIApp.data.customAlerts = [];
    HKELIApp.lastDeletedDeal = null;
    if (HKELIApp.charts) HKELIApp.charts = {};

    // Re-seed the SQLite schema so the app stays usable immediately.
    if (window.Storage && Storage.refresh) Storage.refresh();

    if (HKELIApp.refreshTimer) { clearInterval(HKELIApp.refreshTimer); HKELIApp.refreshTimer = null; }

    renderDashboard();
    refreshDealViews();
    if (HKELIApp.currentView === 'deals') renderDeals();
    if (HKELIApp.currentView === 'alerts') renderAlerts();
    if (HKELIApp.currentView === 'analytics') setupCharts();
    if (HKELIApp.currentView === 'calendar') renderCalendarView();
    if (HKELIApp.currentView === 'watchlist') renderWatchlistView();
    if (HKELIApp.currentView === 'compare') renderCompareView();
    renderAlertRulesList();
    updateDbStatusIndicator();
    updateNotificationBadge();

    showToast('All portfolio data cleared from this browser', 'success');
  }

  function downloadBlob(content, mime, filename) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.visibility = 'hidden';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function isoDate() { return new Date().toISOString().split('T')[0]; }

  // ──────────────────────────────────────────────────────────────────
  // SQLite .db file export / import (real portable database)
  // ──────────────────────────────────────────────────────────────────
  function updateDbStatusIndicator() {
    var status = Storage.dbStatus();
    var backendEl = document.getElementById('db-backend-status');
    var countEl = document.getElementById('db-record-count');
    if (countEl) countEl.textContent = String(status.dealCount || 0);
    if (backendEl) {
      var labels = {
        opfs: 'SQLite + OPFS (auto-saved)',
        memory: 'SQLite in-memory (Safari / no OPFS)',
        failed: 'Fallback mode (localStorage only)'
      };
      backendEl.textContent = labels[status.backend] || status.backend;
    }
  }

  async function downloadDatabaseFile() {
    var btn = document.getElementById('download-db');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      var bytes = await Storage.exportDatabaseFile();
      if (!bytes) {
        showToast('SQLite not available in this browser', 'error');
        return;
      }
      var blob = new Blob([bytes], { type: 'application/x-sqlite3' });
      downloadBlobFromBlob(blob, 'HK_ELI_' + isoDate() + '.db');
      showToast('Downloaded HK_ELI.db (' + Math.round(bytes.length / 1024) + ' KB)', 'success');
    } catch (e) {
      showToast('Download failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }

  async function importDatabaseFile(file) {
    if (!confirm('Replace all current data with the uploaded .db file? This cannot be undone (export first if you want a backup).')) return;
    try {
      var bytes = new Uint8Array(await file.arrayBuffer());
      var count = await Storage.importDatabaseFile(bytes);
      loadDealsIntoState();
      refreshDealViews();
      renderDashboard();
      if (HKELIApp.currentView === 'deals') renderDeals();
      if (HKELIApp.currentView === 'alerts') renderAlerts();
      if (typeof updateRiskAnalytics === 'function') updateRiskAnalytics();
      updateDbStatusIndicator();
      showToast('Imported ' + count + ' deal(s) from .db file', 'success');
      refreshPrices();
    } catch (e) {
      showToast('Import failed: ' + e.message, 'error');
    }
  }

  function downloadBlobFromBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.visibility = 'hidden';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ──────────────────────────────────────────────────────────────────
  // Settings — Finnhub API key + refresh interval wiring
  // ──────────────────────────────────────────────────────────────────
  function applySettings() {
    var intervalSel = document.getElementById('refresh-interval');
    var finnhubInput = document.getElementById('finnhub-api-key');
    var settings = {};
    if (intervalSel) settings.refreshInterval = parseInt(intervalSel.value, 10);
    if (finnhubInput) settings.finnhubApiKey = finnhubInput.value.trim();
    Storage.setSettings(settings);
    HKELIApp.data.settings = getCurrentSettings();
    startAutoRefresh();
    showToast('Settings saved', 'success');
  }

  function populateSettingsUI() {
    var s = getCurrentSettings();
    var intervalSel = document.getElementById('refresh-interval');
    var finnhubInput = document.getElementById('finnhub-api-key');
    if (intervalSel) intervalSel.value = String(s.refreshInterval);
    if (finnhubInput) finnhubInput.value = s.finnhubApiKey || '';
  }

  // ──────────────────────────────────────────────────────────────────
  // Manual price entry (Settings → Manual Price Entry)
  // Lets the user paste prices from any external source when the
  // live APIs are blocked. The manual prices are applied as a single
  // batch to all deals and persisted via Db.recordSnapshots.
  // ──────────────────────────────────────────────────────────────────
  function uniqueSymbolsFromDeals() {
    var seen = {};
    var out = [];
    (HKELIApp.data.eliDeals || []).forEach(function (d) {
      (d.underlyingAssets || []).forEach(function (a) {
        if (a.symbol && !seen[a.symbol]) {
          seen[a.symbol] = true;
          out.push({ symbol: a.symbol, name: a.name || a.symbol, currentPrice: a.currentPrice });
        }
      });
    });
    out.sort(function (a, b) { return a.symbol.localeCompare(b.symbol); });
    return out;
  }

  function renderManualPriceEntries() {
    var container = document.getElementById('manual-price-entries');
    if (!container) return;
    var symbols = uniqueSymbolsFromDeals();
    if (!symbols.length) {
      container.innerHTML = '<p class="form-help">No deals yet — add a deal first, then come back to enter prices manually.</p>';
      return;
    }
    var rows = symbols.map(function (s) {
      return '<div class="manual-price-row">'
        + '<span class="manual-price-symbol"><strong>' + s.symbol + '</strong> <small>' + escapeHtml(s.name) + '</small></span>'
        + '<input type="number" step="0.01" min="0" class="form-control manual-price-input" data-symbol="' + s.symbol + '" placeholder="' + (s.currentPrice || '') + '">'
        + '</div>';
    }).join('');
    container.innerHTML = rows;
  }

  function applyManualPrices() {
    var inputs = document.querySelectorAll('.manual-price-input');
    var prices = {};
    inputs.forEach(function (inp) {
      var v = parseFloat(inp.value);
      if (isFinite(v) && v > 0) {
        prices[inp.dataset.symbol] = v;
      }
    });
    var symbols = Object.keys(prices);
    if (!symbols.length) { showToast('No prices entered', 'warning'); return; }
    // Apply to all deals
    var updated = 0;
    HKELIApp.data.eliDeals.forEach(function (deal) {
      (deal.underlyingAssets || []).forEach(function (a) {
        if (typeof prices[a.symbol] === 'number') {
          a.currentPrice = prices[a.symbol];
          updated++;
        }
      });
      deal.currentValue = (deal.underlyingAssets || []).reduce(function (sum, a) {
        var effShares = (deal.purchasePrice || 0) / (a.strikePrice || 1);
        return sum + (a.currentPrice || 0) * effShares * (a.weight || 0);
      }, 0);
      deal.pnl = (deal.currentValue || 0) - (deal.purchasePrice || 0);
      updateDealStatus(deal);
    });
    persistDeals();
    // Persist to price history as a 'manual' source
    if (typeof Db.recordSnapshots === 'function') {
      Db.recordSnapshots(prices, 'manual').catch(function (e) {
        console.warn('recordSnapshots (manual) failed', e);
      });
    }
    // Update apiStatus so the UI shows manual counts
    var now = Date.now();
    HKELIApp.data.apiStatus.connected = true;
    HKELIApp.data.apiStatus.lastSuccessfulRefresh = now;
    HKELIApp.data.apiStatus.source = 'manual';
    HKELIApp.data.apiStatus.sourceStats = {
      yahoo: 0, finnhub: 0, manual: symbols.length, cache: 0, missing: 0
    };
    HKELIApp.data.settings.lastRefresh = now;
    Storage.setSettings({ lastRefresh: now });
    renderDashboard();
    if (HKELIApp.currentView === 'deals') renderDeals();
    if (HKELIApp.currentView === 'analytics') setupCharts();
    if (HKELIApp.currentView === 'payoff') renderPayoffView();
    if (HKELIApp.currentView === 'scenarios') renderScenariosView();
    if (HKELIApp.currentView === 'calendar') renderCalendarView();
    updateAPIStatus();
    showToast('Applied ' + symbols.length + ' manual prices', 'success');
  }

  function clearManualPrices() {
    // Clear all manual inputs, then trigger a real API refresh
    document.querySelectorAll('.manual-price-input').forEach(function (inp) { inp.value = ''; });
    showToast('Cleared manual prices — refreshing from API', 'info');
    setTimeout(function () { performManualRefresh(); }, 300);
  }

  // ──────────────────────────────────────────────────────────────────
  // Mobile sidebar (hamburger) toggle
  // ──────────────────────────────────────────────────────────────────
  function setSidebarOpen(open) {
    var sidebar = document.getElementById('primary-sidebar');
    var backdrop = document.getElementById('sidebar-backdrop');
    var toggle = document.getElementById('sidebar-toggle');
    if (!sidebar || !backdrop) return;
    sidebar.classList.toggle('open', open);
    backdrop.classList.toggle('open', open);
    backdrop.hidden = !open;
    document.body.classList.toggle('sidebar-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // ──────────────────────────────────────────────────────────────────
  // Event wiring
  // ──────────────────────────────────────────────────────────────────
  function setupEventListeners() {
    document.querySelectorAll('.nav-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        switchView(item.dataset.view);
        // On mobile, close the sidebar overlay after navigation
        setSidebarOpen(false);
      });
    });

    // Mobile sidebar hamburger
    var sidebarToggle = document.getElementById('sidebar-toggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var isOpen = document.getElementById('primary-sidebar').classList.contains('open');
        setSidebarOpen(!isOpen);
      });
    }
    var sidebarBackdrop = document.getElementById('sidebar-backdrop');
    if (sidebarBackdrop) {
      sidebarBackdrop.addEventListener('click', function () { setSidebarOpen(false); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setSidebarOpen(false);
    });
    // Close sidebar when window grows past mobile breakpoint
    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) setSidebarOpen(false);
    });

    function on(id, evt, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener(evt, fn);
    }

    on('add-deal-btn', 'click', function (e) { e.preventDefault(); showAddDealModal(); });
    on('close-modal', 'click', function (e) { e.preventDefault(); hideAddDealModal(); });
    on('cancel-add-deal', 'click', function (e) { e.preventDefault(); hideAddDealModal(); });
    on('close-detail-modal', 'click', function (e) { e.preventDefault(); hideDealDetailModal(); });
    on('close-delete-modal', 'click', function (e) { e.preventDefault(); hideDeleteConfirmation(); });
    on('cancel-delete', 'click', function (e) { e.preventDefault(); hideDeleteConfirmation(); });
    on('confirm-delete', 'click', function (e) { e.preventDefault(); confirmDeleteDeal(); });
    on('add-deal-form', 'submit', handleDealFormSubmit);
    on('number-of-stocks', 'change', updateStockConfiguration);
    on('notifications-bell', 'click', function (e) { e.preventDefault(); e.stopPropagation(); toggleAlertPopover(); });
    on('clear-alerts', 'click', function (e) { e.preventDefault(); acknowledgeAllAlerts(); });
    on('enable-notifications', 'click', function (e) { e.preventDefault(); requestNotificationPermission(); });
    on('manual-refresh', 'click', function (e) { e.preventDefault(); performManualRefresh(); });
    on('export-csv', 'click', function (e) { e.preventDefault(); exportCSV(); });
    on('export-json', 'click', function (e) { e.preventDefault(); exportJSON(); });
    on('print-summary-btn', 'click', function (e) { e.preventDefault(); printSummary(); });
    on('save-to-db', 'click', function (e) { e.preventDefault(); saveDealsToDatabase(); });
    on('load-from-db', 'click', function (e) { e.preventDefault(); loadDealsFromDatabase(); });
    on('save-settings', 'click', function (e) { e.preventDefault(); applySettings(); });
    on('currency-display', 'change', function (e) {
      e.preventDefault();
      setDisplayCurrency(e.target.value);
    });

    // Test price source
    on('test-price-source', 'click', function (e) { e.preventDefault(); testPriceSource(); });
    on('apply-manual-prices', 'click', function (e) { e.preventDefault(); applyManualPrices(); });
    on('clear-manual-prices', 'click', function (e) { e.preventDefault(); clearManualPrices(); });
    on('dismiss-price-banner', 'click', function (e) {
      e.preventDefault();
      var b = document.getElementById('price-source-banner');
      if (b) b.classList.add('hidden');
      try { sessionStorage.setItem('eli_banner_dismissed', '1'); } catch (_) {}
    });
    var bannerLink = document.getElementById('banner-go-settings');
    if (bannerLink) bannerLink.addEventListener('click', function (e) {
      e.preventDefault();
      switchView('settings');
    });

    // SQLite .db file buttons
    on('download-db', 'click', function (e) { e.preventDefault(); downloadDatabaseFile(); });
    var importDbBtn = document.getElementById('import-db-btn');
    var importDbFile = document.getElementById('import-db');
    if (importDbBtn && importDbFile) {
      importDbBtn.addEventListener('click', function () { importDbFile.click(); });
      importDbFile.addEventListener('change', function (e) {
        if (e.target.files.length > 0) { importDatabaseFile(e.target.files[0]); e.target.value = ''; }
      });
    }

    var csvBtn = document.getElementById('import-csv-btn');
    var csvFile = document.getElementById('import-csv');
    if (csvBtn && csvFile) {
      csvBtn.addEventListener('click', function () { csvFile.click(); });
      csvFile.addEventListener('change', function (e) {
        if (e.target.files.length) { importCSV(e.target.files[0]); e.target.value = ''; }
      });
    }
    var jsonBtn = document.getElementById('import-json-btn');
    var jsonFile = document.getElementById('import-json');
    if (jsonBtn && jsonFile) {
      jsonBtn.addEventListener('click', function () { jsonFile.click(); });
      jsonFile.addEventListener('change', function (e) {
        if (e.target.files.length) { importJSON(e.target.files[0]); e.target.value = ''; }
      });
    }
    on('clear-data-btn', 'click', function (e) { e.preventDefault(); clearAllData(); });

    ['status-filter', 'stock-count-filter', 'issuer-filter', 'tag-filter'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', applyFilters);
    });
    var search = document.getElementById('search-deals');
    if (search) search.addEventListener('input', applyFilters);

    document.addEventListener('click', function (e) {
      var pop = document.getElementById('alert-popover');
      var bell = document.getElementById('notifications-bell');
      if (pop && !pop.contains(e.target) && bell && !bell.contains(e.target)) pop.classList.add('hidden');
    });

    ['add-deal-modal', 'deal-detail-modal', 'delete-confirmation-modal'].forEach(function (id) {
      var m = document.getElementById(id);
      if (m) m.addEventListener('click', function (e) { if (e.target === m) {
        if (id === 'add-deal-modal') hideAddDealModal();
        else if (id === 'deal-detail-modal') hideDealDetailModal();
        else hideDeleteConfirmation();
      }});
    });

    setupPayoffEventListeners();
    setupCalendarEventListeners();
    setupPortfolioHistoryRange();
    setupWatchlistListeners();
    setupCompareListeners();
    setupThemeToggle();
    setupSettingsTabs();
    setupKeyboardShortcuts();
  }

  // ──────────────────────────────────────────────────────────────────
  // Theme toggle (auto / light / dark, persisted in Storage)
  // ──────────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    theme = theme || 'auto';
    var root = document.documentElement;
    if (theme === 'auto') {
      root.removeAttribute('data-color-scheme');
    } else {
      root.setAttribute('data-color-scheme', theme);
    }
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      var icon = btn.querySelector('i');
      var effective = theme === 'auto'
        ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;
      if (icon) icon.className = effective === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
      btn.setAttribute('aria-label', 'Toggle dark mode (current: ' + effective + ')');
      btn.setAttribute('title', 'Toggle dark mode (current: ' + effective + ')');
    }
  }

  function setupThemeToggle() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    var settings = Storage.getSettings();
    applyTheme(settings.theme || 'auto');
    btn.addEventListener('click', function () {
      var s = Storage.getSettings();
      var current = s.theme || 'auto';
      // Cycle auto → light → dark → auto
      var next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
      Storage.setSettings({ theme: next });
      applyTheme(next);
      showToast('Theme: ' + next, 'info', 1500);
    });
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        var s = Storage.getSettings();
        if ((s.theme || 'auto') === 'auto') applyTheme('auto');
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Settings tabs (collapse 4 long cards into a tabbed UI)
  // ──────────────────────────────────────────────────────────────────
  function setupSettingsTabs() {
    var grid = document.querySelector('.settings-grid');
    var cards = grid ? Array.from(grid.children) : [];
    if (!grid || cards.length === 0) return;
    var tabs = cards.map(function (card) {
      var titleEl = card.querySelector('h3');
      var label = titleEl ? titleEl.textContent : 'Section';
      var key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      card.setAttribute('data-settings-tab-content', key);
      return { key: key, label: label };
    });
    var tabBar = document.createElement('div');
    tabBar.className = 'settings-tabs';
    tabBar.setAttribute('role', 'tablist');
    tabs.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'settings-tab' + (i === 0 ? ' active' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      b.dataset.tab = t.key;
      b.textContent = t.label;
      tabBar.appendChild(b);
    });
    grid.parentNode.insertBefore(tabBar, grid);
    cards.forEach(function (c, i) {
      c.style.display = i === 0 ? '' : 'none';
    });
    tabBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.settings-tab');
      if (!btn) return;
      var key = btn.dataset.tab;
      tabBar.querySelectorAll('.settings-tab').forEach(function (b) {
        var active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      cards.forEach(function (c) {
        c.style.display = c.getAttribute('data-settings-tab-content') === key ? '' : 'none';
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Keyboard shortcuts: N (new), R (refresh), 1-5 (nav), ? (help), /
  // (focus search). Ignored when typing in inputs.
  // ──────────────────────────────────────────────────────────────────
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
                || (t.getAttribute && t.getAttribute('contenteditable') === 'true'))) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      var k = e.key.toLowerCase();
      if (k === 'n' && !e.shiftKey) {
        e.preventDefault();
        showAddDealModal();
      } else if (k === 'r' && !e.shiftKey) {
        e.preventDefault();
        performManualRefresh();
      } else if (k === '?' || (k === '/' && e.shiftKey)) {
        e.preventDefault();
        showKeyboardHelp();
      } else if (k === '1') { switchView('dashboard'); }
      else if (k === '2') { switchView('deals'); }
      else if (k === '3') { switchView('analytics'); }
      else if (k === '4') { switchView('payoff'); }
      else if (k === '5') { switchView('scenarios'); }
      else if (k === '6') { switchView('alerts'); }
      else if (k === '7') { switchView('settings'); }
      else if (k === '/') {
        var search = document.getElementById('search-deals');
        if (search) { e.preventDefault(); search.focus(); }
      }
    });
  }

  function showKeyboardHelp() {
    var existing = document.getElementById('kb-help-modal');
    if (existing) { existing.remove(); return; }
    var m = document.createElement('div');
    m.id = 'kb-help-modal';
    m.className = 'modal';
    m.innerHTML = '<div class="modal-content">'
      + '<div class="modal-header"><h2>Keyboard shortcuts</h2>'
      + '<button class="modal-close" type="button" onclick="document.getElementById(\'kb-help-modal\').remove()" aria-label="Close dialog"><i class="fas fa-times"></i></button></div>'
      + '<div class="modal-body"><table class="payoff-table"><tbody>'
      + '<tr><td><kbd>N</kbd></td><td>New ELI deal</td></tr>'
      + '<tr><td><kbd>R</kbd></td><td>Force-refresh prices</td></tr>'
      + '<tr><td><kbd>1</kbd>…<kbd>7</kbd></td><td>Switch to view (Dashboard / Deals / Analytics / Payoff / Scenarios / Alerts / Settings)</td></tr>'
      + '<tr><td><kbd>/</kbd></td><td>Focus search box</td></tr>'
      + '<tr><td><kbd>?</kbd></td><td>This help</td></tr>'
      + '<tr><td><kbd>Esc</kbd></td><td>Close modal / sidebar</td></tr>'
      + '</tbody></table></div></div>';
    document.body.appendChild(m);
  }

  // ──────────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────────
  function init() {
    console.log('Initializing HK ELI Portfolio Manager (browser-only)…');
    setupEventListeners();

    // Load settings + deals from localStorage
    HKELIApp.data.settings = getCurrentSettings();
    loadDealsIntoState();
    refreshDealViews();

    renderDashboard();
    renderDeals();
    renderAlerts();
    updateNotificationBadge();
    updateRefreshDisplay();
    populateSettingsUI();
    // Initialize display currency from saved settings (if non-HKD, fetch rate)
    var initialCur = (HKELIApp.data.settings && HKELIApp.data.settings.displayCurrency) || 'HKD';
    var curSel = document.getElementById('currency-display');
    if (curSel) curSel.value = initialCur;
    setDisplayCurrency(initialCur);
    updateDbStatusIndicator();
    // Refresh DB indicator after async SQLite init completes
    if (window.Storage && Storage.dbStatus) {
      Db.ready().then(updateDbStatusIndicator);
    }
    updateAPIStatus();
    updateMarketOpenStatus();
    setInterval(updateMarketOpenStatus, 60000);
    // Health probe was every 30s — way too aggressive when we now have
    // a SQLite price cache. Probe every 5 min instead, and only re-fetch
    // prices if the cache is genuinely stale.
    setInterval(checkBackendHealth, 5 * 60 * 1000);
    setInterval(updateRefreshCountdown, 60000);
    checkBackendHealth();

    startAutoRefresh();

    if (HKELIApp.data.eliDeals.length) {
      setTimeout(refreshPrices, 1000);
    } else {
      showToast('Welcome! Add your first HK ELI deal to start tracking.', 'info');
    }

    console.log('HK ELI Portfolio Manager ready.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();