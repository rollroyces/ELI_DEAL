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
  function formatHKCurrency(amount) {
    return 'HK$' + Math.round(amount).toLocaleString();
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
  // REWRITTEN: price refresh (Yahoo Finance + optional Finnhub fallback)
  // ──────────────────────────────────────────────────────────────────
  async function refreshPrices() {
    console.log('Refreshing prices from Yahoo Finance (browser)…');
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

      // 1) Yahoo Finance — primary
      var prices = await YahooFinance.getQuotes(symbols, { delay: 120 });
      var source = 'yahoo';
      var failed = symbols.filter(function (s) { return prices[s] == null; });

      // 2) Finnhub fallback for any symbols Yahoo couldn't return
      if (failed.length && window.Finnhub && Finnhub.hasKey()) {
        console.log('Yahoo missed', failed.length, 'symbols; trying Finnhub…');
        for (var i = 0; i < failed.length; i++) {
          try {
            var p = await Finnhub.getQuote(failed[i]);
            if (p != null) {
              prices[failed[i]] = p;
              failed.splice(i, 1);
              i--;
              source = 'finnhub';
            }
          } catch (e) { /* keep null */ }
        }
      }

      // Apply prices + recompute deal metrics
      var updated = 0, missing = 0;
      HKELIApp.data.eliDeals.forEach(function (deal) {
        (deal.underlyingAssets || []).forEach(function (asset) {
          var np = prices[asset.symbol];
          if (typeof np === 'number') {
            asset.currentPrice = np;
            updated++;
          } else if (missing++, missing++, null) {
            missing++;
          }
          if (typeof asset.currentPrice !== 'number') {
            asset.currentPrice = asset.strikePrice; // safe fallback so UI doesn't NaN
            missing++;
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

      var now = Date.now();
      HKELIApp.data.apiStatus.connected = updated > 0;
      HKELIApp.data.apiStatus.lastSuccessfulRefresh = now;
      HKELIApp.data.apiStatus.lastError = failed.length ? (failed.length + ' symbols unavailable') : null;
      HKELIApp.data.apiStatus.source = updated > 0 ? source : 'none';
      HKELIApp.data.settings.lastRefresh = now;
      Storage.setSettings({ lastRefresh: now });

      renderDashboard();
      if (HKELIApp.currentView === 'deals') renderDeals();
      updateAPIStatus();
      if (HKELIApp.currentView === 'alerts') renderAlerts();
      updateRefreshDisplay();
      if (typeof updateRiskAnalytics === 'function') updateRiskAnalytics();

      var msg = 'Prices refreshed (' + updated + ' updated';
      if (missing) msg += ', ' + missing + ' unavailable';
      msg += ')';
      showToast(msg, updated > 0 ? 'success' : 'warning');
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
    if (dot && txt) {
      if (HKELIApp.data.apiStatus.connected) {
        dot.className = 'status-dot success';
        txt.textContent = HKELIApp.data.apiStatus.source === 'finnhub'
          ? 'Connected (Finnhub)'
          : 'Connected (Yahoo)';
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
      else if (viewName === 'alerts') renderAlerts();
      else if (viewName === 'settings') { updateRefreshDisplay(); updateAPIStatus(); }
      else if (viewName === 'dashboard') renderDashboard();
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
      var activities = [
        {
          icon: 'fas fa-chart-line',
          iconClass: status.connected ? 'success' : 'error',
          title: status.connected ? 'Live Data Active' : 'Data Connection Issue',
          description: status.connected
            ? 'Real-time prices from ' + (status.source === 'finnhub' ? 'Finnhub' : 'Yahoo Finance')
            : 'Using last cached prices',
          time: status.lastSuccessfulRefresh ? formatTimeAgo(status.lastSuccessfulRefresh) : 'Never updated'
        },
        {
          icon: 'fas fa-sync-alt',
          iconClass: 'info',
          title: 'Data Refresh',
          description: 'Portfolio data last updated',
          time: HKELIApp.data.settings.lastRefresh ? formatTimeAgo(HKELIApp.data.settings.lastRefresh) : 'Never'
        }
      ];
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
      activityList.innerHTML = activities.map(function (a) {
        var bg = {success: '3', warning: '2', error: '4', info: '1'}[a.iconClass] || '1';
        return '<div class="activity-item">' +
          '<div class="activity-icon bg-' + bg + '"><i class="' + a.icon + '"></i></div>' +
          '<div class="activity-content"><h4>' + a.title + '</h4><p>' + a.description + ' • ' + a.time + '</p></div>' +
        '</div>';
      }).join('');
    }
    renderQuickStats();
  }

  function renderQuickStats() {
    var deals = HKELIApp.data.eliDeals;
    var approaching = deals.filter(function (d) { return d.status === 'Approaching Maturity'; }).length;
    var knockIn = deals.filter(function (d) { return d.status === 'Knock-in Triggered'; }).length;
    var avgCoupon = deals.length
      ? (deals.reduce(function (s, d) { return s + (d.couponRate || 0); }, 0) / deals.length).toFixed(2)
      : '0';
    var multiStock = deals.filter(function (d) { return (d.underlyingAssets || []).length > 1; }).length;

    var items = document.querySelectorAll('.stats-grid .stat-item');
    if (items.length >= 4) {
      items[0].querySelector('.stat-value').textContent = approaching + ' Deals';
      items[0].querySelector('.stat-value').className = 'stat-value ' + (approaching ? 'warning' : 'success');
      items[1].querySelector('.stat-value').textContent = knockIn + ' Deals';
      items[1].querySelector('.stat-value').className = 'stat-value ' + (knockIn ? 'warning' : 'success');
      items[2].querySelector('.stat-value').textContent = avgCoupon + '%';
      items[3].querySelector('.stat-value').textContent = multiStock + ' Deals';
    }
  }

  function updatePortfolioSummary() {
    var totalInvestment = HKELIApp.data.eliDeals.reduce(function (s, d) { return s + (d.purchasePrice || 0); }, 0);
    var currentValue = HKELIApp.data.eliDeals.reduce(function (s, d) { return s + (d.currentValue || 0); }, 0);
    var totalPnL = currentValue - totalInvestment;
    var totalInvestmentEl = document.getElementById('total-investment');
    var currentValueEl = document.getElementById('current-value');
    var totalPnlEl = document.getElementById('total-pnl');
    var activeDealsEl = document.getElementById('active-deals');
    if (totalInvestmentEl) totalInvestmentEl.textContent = formatHKCurrency(totalInvestment);
    if (currentValueEl) currentValueEl.textContent = formatHKCurrency(currentValue);
    if (totalPnlEl) {
      var pct = totalInvestment > 0 ? ((totalPnL / totalInvestment) * 100).toFixed(2) : '0.00';
      totalPnlEl.textContent = (totalPnL >= 0 ? '+' : '') + formatHKCurrency(totalPnL);
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
    HKELIApp.filteredDeals = HKELIApp.data.eliDeals.slice();
    if (HKELIApp.filteredDeals.length === 0) {
      dealsGrid.innerHTML = '<div class="card"><div class="card__body"><h3>No deals found</h3><p>Click "Add New HK ELI Deal" to get started.</p></div></div>';
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
    return '<div class="deal-card" data-deal-id="' + deal.id + '">' +
      '<div class="deal-header"><div class="deal-header-left">' +
        '<div class="stock-count-badge"><i class="fas fa-layer-group"></i>' +
        deal.numberOfStocks + ' Stock' + (deal.numberOfStocks > 1 ? 's' : '') + '</div>' +
        '<div class="deal-title">' + deal.dealName + '</div>' +
        '<div class="deal-id">' + deal.id + '</div></div>' +
      '<div class="deal-header-right">' +
        '<div class="deal-status ' + statusClass + '">' + deal.status + '</div>' +
        '<div class="deal-actions">' +
          '<button class="deal-action-btn edit" title="Edit"><i class="fas fa-edit"></i></button>' +
          '<button class="deal-action-btn delete" title="Delete"><i class="fas fa-trash"></i></button>' +
        '</div></div></div>' +
      '<div class="deal-pricing">' +
        '<div class="pricing-row"><span class="pricing-label">Nominal Amount:</span><span class="pricing-value hk-currency">' + formatHKCurrency(deal.nominalAmount) + '</span></div>' +
        '<div class="pricing-row"><span class="pricing-label">Purchase Price:</span><span class="pricing-value hk-currency">' + formatHKCurrency(deal.purchasePrice) + '</span></div>' +
        '<div class="pricing-row"><span class="pricing-label">Coupon Rate:</span><span class="pricing-value yield-impact">' + deal.couponRate + '%</span></div>' +
      '</div>' +
      '<div class="deal-metrics">' +
        '<div class="metric"><div class="metric-label">Current Value</div><div class="metric-value hk-currency">' + formatHKCurrency(deal.currentValue) + '</div></div>' +
        '<div class="metric"><div class="metric-label">P&L</div><div class="metric-value ' + ((deal.pnl || 0) >= 0 ? 'positive' : 'negative') + '">' +
          ((deal.pnl || 0) >= 0 ? '+' : '') + formatHKCurrency(deal.pnl) + ' (' + pnlPct + '%)</div></div>' +
        '<div class="metric"><div class="metric-label">Days to Maturity</div><div class="metric-value">' + (daysToMat > 0 ? daysToMat : 'Settled') + '</div></div>' +
        '<div class="metric"><div class="metric-label">Issuer</div><div class="metric-value">' + deal.issuer + '</div></div>' +
      '</div>' +
      '<div class="underlying-assets">' +
        (deal.underlyingAssets || []).map(function (a) {
          var change = calculatePriceChange(a);
          return '<div class="underlying-asset">' +
            '<div class="asset-info"><h4><span class="hk-stock-code">' + a.symbol + '</span>' + a.name +
              (deal.numberOfStocks > 1 ? '<span class="asset-weight">(' + (a.weight * 100).toFixed(1) + '%)</span>' : '') +
              '</h4><p>Strike: ' + formatHKPrice(a.strikePrice, 4) + ' | Barrier: ' + formatHKPrice(a.barrierLevel, 4) + '</p></div>' +
            '<div class="price-info"><div class="current-price hk-currency">' + formatHKCurrency(a.currentPrice) + '</div>' +
            '<div class="price-change ' + (change >= 0 ? 'positive' : 'negative') + '">' +
              (change >= 0 ? '+' : '') + change.toFixed(2) + '%</div></div></div>';
        }).join('') +
      '</div>' +
      '<div class="barrier-indicator">' +
        '<span class="barrier-text">Barrier Safety</span>' +
        '<div class="barrier-bar"><div class="barrier-fill ' + barrier.class + '" style="width: ' + barrier.percentage + '%"></div></div>' +
        '<span class="barrier-text">' + barrier.percentage.toFixed(0) + '%</span>' +
      '</div>' +
    '</div>';
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
        detailRow('Nominal Amount', formatHKCurrency(deal.nominalAmount), 'hk-currency') +
        detailRow('Purchase Price', formatHKCurrency(deal.purchasePrice), 'hk-currency') +
        detailRow('Current Value', formatHKCurrency(deal.currentValue), 'hk-currency') +
        detailRow('P&L', (deal.pnl >= 0 ? '+' : '') + formatHKCurrency(deal.pnl), deal.pnl >= 0 ? 'positive' : 'negative') +
      '</div></div></div>';
    var c = document.getElementById('deal-detail-content');
    if (c) c.innerHTML = html;
    showDealDetailModal();
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
    setTimeout(function () {
      updateStockConfiguration();
      setTimeout(function () { populateStockInputsFromDeal(deal); }, 50);
    }, 100);
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
    Storage.deleteDeal(HKELIApp.deletingDealId);
    loadDealsIntoState();
    reassignELIIds();
    persistDeals();
    hideDeleteConfirmation();
    renderDashboard();
    if (HKELIApp.currentView === 'deals') renderDeals();
    showToast('Deal deleted', 'success');
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
      pnl: 0
    };
    if (editId) {
      Storage.updateDeal(editId, payload);
      showToast('Deal updated', 'success');
    } else {
      Storage.addDeal(payload);
      showToast('Deal added', 'success');
    }
    loadDealsIntoState();
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
    if (typeof updateRiskAnalytics === 'function') updateRiskAnalytics();
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
    updateNotificationBadge();
  }
  function renderAlerts() {
    var list = document.getElementById('alerts-list');
    if (!list) return;
    if (!HKELIApp.data.alerts.length) {
      list.innerHTML = '<div class="card"><div class="card__body"><h3>No alerts</h3><p>All clear. Add ELI deals to start monitoring barrier and maturity risks.</p></div></div>';
      return;
    }
    list.innerHTML = HKELIApp.data.alerts.map(function (a) {
      return '<div class="alert-item severity-' + a.severity + '">' +
        '<div class="alert-icon"><i class="fas fa-exclamation-' + (a.severity === 'critical' ? 'triangle' : 'circle') + '"></i></div>' +
        '<div class="alert-content"><h4>' + a.type + '</h4><p>' + a.message + '</p><span class="alert-time">' + formatTimeAgo(a.timestamp) + '</span></div>' +
      '</div>';
    }).join('');
  }
  function updateNotificationBadge() {
    var badge = document.getElementById('notification-count');
    if (badge) badge.textContent = HKELIApp.data.alerts.length;
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
    var search = document.getElementById('search-deals');
    var sv = status ? status.value : '';
    var cv = cnt ? cnt.value : '';
    var iv = iss ? iss.value : '';
    var xv = search ? search.value.toLowerCase() : '';
    HKELIApp.filteredDeals = HKELIApp.data.eliDeals.filter(function (deal) {
      var okS = !sv || deal.status === sv;
      var okC = !cv || String(deal.numberOfStocks) === cv;
      var okI = !iv || deal.issuer === iv;
      var okX = !xv || deal.dealName.toLowerCase().includes(xv) ||
        (deal.id || '').toLowerCase().includes(xv) ||
        (deal.underlyingAssets || []).some(function (a) {
          return a.symbol.toLowerCase().includes(xv) || (a.name || '').toLowerCase().includes(xv);
        });
      return okS && okC && okI && okX;
    });
    renderDeals();
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
  function performManualRefresh() { refreshPrices(); }

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
        'Underlying Assets': (deal.underlyingAssets || []).map(function (a) {
          return a.symbol + ':' + a.name + ':' + a.weight;
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

  function importCSV(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var parsed = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
        if (parsed.errors.length) { showToast('Error parsing CSV', 'error'); return; }
        var imported = parsed.data.map(function (row, index) {
          return {
            id: 'ELI-HK' + String(index + 1).padStart(3, '0'),
            dealName: row['Deal Name'] || 'Imported Deal',
            investmentDate: row['Investment Date'] || new Date().toISOString().split('T')[0],
            maturityDate: row['Maturity Date'] || new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
            nominalAmount: parseFloat(row['Nominal Amount']) || 100000,
            purchasePrice: parseFloat(row['Purchase Price']) || 98000,
            numberOfStocks: parseInt(row['Number of Stocks']) || 1,
            couponRate: parseFloat(row['Coupon Rate']) || 8.0,
            settlementMethod: row['Settlement Method'] || 'Cash Settlement',
            issuer: row['Issuer'] || 'Unknown',
            status: row['Status'] || 'Active',
            currentValue: parseFloat(row['Current Value']) || 100000,
            pnl: parseFloat(row['P&L']) || 0,
            underlyingAssets: [{
              symbol: '0700.HK', name: 'Tencent Holdings Ltd',
              currentPrice: 350, strikePrice: 400, barrierLevel: 300, weight: 1.0
            }]
          };
        });
        Storage.replaceAllDeals(imported);
        loadDealsIntoState();
        showToast('Imported ' + imported.length + ' deals from CSV', 'success');
        refreshPrices();
        renderDashboard();
        if (HKELIApp.currentView === 'deals') renderDeals();
      } catch (err) { showToast('Error importing CSV', 'error'); }
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
    if (!confirm('Clear all portfolio data? This cannot be undone (use Export first if you want a backup).')) return;
    Storage.replaceAllDeals([]);
    HKELIApp.data.alerts = [];
    loadDealsIntoState();
    renderDashboard();
    if (HKELIApp.currentView === 'deals') renderDeals();
    if (HKELIApp.currentView === 'alerts') renderAlerts();
    if (HKELIApp.refreshTimer) { clearInterval(HKELIApp.refreshTimer); HKELIApp.refreshTimer = null; }
    showToast('All portfolio data cleared', 'info');
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
    on('clear-alerts', 'click', function (e) { e.preventDefault(); clearAllAlerts(); });
    on('manual-refresh', 'click', function (e) { e.preventDefault(); performManualRefresh(); });
    on('export-csv', 'click', function (e) { e.preventDefault(); exportCSV(); });
    on('export-json', 'click', function (e) { e.preventDefault(); exportJSON(); });
    on('save-to-db', 'click', function (e) { e.preventDefault(); saveDealsToDatabase(); });
    on('load-from-db', 'click', function (e) { e.preventDefault(); loadDealsFromDatabase(); });
    on('save-settings', 'click', function (e) { e.preventDefault(); applySettings(); });

    // Test price source
    on('test-price-source', 'click', function (e) { e.preventDefault(); testPriceSource(); });
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

    ['status-filter', 'stock-count-filter', 'issuer-filter'].forEach(function (id) {
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

    renderDashboard();
    renderDeals();
    renderAlerts();
    updateNotificationBadge();
    updateRefreshDisplay();
    populateSettingsUI();
    updateDbStatusIndicator();
    // Refresh DB indicator after async SQLite init completes
    if (window.Storage && Storage.dbStatus) {
      Db.ready().then(updateDbStatusIndicator);
    }
    updateAPIStatus();
    updateMarketOpenStatus();
    setInterval(updateMarketOpenStatus, 60000);
    setInterval(checkBackendHealth, 30000);
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