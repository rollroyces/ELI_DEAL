/**
 * ELI cash-flow calendar.
 *
 * Builds a chronological list of upcoming events across the portfolio:
 *   - { type: 'coupon',      date, dealId, dealName, amountHkd, symbol }
 *   - { type: 'maturity',    date, dealId, dealName, amountHkd, status }
 *   - { type: 'price_alert', date, dealId, dealName, symbol, message }
 *
 * Coupon events are spaced at the deal's `couponFrequencyMonths`
 * (default 3 — typical HK ELI pays quarterly). If a deal has no
 * `couponFrequencyMonths` set, we still emit a single on-maturity
 * coupon payment.
 *
 * Pure functions; no DOM access.
 *
 * @file js/calendar.js
 */
(function (global) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toISODate(d) {
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function eventId(deal, type, dateIso) {
    return 'EVT-' + deal.id + '-' + type + '-' + dateIso;
  }

  /**
   * Build the cash-flow event list for a list of deals, from `from` to `to`.
   * @param {import('./types.js').Deal[]} deals
   * @param {Object} [opts]
   * @param {Date} [opts.from]   defaults to today
   * @param {Date} [opts.to]     defaults to from + 365 days
   * @param {import('./types.js').Alert[]} [opts.alerts]
   * @returns {Array<{ id, type, date, dealId, dealName, amountHkd, ... }>}
   */
  function buildEvents(deals, opts) {
    opts = opts || {};
    var from = opts.from || new Date();
    var to = opts.to || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    var fromIso = toISODate(from);
    var toIso = toISODate(to);
    var events = [];

    (deals || []).forEach(function (deal) {
      if (!deal.maturityDate) return;
      var m = new Date(deal.maturityDate);
      if (m >= from && m <= to) {
        events.push({
          id: eventId(deal, 'maturity', deal.maturityDate),
          type: 'maturity',
          date: deal.maturityDate,
          dealId: deal.id,
          dealName: deal.dealName,
          amountHkd: deal.nominalAmount,
          status: deal.status,
          monthsAway: monthsBetween(new Date(), m)
        });
      }
      // Quarterly coupons: emit one per quarter from the next coupon date
      // through the maturity date, but only if they're between from and to.
      var issueDate = deal.investmentDate ? new Date(deal.investmentDate) : new Date();
      var freqMonths = deal.couponFrequencyMonths || 3;
      var coupon = (deal.couponRate || 0) / 100 / 4 * (deal.nominalAmount || 0);
      if (coupon <= 0) return;
      var next = addMonths(issueDate, freqMonths);
      while (next < m && next <= to) {
        if (next >= from) {
          events.push({
            id: eventId(deal, 'coupon', toISODate(next)),
            type: 'coupon',
            date: toISODate(next),
            dealId: deal.id,
            dealName: deal.dealName,
            amountHkd: coupon,
            monthsAway: monthsBetween(new Date(), next)
          });
        }
        next = addMonths(next, freqMonths);
      }
    });

    // Future price alerts (only those with `expiresAt` or `eventDate` set)
    (opts.alerts || []).forEach(function (a) {
      if (a.eventDate && a.eventDate >= fromIso && a.eventDate <= toIso) {
        events.push({
          id: a.id || eventId({ id: 'ALERT' }, 'alert', a.eventDate),
          type: 'price_alert',
          date: a.eventDate,
          dealId: a.dealId,
          dealName: a.dealName || '',
          symbol: a.symbol,
          message: a.message
        });
      }
    });

    events.sort(function (a, b) {
      if (a.date === b.date) {
        if (a.type === b.type) return a.dealName.localeCompare(b.dealName);
        return a.type === 'maturity' ? -1 : a.type === 'coupon' ? 1 : 0;
      }
      return a.date < b.date ? -1 : 1;
    });
    return events;
  }

  function addMonths(d, months) {
    var nd = new Date(d);
    nd.setUTCMonth(nd.getUTCMonth() + months);
    return nd;
  }

  function monthsBetween(a, b) {
    return Math.round((b - a) / (1000 * 60 * 60 * 24 * 30.44));
  }

  /**
   * Group events by YYYY-MM for display purposes.
   * @param {Array} events
   * @returns {Object<string, Array>}  month key → events
   */
  function groupByMonth(events) {
    var out = {};
    (events || []).forEach(function (e) {
      var key = e.date.slice(0, 7);
      (out[key] = out[key] || []).push(e);
    });
    return out;
  }

  global.Calendar = {
    buildEvents: buildEvents,
    groupByMonth: groupByMonth
  };
})(window);