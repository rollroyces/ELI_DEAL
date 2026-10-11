/**
 * Shared type definitions for HK ELI Portfolio Manager.
 *
 * This file contains only JSDoc typedefs and constants — no runtime code.
 * Loading it does NOT affect behavior; it only enables IDE intellisense
 * and inline documentation. Loaded before all other modules in
 * index.html so the @typedefs are globally visible.
 *
 * If you add or rename a field here, search the codebase for callers and
 * update them. The runtime shape in tests.html is the source of truth for
 * what the app actually accepts.
 *
 * @file js/types.js
 * @author MiniMax
 */

/**
 * Status of an ELI deal, recomputed on every price refresh.
 * - 'Active': normal
 * - 'Knock-in Triggered': any underlying ≤ barrier
 * - 'Approaching Maturity': within 30 days of maturity
 * - 'Settled': maturity date passed
 * @typedef {'Active'|'Knock-in Triggered'|'Approaching Maturity'|'Settled'} DealStatus
 */

/**
 * Settlement method supported by ELI deals.
 * - 'Cash Settlement': cash at maturity based on worst-of payoff
 * - 'Physical Delivery': physical shares of the worst performer
 * - 'Worst Performer Physical': physical shares of the worst performer (basket)
 * @typedef {'Cash Settlement'|'Physical Delivery'|'Worst Performer Physical'} SettlementMethod
 */

/**
 * HK stock underlying an ELI deal.
 * @typedef {Object} UnderlyingAsset
 * @property {string} symbol            Yahoo Finance symbol, e.g. "0700.HK"
 * @property {string} name              Human-readable name
 * @property {number} strikePrice       Strike price at deal inception (HK$)
 * @property {number} barrierLevel      Knock-in barrier (HK$)
 * @property {number} weight            Basket weight, 0..1 (sums to 1 for baskets; 1 for single-stock)
 * @property {number} [currentPrice]    Latest live price; backfilled to strike on load if missing
 */

/**
 * One ELI deal.
 * @typedef {Object} Deal
 * @property {string} id                Compact, e.g. "ELI-HK001"
 * @property {string} dealName          User-supplied deal name
 * @property {string} investmentDate    ISO date (YYYY-MM-DD)
 * @property {string} maturityDate      ISO date (YYYY-MM-DD)
 * @property {number} nominalAmount     Face value in HK$
 * @property {number} purchasePrice     Amount paid at issue (HK$)
 * @property {number} numberOfStocks    1..4
 * @property {number} couponRate        Annual coupon %, e.g. 12.5
 * @property {SettlementMethod} settlementMethod
 * @property {string} issuer            Issuing bank name
 * @property {DealStatus} status        Recomputed each refresh
 * @property {number} [currentValue]    Mark-to-market value (HK$)
 * @property {number} [pnl]             currentValue - currentValue (HK$)
 * @property {UnderlyingAsset[]} underlyingAssets
 * @property {string} [createdAt]       ISO timestamp
 * @property {string} [updatedAt]       ISO timestamp
 */

/**
 * One alert raised by the alert engine.
 * @typedef {Object} Alert
 * @property {string} id
 * @property {'Barrier Breach'|'Barrier Proximity'|'Maturity Notice'} type
 * @property {string} message
 * @property {number} timestamp         epoch ms
 * @property {'info'|'warning'|'critical'} severity
 * @property {string} dealId
 * @property {boolean} [read]
 */

/**
 * Persisted user settings.
 * @typedef {Object} Settings
 * @property {number} refreshInterval   ms between auto-refreshes (default 4h)
 * @property {number|null} lastRefresh  epoch ms
 * @property {string} [finnhubApiKey]   User-supplied fallback key
 * @property {number} [alertThresholdPct] Barrier proximity threshold (default 10)
 * @property {'hkd'|'usd'} [currencyDisplay]
 * @property {'auto'|'light'|'dark'} [theme]  Manual theme override
 * @property {string[]} [recentlyViewedSymbols]
 */

/**
 * One row in the price_history table.
 * @typedef {Object} PriceSnapshot
 * @property {string} symbol
 * @property {number} price
 * @property {number} timestamp         epoch ms
 * @property {string} [source]          'yahoo'|'finnhub'|'cache'
 */

/**
 * Price-source health snapshot.
 * @typedef {Object} ApiStatus
 * @property {boolean} connected
 * @property {number|null} lastSuccessfulRefresh
 * @property {string|null} lastError
 * @property {'yahoo'|'finnhub'|'cache'|'none'|'idle'} source
 */

/**
 * Sector classification for HK-listed stocks. Used for analytics
 * (sector concentration, max drawdown, scenario simulation).
 * @typedef {'Technology'|'Financials'|'Real Estate'|'Utilities'|'Energy'|'Consumer Discretionary'|'Consumer Staples'|'Healthcare'|'Industrials'|'Materials'|'Telecommunications'|'ETF'} Sector
 */

/**
 * Result of a worst-performer ELI payoff projection at hypothetical
 * settlement prices.
 * @typedef {Object} PayoffProjection
 * @property {number} notional                  Nominal amount
 * @property {number} worstReturnPct            Worst underlying's return vs strike (negative = loss)
 * @property {number} worstSymbol               Symbol of the worst performer
 * @property {boolean} knockInTriggered         Whether any underlying ≤ barrier at settlement
 * @property {number} cashPayoff                Cash received at maturity (HK$)
 * @property {number} coupon                    Coupon received over the life of the deal (HK$)
 * @property {number} totalReturn               cashPayoff + coupon - purchasePrice
 * @property {number} totalReturnPct            totalReturn / purchasePrice
 * @property {SettlementMethod} settlementMethod
 */

/**
 * Status of the SQLite backend.
 * @typedef {Object} DbStatus
 * @property {'opfs'|'memory'|'failed'|'unavailable'} backend
 * @property {boolean} ready
 * @property {number} dealCount
 * @property {string|null} error
 */

/**
 * Constants used across modules. Frozen at module load to discourage
 * accidental mutation.
 * @type {Readonly<{
 *   CACHE_TTL_FRESH_MS: number,
 *   CACHE_TTL_SOFT_MS: number,
 *   DEFAULT_REFRESH_INTERVAL_MS: number,
 *   ALERT_PROXIMITY_PCT: number,
 *   APPROACHING_MATURITY_DAYS: number,
 *   PRICE_HISTORY_RETENTION_MS: number
 * }>}
 */
window.ELI_CONSTANTS = Object.freeze({
  CACHE_TTL_FRESH_MS: 30 * 60 * 1000,        // 30 min
  CACHE_TTL_SOFT_MS: 24 * 60 * 60 * 1000,    // 24 h
  DEFAULT_REFRESH_INTERVAL_MS: 4 * 60 * 60 * 1000,
  ALERT_PROXIMITY_PCT: 10,
  APPROACHING_MATURITY_DAYS: 30,
  PRICE_HISTORY_RETENTION_MS: 90 * 24 * 60 * 60 * 1000  // keep 90 days
});