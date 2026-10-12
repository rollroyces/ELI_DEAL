/**
 * Per-deal health score.
 *
 * Produces a 0-100 score plus a 4-component breakdown so the UI can
 * show a small radar / quadrant next to each deal. Higher is healthier.
 *
 * Components (each 0-25, summed to 0-100):
 *   - barrierSafety  :  how far the weakest underlying currently is above its barrier
 *   - timeToMaturity :  months remaining (linear decay 24mo → 100, 0mo → 0)
 *   - sectorSpread   :  how many distinct sectors the basket touches (1 → 0, 4 → 25)
 *   - issuerDiversity:  inverse share of the largest issuer across the portfolio
 *
 * Pure functions; no DOM access, easy to unit-test.
 *
 * @file js/health.js
 */
(function (global) {
  'use strict';

  /**
   * @typedef {Object} HealthComponent
   * @property {number} score     0-25
   * @property {string} label
   * @property {string} detail
   */

  /**
   * @typedef {Object} HealthResult
   * @property {number} total     0-100
   * @property {string} grade     'A'|'B'|'C'|'D'|'F'
   * @property {HealthComponent} barrierSafety
   * @property {HealthComponent} timeToMaturity
   * @property {HealthComponent} sectorSpread
   * @property {HealthComponent} issuerDiversity
   */

  // The four labels in the order we'll display them (clockwise from top).
  var AXES = ['barrierSafety', 'timeToMaturity', 'sectorSpread', 'issuerDiversity'];

  function barrierSafety(deal) {
    if (!deal || !deal.underlyingAssets || !deal.underlyingAssets.length) {
      return { score: 0, label: 'Barrier', detail: 'No underlying assets' };
    }
    var min = Infinity, worstSym = '—';
    (deal.underlyingAssets || []).forEach(function (a) {
      if (!a.barrierLevel) return;
      var dist = ((a.currentPrice || a.strikePrice) - a.barrierLevel) / a.barrierLevel * 100;
      if (dist < min) { min = dist; worstSym = a.symbol; }
    });
    if (!isFinite(min)) return { score: 0, label: 'Barrier', detail: 'No barrier set' };
    // Map: -10% or worse → 0, 0% → 5, 30%+ → 25
    var score;
    if (min <= -10) score = 0;
    else if (min <= 0) score = 5;
    else if (min >= 30) score = 25;
    else score = Math.round(5 + (min / 30) * 20);
    var klass = score >= 20 ? 'safe' : score >= 12 ? 'caution' : 'danger';
    return { score: score, label: 'Barrier', detail: worstSym + ' ' + min.toFixed(1) + '% above (' + klass + ')' };
  }

  function timeToMaturity(deal) {
    if (!deal || !deal.maturityDate) {
      return { score: 0, label: 'Maturity', detail: 'No maturity date' };
    }
    var monthsLeft = (new Date(deal.maturityDate) - Date.now()) / (1000 * 60 * 60 * 24 * 30.44);
    if (monthsLeft <= 0) return { score: 0, label: 'Maturity', detail: 'Settled' };
    // Map: 0 months → 0, 24+ months → 25
    var score = Math.max(0, Math.min(25, Math.round((monthsLeft / 24) * 25)));
    var bucket = monthsLeft < 1 ? '<1mo' : monthsLeft < 3 ? '<3mo' :
                 monthsLeft < 6 ? '<6mo' : monthsLeft < 12 ? '<1yr' : Math.round(monthsLeft) + 'mo';
    return { score: score, label: 'Maturity', detail: bucket + ' remaining' };
  }

  function sectorSpread(deal, allDeals) {
    if (!deal || !deal.underlyingAssets || !deal.underlyingAssets.length) {
      return { score: 0, label: 'Sectors', detail: 'No underlyings' };
    }
    var sectors = {};
    (deal.underlyingAssets || []).forEach(function (a) {
      var sec = (global.Sectors && Sectors.lookup(a.symbol).sector) || 'Unknown';
      sectors[sec] = true;
    });
    var n = Object.keys(sectors).length;
    var score = Math.min(25, n * (25 / 4));
    return { score: score, label: 'Sectors', detail: n + ' sector' + (n === 1 ? '' : 's') };
  }

  function issuerDiversity(deal, allDeals) {
    if (!allDeals || !allDeals.length) {
      return { score: 25, label: 'Issuer', detail: 'No portfolio context' };
    }
    var byIssuer = {};
    var total = 0;
    allDeals.forEach(function (d) {
      var i = d.issuer || 'Unknown';
      byIssuer[i] = (byIssuer[i] || 0) + (d.currentValue || 0);
      total += (d.currentValue || 0);
    });
    if (!total) return { score: 25, label: 'Issuer', detail: 'No values' };
    var maxShare = 0;
    Object.keys(byIssuer).forEach(function (i) {
      var share = byIssuer[i] / total;
      if (share > maxShare) maxShare = share;
    });
    // If portfolio is 100% one issuer → 0. If max share is 25% → 25.
    // Inverse: score = 25 * (1 - 4 * (maxShare - 0.25)) clamped to 0-25
    var score = Math.max(0, Math.min(25, Math.round(25 * (1 - Math.max(0, maxShare - 0.25) * 4))));
    return { score: score, label: 'Issuer', detail: Math.round(maxShare * 100) + '% concentration' };
  }

  function grade(total) {
    if (total >= 85) return 'A';
    if (total >= 70) return 'B';
    if (total >= 55) return 'C';
    if (total >= 40) return 'D';
    return 'F';
  }

  /**
   * Compute the full health result for one deal.
   * @param {import('./types.js').Deal} deal
   * @param {import('./types.js').Deal[]} [allDeals]  for issuer-diversity calc
   * @returns {HealthResult}
   */
  function computeHealth(deal, allDeals) {
    var bs = barrierSafety(deal);
    var tm = timeToMaturity(deal);
    var ss = sectorSpread(deal, allDeals);
    var id = issuerDiversity(deal, allDeals);
    var total = bs.score + tm.score + ss.score + id.score;
    return {
      total: total,
      grade: grade(total),
      barrierSafety: bs,
      timeToMaturity: tm,
      sectorSpread: ss,
      issuerDiversity: id
    };
  }

  /**
   * Compute health for the entire portfolio.
   * @param {import('./types.js').Deal[]} deals
   * @returns {HealthResult}  aggregate (value-weighted) + the per-deal map
   */
  function portfolioHealth(deals) {
    if (!deals || !deals.length) {
      return { total: 0, grade: 'F', perDeal: {}, barrierSafety: { score: 0, label: '', detail: '' },
               timeToMaturity: { score: 0, label: '', detail: '' },
               sectorSpread: { score: 0, label: '', detail: '' },
               issuerDiversity: { score: 0, label: '', detail: '' } };
    }
    var perDeal = {};
    var totals = { bs: 0, tm: 0, ss: 0, id: 0, w: 0 };
    deals.forEach(function (d) {
      var h = computeHealth(d, deals);
      perDeal[d.id] = h;
      var w = (d.currentValue || 1);
      totals.bs += h.barrierSafety.score * w;
      totals.tm += h.timeToMaturity.score * w;
      totals.ss += h.sectorSpread.score * w;
      totals.id += h.issuerDiversity.score * w;
      totals.w += w;
    });
    var total = Math.round((totals.bs + totals.tm + totals.ss + totals.id) / totals.w);
    return {
      total: total,
      grade: grade(total),
      perDeal: perDeal,
      barrierSafety: { score: Math.round(totals.bs / totals.w), label: 'Barrier', detail: 'value-weighted avg' },
      timeToMaturity: { score: Math.round(totals.tm / totals.w), label: 'Maturity', detail: 'value-weighted avg' },
      sectorSpread: { score: Math.round(totals.ss / totals.w), label: 'Sectors', detail: 'value-weighted avg' },
      issuerDiversity: { score: Math.round(totals.id / totals.w), label: 'Issuer', detail: 'value-weighted avg' }
    };
  }

  global.Health = {
    computeHealth: computeHealth,
    portfolioHealth: portfolioHealth,
    grade: grade,
    AXES: AXES
  };
})(window);