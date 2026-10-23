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
    maturity_within: { label: 'Matures within',    unit: 'days', severity: 'info',    scope: 'deal' },

    // Aggregate forms: "any deal tagged X", "any deal in sector Y".
    // These are what you'd actually want once the portfolio is big.
    worst_health_in_tag:   { label: 'Worst health in tag',    unit: '/100', severity: 'warning', scope: 'tag' },
    worst_pnl_in_tag:      { label: 'Worst P&L in tag',       unit: 'HK$',  severity: 'critical', scope: 'tag' },
    any_breach_in_tag:     { label: 'Any barrier breach in tag', unit: '',   severity: 'critical', scope: 'tag' },
    worst_health_in_sector:{ label: 'Worst health in sector', unit: '/100', severity: 'warning', scope: 'sector' },
    any_breach_in_sector:  { label: 'Any barrier breach in sector', unit: '', severity: 'critical', scope: 'sector' }
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
      // Deals normally share a price for a symbol (one refresh writes
      // them all), but a manual edit or a stale CSV import can leave two
      // holders disagreeing. Scan them all and take the CONSERVATIVE
      // price so the alert fires if any holder believes the condition
      // holds — and so the result never depends on array order.
      var seen = 0, owner = null;
      var best = rule.type === 'price_above' ? -Infinity : Infinity;
      for (var d = 0; d < deals.length; d++) {
        var assets = deals[d].underlyingAssets || [];
        for (var a = 0; a < assets.length; a++) {
          var ast = assets[a];
          if (ast.symbol !== rule.target) continue;
          if (typeof ast.currentPrice !== 'number') continue;
          seen++;
          if (!owner) owner = deals[d];
          if (rule.type === 'price_above') {
            if (ast.currentPrice > best) best = ast.currentPrice;
          } else {
            if (ast.currentPrice < best) best = ast.currentPrice;
          }
        }
      }
      if (!seen) return { fired: false };
      var priceHit = rule.type === 'price_above' ? best >= rule.value : best <= rule.value;
      return {
        fired: priceHit,
        severity: meta.severity,
        dealId: owner ? owner.id : null,
        message: rule.target + ' at HK$' + best.toFixed(2)
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

  // ──────────────────────────────────────────────────────────────────
  // Aggregate rules — evaluate across a tag or sector, not one deal
  // ──────────────────────────────────────────────────────────────────
  function sectorOf(symbol) {
    return (global.Sectors && typeof Sectors.lookup === 'function')
      ? Sectors.lookup(symbol).sector
      : null;
  }

  /**
   * Evaluate an aggregate rule (scope 'tag' or 'sector').
   * @param {AlertRule} rule
   * @param {import('./types.js').Deal[]} deals
   * @param {Object} helpers  { dealHealth }
   * @returns {{fired: boolean, message?: string, severity?: string, dealId?: string}}
   */
  function evaluateAggregateRule(rule, deals, helpers) {
    helpers = helpers || {};
    if (!rule || rule.enabled === false) return { fired: false };
    var meta = TYPE_META[rule.type];
    if (!meta || (meta.scope !== 'tag' && meta.scope !== 'sector')) return { fired: false };

    // Select the deals this rule applies to.
    var scope = meta.scope;
    var target = String(rule.target || '').toLowerCase();
    var matched = deals.filter(function (d) {
      if (scope === 'tag') {
        return (d.tags || []).some(function (t) { return String(t).toLowerCase() === target; });
      }
      return (d.underlyingAssets || []).some(function (a) {
        var s = sectorOf(a.symbol);
        return s && s.toLowerCase() === target;
      });
    });
    if (!matched.length) return { fired: false };

    var hits = [];

    if (rule.type === 'worst_health_in_tag' || rule.type === 'worst_health_in_sector') {
      if (!helpers.dealHealth) return { fired: false };
      matched.forEach(function (d) {
        var h = helpers.dealHealth(d);
        if (h && h.total <= rule.value) {
          hits.push({ dealId: d.id, text: d.dealName + ' health ' + h.total });
        }
      });
      if (!hits.length) return { fired: false };
      return {
        fired: true,
        severity: meta.severity,
        dealId: hits[0].dealId,
        message: hits.length + ' ' + scope + ' \'' + rule.target + '\' deal(s) at or below health ' +
          rule.value + ' — worst: ' + hits[0].text
      };
    }

    if (rule.type === 'worst_pnl_in_tag') {
      matched.forEach(function (d) {
        var p = d.pnl || 0;
        if (p <= rule.value) {
          hits.push({
            dealId: d.id,
            text: d.dealName + ' P&L ' + Math.round(p).toLocaleString()
          });
        }
      });
      if (!hits.length) return { fired: false };
      return {
        fired: true,
        severity: meta.severity,
        dealId: hits[0].dealId,
        message: hits.length + ' deal(s) tagged \'' + rule.target + '\' at or below ' +
          Math.round(rule.value).toLocaleString() + ' — worst: ' + hits[0].text
      };
    }

    if (rule.type === 'any_breach_in_tag' || rule.type === 'any_breach_in_sector') {
      matched.forEach(function (d) {
        (d.underlyingAssets || []).forEach(function (a) {
          if (a.barrierLevel && a.currentPrice && a.currentPrice <= a.barrierLevel) {
            hits.push({
              dealId: d.id,
              text: d.dealName + ' → ' + a.symbol + ' at HK$' + a.currentPrice.toFixed(2) +
                ' (barrier HK$' + a.barrierLevel.toFixed(2) + ')'
            });
          }
        });
      });
      if (!hits.length) return { fired: false };
      return {
        fired: true,
        severity: meta.severity,
        dealId: hits[0].dealId,
        message: hits.length + ' barrier breach(es) in ' + scope + ' \'' + rule.target + '\' — ' +
          hits[0].text
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
      var meta = TYPE_META[rule.type];
      var r;
      try {
        r = evaluateAggregateRule(rule, deals, helpers);
        if (!r.fired && meta && (meta.scope === 'symbol' || meta.scope === 'deal')) {
          r = evaluateRule(rule, deals, helpers);
        }
      }
      catch (e) { return; }
      if (!r.fired) return;
      out.push({
        id: 'ALERT-' + rule.id,
        type: (meta && meta.label) || rule.type,
        message: r.message,
        timestamp: now,
        severity: r.severity,
        dealId: r.dealId || null,
        custom: true,
        ruleId: rule.id,
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

  // ──────────────────────────────────────────────────────────────────
  // Acknowledgement
  //
  // Alerts are rebuilt from scratch on every price refresh, so without
  // this an alert you already dealt with would come back as unread
  // forever and the badge count could never drop. We persist the set of
  // alert ids the user has acknowledged and filter against it.
  //
  // An acknowledgement expires after ACKNOWLEDGEMENT_TTL_MS so a
  // condition that clears and later returns gets flagged again.
  // ──────────────────────────────────────────────────────────────────
  var ACKNOWLEDGEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  var ACKS_KEY = 'eli_alert_acks_v1';
  var MAX_ACKS = 500;

  function readAcks() {
    try {
      var raw = localStorage.getItem(ACKS_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }

  function writeAcks(acks) {
    try {
      var keys = Object.keys(acks);
      // Keep it bounded: drop the oldest entries first.
      if (keys.length > MAX_ACKS) {
        var sorted = keys.sort(function (a, b) {
          return (acks[a].ts || 0) - (acks[b].ts || 0);
        });
        sorted.slice(0, keys.length - MAX_ACKS).forEach(function (k) { delete acks[k]; });
      }
      localStorage.setItem(ACKS_KEY, JSON.stringify(acks));
    } catch (e) { /* ignore */ }
  }

  /** Acknowledge one alert id. */
  function acknowledge(alertId) {
    var acks = readAcks();
    acks[alertId] = { ts: Date.now() };
    writeAcks(acks);
    return acks;
  }

  /** Acknowledge every id in `ids`. */
  function acknowledgeAll(ids) {
    var acks = readAcks();
    (ids || []).forEach(function (id) { acks[id] = { ts: Date.now() }; });
    writeAcks(acks);
    return acks;
  }

  /** Drop acknowledgements so those alerts can surface again. */
  function resetAcknowledgements(ids) {
    var acks = readAcks();
    if (ids && ids.length) {
      ids.forEach(function (id) { delete acks[id]; });
    } else {
      acks = {};
    }
    writeAcks(acks);
    return acks;
  }

  /**
   * Mark alerts as read/unread based on the acknowledgement store.
   * Mutates and returns the array.
   */
  function applyAcknowledgements(alerts) {
    var acks = readAcks();
    var now = Date.now();
    (alerts || []).forEach(function (a) {
      var ack = acks[a.id];
      var live = ack && (now - (ack.ts || 0) < ACKNOWLEDGEMENT_TTL_MS);
      a.read = !!live;
      if (ack && !live) delete acks[a.id]; // expired, prune on the way through
    });
    writeAcks(acks);
    return alerts;
  }

  /** Count of alerts that have not been acknowledged. */
  function unreadCount(alerts) {
    return (alerts || []).filter(function (a) { return !a.read; }).length;
  }

  global.AlertRules = {
    TYPE_META: TYPE_META,
    makeRule: makeRule,
    addRule: addRule,
    removeRule: removeRule,
    toggleRule: toggleRule,
    evaluateRule: evaluateRule,
    evaluateAggregateRule: evaluateAggregateRule,
    evaluateRules: evaluateRules,
    attributeDealPnl: attributeDealPnl,
    attributePortfolioPnl: attributePortfolioPnl,
    cleanNote: cleanNote,
    hasNote: hasNote,
    escapeHtml: escapeHtml,
    acknowledge: acknowledge,
    acknowledgeAll: acknowledgeAll,
    resetAcknowledgements: resetAcknowledgements,
    applyAcknowledgements: applyAcknowledgements,
    unreadCount: unreadCount,
    ACKNOWLEDGEMENT_TTL_MS: ACKNOWLEDGEMENT_TTL_MS
  };
})(window);