/**
 * Sector classification for HK-listed stocks.
 *
 * Used by analytics (sector concentration, scenario simulator) and
 * the Payoff view. Tagged against Hang Seng Industry Classification
 * roughly. Symbol matches case-insensitively; ".HK" suffix optional.
 *
 * @file js/sectors.js
 */
(function (global) {
  'use strict';

  /**
   * symbol (uppercase, optional .HK) → { sector, subSector, exchange }
   * @type {Object<string, { sector: import('./types.js').Sector, subSector: string }>}
   */
  var TAGS = {
    // Technology / Internet
    '0700.HK': { sector: 'Technology', subSector: 'Internet' },
    '9988.HK': { sector: 'Technology', subSector: 'Internet' },
    '3690.HK': { sector: 'Technology', subSector: 'Internet' },
    '1810.HK': { sector: 'Technology', subSector: 'Smartphone' },
    '0981.HK': { sector: 'Technology', subSector: 'Semiconductor' },

    // Financials
    '0005.HK': { sector: 'Financials', subSector: 'Bank' },
    '0939.HK': { sector: 'Financials', subSector: 'Bank' },
    '1299.HK': { sector: 'Financials', subSector: 'Insurance' },
    '2318.HK': { sector: 'Financials', subSector: 'Insurance' },
    '0388.HK': { sector: 'Financials', subSector: 'Exchange' },
    '2388.HK': { sector: 'Financials', subSector: 'Bank' },
    '0011.HK': { sector: 'Financials', subSector: 'Bank' },

    // Real Estate
    '0016.HK': { sector: 'Real Estate', subSector: 'Property Dev' },
    '0017.HK': { sector: 'Real Estate', subSector: 'Property Dev' },

    // Utilities
    '0002.HK': { sector: 'Utilities', subSector: 'Power' },
    '0003.HK': { sector: 'Utilities', subSector: 'Gas' },
    '0006.HK': { sector: 'Utilities', subSector: 'Power' },
    '0066.HK': { sector: 'Industrials', subSector: 'Transport' },

    // Consumer
    '0027.HK': { sector: 'Consumer Discretionary', subSector: 'Gaming' },
    '1928.HK': { sector: 'Consumer Discretionary', subSector: 'Gaming' },
    '0175.HK': { sector: 'Consumer Discretionary', subSector: 'Auto' },

    // Telecom
    '0941.HK': { sector: 'Telecommunications', subSector: 'Carrier' },

    // Energy
    '0386.HK': { sector: 'Energy', subSector: 'Oil' },
    '0857.HK': { sector: 'Energy', subSector: 'Oil' },
    '2883.HK': { sector: 'Energy', subSector: 'Oil Services' },

    // Conglomerate / Industrial
    '0001.HK': { sector: 'Industrials', subSector: 'Conglomerate' },

    // ETFs
    '2800.HK': { sector: 'ETF', subSector: 'Index Tracker' },
    '2822.HK': { sector: 'ETF', subSector: 'A-Share ETF' },
    '2823.HK': { sector: 'ETF', subSector: 'A-Share ETF' }
  };

  function normalize(symbol) {
    if (!symbol) return '';
    return String(symbol).trim().toUpperCase();
  }

  /**
   * Look up sector info.
   * @param {string} symbol
   * @returns {{ sector: import('./types.js').Sector, subSector: string }}
   */
  function lookup(symbol) {
    var s = normalize(symbol);
    if (TAGS[s]) return TAGS[s];
    // Try without .HK if user typed digits only
    var m = s.match(/^0*(\d+)(?:\.HK)?$/);
    if (m) {
      var digits = m[1];
      while (digits.length < 4) digits = '0' + digits;
      if (TAGS[digits + '.HK']) return TAGS[digits + '.HK'];
    }
    return { sector: 'Industrials', subSector: 'Other' };
  }

  /**
   * Group deals by sector.
   * @param {import('./types.js').Deal[]} deals
   * @returns {Object<string, { sector: import('./types.js').Sector, totalValue: number, dealCount: number }>}
   */
  function groupBySector(deals) {
    var out = {};
    (deals || []).forEach(function (deal) {
      (deal.underlyingAssets || []).forEach(function (a) {
        var info = lookup(a.symbol);
        var key = info.sector;
        if (!out[key]) out[key] = { sector: info.sector, totalValue: 0, dealCount: 0, symbols: {} };
        out[key].totalValue += (deal.currentValue || 0) * (a.weight || 0);
        out[key].symbols[a.symbol] = (out[key].symbols[a.symbol] || 0) + (a.weight || 0);
      });
      // count once per deal (avoid double-counting baskets)
      var sectorsInDeal = {};
      (deal.underlyingAssets || []).forEach(function (a) {
        sectorsInDeal[lookup(a.symbol).sector] = true;
      });
      Object.keys(sectorsInDeal).forEach(function (sec) {
        if (!out[sec]) return;
        out[sec].dealCount += 1;
      });
    });
    return out;
  }

  global.Sectors = {
    lookup: lookup,
    groupBySector: groupBySector,
    /** All sectors in stable display order. */
    SECTOR_ORDER: [
      'Technology', 'Financials', 'Real Estate', 'Utilities',
      'Consumer Discretionary', 'Consumer Staples', 'Healthcare',
      'Industrials', 'Materials', 'Energy', 'Telecommunications', 'ETF'
    ]
  };
})(window);