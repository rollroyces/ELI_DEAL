/**
 * Custom alert rules + per-deal notes.
 *
 * Two related but separable concerns:
 *
 *  1. AlertRules — user-defined monitoring. The built-in alert engine in
 *     app.js only knows about barrier breach / proximity / maturity. This
 *     module adds a small rule language on top so the user can say things
 *     like "tell me when 0700.HK goes above HK$450" or "tell me when any
 *     deal's health score drops below 60".
 *
 *  2. Notes — a free-text journal attached to a deal. Not an alert, but
 *     it lives on the deal record and needs the same escapeHtml treatment
 *     when rendered.
 *
 * Pure functions — no DOM, no storage. app.js owns persistence and rendering.
 *
 * @file js/alerts.js
 */
(function (global) {
  'use strict';

  /**
   * Rule types.
   * @typedef {'price_above'|'price_below'|'health_below'|'pnl_above'
   *          |'pnl_below'|'maturity_within'} RuleType
   */

  /**
   * @typedef {Object} AlertRule
   * @property {string} id
   * @property {RuleType} type
   * @property {string} target    symbol (e.g. '0700.HK'), 'portfolio', or a dealId
   * @property {number} value     threshold, interpreted per type
   * @property {boolean} [enabled]
   */

  /** Human labels for the UI. */
  var TYPE_META = {
    price_above:     { label: 'Price above',       unit: 'HK$', severity: 'info',     scope: 'symbol' },
    price_below:     { label: 'Price below',       unit: 'HK$', severity: 'warning',  scope: 'symbol' },
    health_below:    { label: 'Health score below', unit: '/100', severity: 'warning', scope: 'deal' },
    pnl_above:       { label: 'P&L above',         unit: 'HK$', severity: 'info',     scope: 'deal' },
    pnl_below:       { label: 'P&L below',         unit: 'HK$', severity: 'critical', scope: 'deal' },
    maturity_within: { label: 'Matures within',    unit: 'days', severity: 'info',    scope: 'deal' }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Rule CRUD (rules live in Storage; these are pure array helpers)
  // ──────────────────────────────────────────────────────────────────

  /** Validate + normalise a rule. Returns null if unusable. */
  function makeRule(input) {
    if (!input || !TYPE_META[input.type]) return null;
    var value = parseFloat(input.value);
    if (!isFinite(value)) return null;
    var target = String(input.target || '').trim();
    if (!target) return null;
    return {
      id: input.id || ('RULE-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)),
      type: input.type,
      target: target,
      value: value,
      enabled: input.enabled !== false
    };
  }

  function addRule(rules, input) {
    var rule = makeRule(input);
    if (!rule) return { rules: rules || [], added: null };
    return { rules: (rules || []).concat([rule]), added: rule };
  }

  function removeRule(rules, id) {
    return (rules || []).filter(function (r) { return r.id !== id; });
  }

  function toggleRule(rules, id) {
    return (rules || []).map(function (r) {
      return r.id === id ? Object.assign({}, r, { enabled: !r.enabled }) : r;
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Evaluation
  // ──────────────────────────────────────────────────────────────────

  /**
   * Evaluate one rule against the current portfolio state.
   *
   * @param {AlertRule} rule
   * @param {import('./types.js').Deal[]} deals
   * @param {Object} helpers  { portfolioPnl, portfolioHealth }
   * @returns {{fired: boolean, message?: string, severity?: string, dealId?: string}}
   */
  function evaluateRule(rule, deals, helpers) {
    helpers = helpers || {};
    if (!rule || rule.enabled === false) return { fired: false };

    var meta = TYPE_META[rule.type];
    if (!meta) return { fired: false };

    // Portfolio-scoped
    if (rule.target === 'portfolio') {
      if (rule.type === 'pnl_above' || rule.type === 'pnl_below') {
        var pnl = helpers.portfolioPnl != null ? helpers.portfolioPnl : 0;
        var hit = rule.type === 'pnl_above' ? pnl >= rule.value : pnl <= rule.value;
        return {
          fired: hit,
          severity: meta.severity,
          message: 'Portfolio P&L ' + (pnl >= 0 ? '+' : '') + Math.round(pnl).toLocaleString()
            + ' ' + (rule.type === 'pnl_above' ? '≥' : '≤') + ' ' + Math.round(rule.value).toLocaleString()
        };
      }
      return { fired: false };
    }

    // Symbol-scoped (price rules)
    if (meta.scope === 'symbol') {
      var found = null, owner = null;
      deals.forEach(function (d) {
        (d.underlyingAssets || []).forEach(function (a) {
          if (a.symbol === rule.target && typeof a.currentPrice === 'number') {
            found = a.currentPrice;
            owner = d;
          }
        });
      });
      if (found == null) return { fired: false };
      var priceHit = rule.type === 'price_above' ? found >= rule.value : found <= rule.value;
      return {
        fired: priceHit,
        severity: meta.severity,
        dealId: owner ? owner.id : null,
        message: rule.target + ' at HK$' + found.toFixed(2)
          + (rule.type === 'price_above' ? ' ≥ ' : ' ≤ ') + 'HK$' + rule.value.toFixed(2)
      };
    }

    // Deal-scoped
    var deal = deals.find(function (d) {
      return d.id === rule.target || d.dealName === rule.target;
    });
    if (!deal) return { fired: false };

    if (rule.type === 'health_below') {
      var h = helpers.dealHealth ? helpers.dealHealth(deal) : null;
      if (!h) return { fired: false };
      return {
        fired: h.total <= rule.value,
        severity: meta.severity,
        dealId: deal.id,
        message: deal.dealName + ' health ' + h.total + '/100 ≤ ' + rule.value
      };
    }
    if (rule.type === 'pnl_above' || rule.type === 'pnl_below') {
      var p = deal.pnl || 0;
      return {
        fired: rule.type === 'pnl_above' ? p >= rule.value : p <= rule.value,
        severity: meta.severity,
        dealId: deal.id,
        message: deal.dealName + ' P&L ' + (p >= 0 ? '+' : '') + Math.round(p).toLocaleString()
          + (rule.type === 'pnl_above' ? ' ≥ ' : ' ≤ ') + Math.round(rule.value).toLocaleString()
      };
    }
    if (rule.type === 'maturity_within') {
      var days = Math.ceil((new Date(deal.maturityDate) - Date.now()) / 86400000);
      var within = days >= 0 && days <= rule.value;
      return {
        fired: within,
        severity: meta.severity,
        dealId: deal.id,
        message: deal.dealName + ' matures in ' + days + ' day' + (days === 1 ? '' : 's')
      };
    }
    return { fired: false };
  }

  /**
   * Evaluate every enabled rule, returning alert objects shaped like the
   * built-in ones so the existing renderer needs no changes.
   *
   * @param {AlertRule[]} rules
   * @param {import('./types.js').Deal[]} deals
   * @param {Object} helpers
   * @returns {import('./types.js').Alert[]}
   */
  function evaluateRules(rules, deals, helpers) {
    var now = Date.now();
    var out = [];
    (rules || []).forEach(function (rule) {
      var r;
      try { r = evaluateRule(rule, deals, helpers); }
      catch (e) { return; }
      if (!r.fired) return;
      out.push({
        id: 'ALERT-' + rule.id,
        type: TYPE_META[rule.type].label,
        message: r.message,
        timestamp: now,
        severity: r.severity,
        dealId: r.dealId || null,
        custom: true,
        read: false
      });
    });
    return out;
  }

  // ──────────────────────────────────────────────────────────────────
  // P&L attribution — which underlying actually drove the move
  // ──────────────────────────────────────────────────────────────────

  /**
   * Attribute a deal's P&L to each underlying.
   * Uses the same effective-share math the app uses to value a deal, so
   * the components sum back to the deal's total P&L exactly.
   *
   * `pctOfTotal` is expressed against GROSS movement (sum of |contribution|)
   * rather than net, because with opposing signs a net-relative percentage
   * is meaningless (a +10k and -15k pair gives -200% / +300%). Gross basis
   * always sums to 100% and reads correctly to a human.
   *
   * @param {import('./types.js').Deal} deal
   * @returns {Array<{symbol, name, contribution, pctOfTotal, netPnl, grossMove}>}
   */
  function attributeDealPnl(deal) {
    if (!deal || !deal.underlyingAssets || !deal.underlyingAssets.length) return [];
    var rows = deal.underlyingAssets.map(function (a) {
      var effShares = (deal.purchasePrice || 0) / (a.strikePrice || 1);
      var value = (a.currentPrice || 0) * effShares * (a.weight || 0);
      // Cost allocated to this leg, on the same basis.
      var cost = (deal.purchasePrice || 0) * (a.weight || 0);
      return {
        symbol: a.symbol,
        name: a.name,
        contribution: value - cost,
        pctOfTotal: 0,
        effectiveValue: value
      };
    });
    var net = rows.reduce(function (s, r) { return s + r.contribution; }, 0);
    var gross = rows.reduce(function (s, r) { return s + Math.abs(r.contribution); }, 0);
    rows.forEach(function (r) {
      r.pctOfTotal = gross !== 0 ? (Math.abs(r.contribution) / gross) * 100 : 0;
      r.netPnl = net;
      r.grossMove = gross;
    });
    return rows.sort(function (a, b) { return b.contribution - a.contribution; });
  }

  /** Attribution across the whole portfolio, ranked by absolute contribution. */
  function attributePortfolioPnl(deals) {
    var bySymbol = {};
    (deals || []).forEach(function (d) {
      attributeDealPnl(d).forEach(function (r) {
        if (!bySymbol[r.symbol]) {
          bySymbol[r.symbol] = {
            symbol: r.symbol,
            name: r.name,
            contribution: 0,
            deals: [],
            _grossShare: 0
          };
        }
        bySymbol[r.symbol].contribution += r.contribution;
        bySymbol[r.symbol]._grossShare += Math.abs(r.contribution);
        bySymbol[r.symbol].deals.push({ id: d.id, name: d.dealName, contribution: r.contribution });
      });
    });
    var rows = Object.keys(bySymbol).map(function (k) { return bySymbol[k]; });
    var gross = rows.reduce(function (s, r) { return s + r._grossShare; }, 0);
    var net = rows.reduce(function (s, r) { return s + r.contribution; }, 0);
    rows.forEach(function (r) {
      r.pctOfTotal = gross !== 0 ? (Math.abs(r.contribution) / gross) * 100 : 0;
      r.netPnl = net;
      r.grossMove = gross;
      delete r._grossShare;
    });
    return rows.sort(function (a, b) {
      return Math.abs(b.contribution) - Math.abs(a.contribution);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Notes
  // ──────────────────────────────────────────────────────────────────

  /** Trim a note, cap length, and strip control characters. */
  function cleanNote(text) {
    if (text == null) return '';
    return String(text)
      .replace(/[ --]/g, '')  // control chars except tab/newline
      .trim()
      .slice(0, 2000);
  }

  function hasNote(deal) {
    return !!(deal && typeof deal.notes === 'string' && deal.notes.trim().length);
  }

  global.AlertRules = {
    TYPE_META: TYPE_META,
    makeRule: makeRule,
    addRule: addRule,
    removeRule: removeRule,
    toggleRule: toggleRule,
    evaluateRule: evaluateRule,
    evaluateRules: evaluateRules,
    attributeDealPnl: attributeDealPnl,
    attributePortfolioPnl: attributePortfolioPnl,
    cleanNote: cleanNote,
    hasNote: hasNote,
    escapeHtml: escapeHtml
  };
})(window);