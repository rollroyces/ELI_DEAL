/**
 * ELI worst-performer payoff calculator + scenario simulator.
 *
 * Background
 * ──────────
 * An Equity-Linked Investment pays back principal + coupon at maturity
 * UNLESS any underlying ever traded at-or-below its knock-in barrier.
 * In that case, the investor receives shares of the worst-performing
 * underlying (Physical Delivery / Worst Performer Physical) — the
 * payoff tracks the worst stock, not a blended average.
 *
 * This module:
 *   1. Projects the cash-equivalent payoff at settlement for a single
 *      deal given hypothetical settlement prices.
 *   2. Runs a Monte-Carlo scenario simulation across a basket of
 *      user-controlled shock levels ("what if every underlying drops
 *      30% by maturity?").
 *   3. Maintains the price history (one row per (symbol, day)) used
 *      for max drawdown calculations.
 *
 * No external deps; pure functions, easy to unit-test.
 *
 * @file js/payoff.js
 */
(function (global) {
  'use strict';

  /**
   * Compute the percentage return of one underlying vs its strike.
   * @param {import('./types.js').UnderlyingAsset} a
   * @returns {number} pct return vs strike (negative = loss)
   */
  function returnVsStrike(a) {
    if (!a || !a.strikePrice) return 0;
    var p = (typeof a.hypotheticalPrice === 'number') ? a.hypotheticalPrice : a.currentPrice;
    if (typeof p !== 'number') return 0;
    return (p - a.strikePrice) / a.strikePrice;
  }

  /**
   * Find the worst performer (lowest return vs strike).
   * Ties broken by weight (heavier weight first).
   * @param {import('./types.js').UnderlyingAsset[]} assets
   * @returns {{ asset: import('./types.js').UnderlyingAsset, returnPct: number }}
   */
  function worstPerformer(assets) {
    var list = (assets || []).slice();
    if (list.length === 0) return null;
    list.sort(function (a, b) {
      var ra = returnVsStrike(a);
      var rb = returnVsStrike(b);
      if (ra !== rb) return ra - rb;
      return (b.weight || 0) - (a.weight || 0);
    });
    return { asset: list[0], returnPct: returnVsStrike(list[0]) };
  }

  /**
   * Project the payoff at maturity given the current prices (or
   * `hypotheticalPrice` if set on each underlying).
   *
   * @param {import('./types.js').Deal} deal
   * @param {Object} [opts]
   * @param {boolean} [opts.assumeNoKnockIn]  If true, ignore the barrier
   *   status — useful for "what if barrier is never breached?" scenarios.
   * @returns {import('./types.js').PayoffProjection}
   */
  function projectPayoff(deal, opts) {
    opts = opts || {};
    if (!deal || !deal.underlyingAssets || deal.underlyingAssets.length === 0) {
      throw new Error('projectPayoff: deal has no underlying assets');
    }
    var assets = deal.underlyingAssets;

    // Knock-in detection: any underlying ≤ barrier (using current or
    // hypothetical price; either is a conservative signal).
    var knockIn = false;
    assets.forEach(function (a) {
      var p = (typeof a.hypotheticalPrice === 'number') ? a.hypotheticalPrice : a.currentPrice;
      if (a.barrierLevel && typeof p === 'number' && p <= a.barrierLevel) {
        knockIn = true;
      }
    });
    if (opts.assumeNoKnockIn) knockIn = false;

    var worst = worstPerformer(assets);
    if (!worst) {
      throw new Error('projectPayoff: no worst performer (empty basket?)');
    }
    var notional = deal.nominalAmount || 0;
    var couponPct = (deal.couponRate || 0) / 100;

    // Coupon is paid regardless of knock-in for typical ELIs.
    var coupon = notional * couponPct * (yearsToMaturity(deal) || 0);

    // Cash-equivalent settlement value:
    //   - No knock-in:  full nominal (par redemption)
    //   - Knock-in:    nominal × (worst return vs strike + 1), capped at 0
    var cashPayoff;
    if (!knockIn) {
      cashPayoff = notional; // par
    } else {
      // Worst performer's relative return vs strike, floored at -100%
      var factor = Math.max(0, 1 + worst.returnPct);
      cashPayoff = notional * factor;
    }

    var totalReturn = cashPayoff + coupon - (deal.purchasePrice || 0);
    var totalReturnPct = deal.purchasePrice > 0 ? (totalReturn / deal.purchasePrice) : 0;

    return {
      notional: notional,
      worstReturnPct: worst.returnPct,
      worstSymbol: worst.asset.symbol,
      knockInTriggered: knockIn,
      cashPayoff: cashPayoff,
      coupon: coupon,
      totalReturn: totalReturn,
      totalReturnPct: totalReturnPct,
      settlementMethod: deal.settlementMethod
    };
  }

  /**
   * Fractional years between today and maturityDate.
   * @param {import('./types.js').Deal} deal
   * @returns {number}  Years (may be 0 if already past).
   */
  function yearsToMaturity(deal) {
    if (!deal || !deal.maturityDate) return 0;
    var ms = new Date(deal.maturityDate).getTime() - Date.now();
    if (ms <= 0) return 0;
    return ms / (365.25 * 24 * 60 * 60 * 1000);
  }

  /**
   * Run a scenario simulation: shock each underlying by `shockPct`
   * (e.g. -0.30 = "30% drawdown") and project the payoff.
   *
   * @param {import('./types.js').Deal} deal
   * @param {number} shockPct      e.g. -0.20 for "every underlying falls 20%"
   * @param {boolean} [assumeNoKnockIn]
   * @returns {import('./types.js').PayoffProjection}
   */
  function simulateShock(deal, shockPct, assumeNoKnockIn) {
    var clone = JSON.parse(JSON.stringify(deal));
    (clone.underlyingAssets || []).forEach(function (a) {
      a.hypotheticalPrice = (a.currentPrice || a.strikePrice) * (1 + shockPct);
    });
    return projectPayoff(clone, { assumeNoKnockIn: assumeNoKnockIn });
  }

  /**
   * Sweep a range of shocks and return payoff vs shock curve points.
   * Useful for the scenario simulator chart.
   *
   * @param {import('./types.js').Deal} deal
   * @param {Object} [opts]
   * @param {number} [opts.from=-0.5]   Most-negative shock to test
   * @param {number} [opts.to=0.20]     Most-positive shock to test
   * @param {number} [opts.steps=15]    Number of points
   * @param {boolean} [opts.assumeNoKnockIn]
   * @returns {{ shocks: number[], returns: number[], knockInAt: number|null }}
   */
  function sweepShocks(deal, opts) {
    opts = opts || {};
    var from = typeof opts.from === 'number' ? opts.from : -0.5;
    var to = typeof opts.to === 'number' ? opts.to : 0.20;
    var steps = typeof opts.steps === 'number' ? opts.steps : 15;
    var shocks = [];
    var returns = [];
    var knockInAt = null;
    for (var i = 0; i < steps; i++) {
      var s = from + (to - from) * (i / (steps - 1));
      var p = simulateShock(deal, s, opts.assumeNoKnockIn);
      shocks.push(s);
      returns.push(p.totalReturnPct);
      if (p.knockInTriggered && knockInAt === null) knockInAt = s;
    }
    return { shocks: shocks, returns: returns, knockInAt: knockInAt };
  }

  /**
   * Compute maximum drawdown (%) for one underlying given its price
   * history (chronological array of { price, timestamp }).
   *
   * @param {{ price: number, timestamp: number }[]} history
   * @returns {{ maxDrawdownPct: number, peak: number, trough: number, peakTs: number, troughTs: number }}
   */
  function maxDrawdown(history) {
    if (!Array.isArray(history) || history.length < 2) {
      return { maxDrawdownPct: 0, peak: 0, trough: 0, peakTs: 0, troughTs: 0 };
    }
    var peak = history[0].price;
    var peakTs = history[0].timestamp;
    var trough = history[0].price;
    var troughTs = history[0].timestamp;
    var peakAfter = peak;       // running peak
    var peakAfterTs = peakTs;
    var maxDd = 0;
    var peakAtMaxDd = peakTs;
    var troughAtMaxDd = troughTs;
    for (var i = 1; i < history.length; i++) {
      var p = history[i].price;
      if (p > peakAfter) {
        peakAfter = p;
        peakAfterTs = history[i].timestamp;
        trough = p;
        troughTs = history[i].timestamp;
      } else if (p < trough) {
        trough = p;
        troughTs = history[i].timestamp;
      }
      var dd = (peakAfter - p) / peakAfter;
      if (dd > maxDd) {
        maxDd = dd;
        peakAtMaxDd = peakAfterTs;
        troughAtMaxDd = history[i].timestamp;
      }
    }
    return {
      // Conventional sign: negative for a loss (e.g. "-33.3%" means
      // the price fell 33.3% from peak).
      maxDrawdownPct: -maxDd * 100,
      peak: peakAfter,
      trough: trough,
      peakTs: peakAtMaxDd,
      troughTs: troughAtMaxDd
    };
  }

  /**
   * Record a price snapshot in the price_history table (one row per
   * (symbol, day-bucket)). Returns count of rows inserted.
   *
   * @param {import('./types.js').Db} Db   The Db module (window.Db)
   * @param {Object<string, number>} prices
   * @param {string} [source='yahoo']
   * @returns {Promise<number>}
   */
  async function recordPriceSnapshots(Db, prices, source) {
    source = source || 'yahoo';
    if (!Db || !Db.ready || !prices) return 0;
    try {
      await Db.ready();
      if (!Db.recordSnapshots) return 0;  // older Db builds
      return await Db.recordSnapshots(prices, source);
    } catch (e) {
      console.warn('recordPriceSnapshots failed', e);
      return 0;
    }
  }

  global.Payoff = {
    projectPayoff: projectPayoff,
    worstPerformer: worstPerformer,
    simulateShock: simulateShock,
    sweepShocks: sweepShocks,
    maxDrawdown: maxDrawdown,
    yearsToMaturity: yearsToMaturity,
    returnVsStrike: returnVsStrike,
    recordPriceSnapshots: recordPriceSnapshots
  };
})(window);