# HK ELI Portfolio Manager — GitHub Pages Edition

An interactive web app for managing Hong Kong Equity-Linked Investment (ELI)
deals with live price updates from **Yahoo Finance** (called directly from your
browser). Create and edit ELI deals (single or basket up to 4 HK stocks),
visualize allocations and performance with charts, and track barrier risks
and alerts.

**100% static. No server. No Docker. Free GitHub Pages hosting.**

This project was originally a Flask + MySQL app deployed via Docker. It has
been redesigned so the entire app runs in the browser — deal data lives in
`localStorage`, prices are fetched directly from Yahoo Finance's public
endpoint, and an optional Finnhub key can be set as a fallback.

---

## ✨ Features

- Add, edit, delete HK ELI deals (1–4 underlying HK stocks per deal)
- **Live HK stock prices** — fetched directly from Yahoo Finance in the
  browser, with a 3-minute in-memory + `localStorage` cache
- **Finnhub fallback** — paste your own free Finnhub API key in Settings;
  used automatically when Yahoo is rate-limited or unreachable
- **Auto status calculation** — barrier breach, approaching maturity, settled
- **Risk analytics** — HK market concentration, barrier risk exposure,
  diversification score
- **Charts** — allocation doughnut, performance bars, stock-count distribution
  (Chart.js)
- **Alerts** — barrier proximity / breach, approaching maturity, bell-badge
  popover
- **Import / Export** — CSV (single click) and JSON (full backup including
  settings) for moving data between devices
- **HKEX market-hours indicator** (Mon–Fri 9:30–12:00 and 13:00–16:00 HKT)
- Mobile-friendly responsive UI

---

## 🆚 What changed vs the old Docker version

| Old (Docker) | New (GitHub Pages) |
| --- | --- |
| Flask API + MySQL/SQLite | Browser-only — no backend |
| `yfinance` Python library | Direct `fetch()` to Yahoo Finance chart endpoint |
| Finnhub via server-side env var | Optional user-supplied key stored in `localStorage` |
| `Dockerfile` + `docker-compose.yml` | `.github/workflows/deploy.yml` (auto-deploy on push) |
| `requirements.txt` | None — just static HTML/CSS/JS |
| `pytest` test suite | Removed (server logic no longer exists) |
| `.env` with DB credentials | Not needed |
| API key for write protection | Not applicable — there is no write endpoint |

**Trade-offs to know about**

- Data is per-browser. To move data between devices, use **Settings →
  Backup All Data** (JSON download) and **Restore from Backup** on the
  other machine. CSV export/import also works for the deals only.
- Yahoo Finance does not publish an official CORS-enabled endpoint. The
  free public chart endpoint (`query1.finance.yahoo.com`) does respond
  with permissive CORS in practice, but Yahoo can throttle. The app
  mitigates this with a 3-minute cache, sequential fetches with small
  delays, and a graceful fallback to Finnhub.

---

## 🚀 Deploy in 60 seconds (GitHub Pages)

1. Push this folder to a new GitHub repository (any name).
2. On GitHub: **Settings → Pages → Build and deployment → Source**:
   choose **GitHub Actions**.
3. That's it. The included `.github/workflows/deploy.yml` deploys on
   every push to `main`. Your site will be live at
   `https://<user>.github.io/<repo>/`.

To deploy from your local checkout:

```bash
cd ELI_DEAL
git init
git add .
git commit -m "Initial commit"
gh repo create ELI_DEAL --public --source=. --push
# Then on GitHub: Settings → Pages → Source = "GitHub Actions"
```

Or push to an existing repo:

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

---

## 🧪 Run locally (no install needed)

Just open `index.html` in a browser. That's the whole app.

If your browser blocks `file://` fetch / localStorage quirks, serve the
folder with any static server:

```bash
# Python (no install if you have Python 3)
python3 -m http.server 8000
# Then open http://localhost:8000
```

```bash
# Or Node
npx http-server -p 8000
```

---

## 🗂 Project structure

```
ELI_DEAL/
├── index.html                 # App shell — loads the modules below
├── style.css                  # Design system + application styles
├── app.js                     # Main app: UI, state, rendering, events
├── js/
│   ├── storage.js             # localStorage wrapper (deals, settings, price cache)
│   ├── yahoo-finance.js       # Direct fetch to Yahoo Finance chart endpoint
│   └── finnhub.js             # Optional fallback when user supplies a key
├── .github/workflows/
│   └── deploy.yml             # Auto-deploy to GitHub Pages on push
├── .nojekyll                  # Skip Jekyll processing on Pages
├── .gitignore
├── LICENSE                    # MIT
└── README.md
```

---

## ⚙️ Configuration

There is no `.env` file anymore. All configuration lives in **Settings**:

| Setting | Where | Purpose |
| --- | --- | --- |
| Auto-refresh interval | Settings → Data Refresh | How often prices re-fetch (1 h / 4 h / 8 h / 12 h / 24 h) |
| Price alert threshold | Settings → Market Preferences | Trigger "Barrier Proximity" alerts within X% of barrier |
| Finnhub API key | Settings → Price Source | Optional fallback when Yahoo is rate-limiting |

**Finnhub key** — Sign up at <https://finnhub.io> for a free key (60 calls/min
on the free tier). Paste it into Settings → Price Source. The key is stored
only in your browser's `localStorage`; it never leaves your machine except
for direct calls to `finnhub.io`.

---

## 📦 Data model

A deal is a plain JSON object:

```jsonc
{
  "id": "ELI-HK001",
  "dealName": "Tencent + Alibaba Basket",
  "investmentDate": "2025-08-29",
  "maturityDate": "2026-05-01",
  "nominalAmount": 100000,
  "purchasePrice": 98000,
  "numberOfStocks": 2,
  "couponRate": 12.5,
  "settlementMethod": "Worst Performer Physical",
  "issuer": "Credit Suisse",
  "status": "Active",
  "currentValue": 103120,
  "pnl": 5120,
  "underlyingAssets": [
    {
      "symbol": "0700.HK",
      "name": "Tencent Holdings Ltd",
      "strikePrice": 380.00,
      "barrierLevel": 304.00,
      "weight": 0.5,
      "currentPrice": 412.50
    },
    {
      "symbol": "9988.HK",
      "name": "Alibaba Group",
      "strikePrice": 95.00,
      "barrierLevel": 76.00,
      "weight": 0.5,
      "currentPrice": 88.20
    }
  ],
  "createdAt": "2025-08-29T10:00:00.000Z"
}
```

`status` is recalculated on every price refresh:

1. Maturity passed → `Settled`
2. Any underlying ≤ barrier → `Knock-in Triggered`
3. Within 30 days of maturity → `Approaching Maturity`
4. Otherwise → `Active`

---

## 🔐 Security notes

- **No secrets in the repo** — there is no `.env` to leak.
- If you set a Finnhub key in Settings, it is stored in **your** browser's
  `localStorage` and sent only to `finnhub.io`. Anyone using the same
  browser profile can see it. For a public/shared machine, leave the key
  blank and rely on Yahoo Finance only.
- The app does **not** collect or transmit your deal data anywhere.

---

## 🩺 Troubleshooting

**Prices never update**

- Yahoo Finance occasionally blocks browser fetches from certain regions.
  Add a free Finnhub API key in Settings and prices will use it as fallback.
- Open DevTools → Network. If `query1.finance.yahoo.com` returns 429 or
  CORS errors, that confirms it.

**My deals disappeared after switching browsers**

- Data is per-browser. Use **Settings → Backup All Data** to export,
  then **Restore from Backup** on the other browser.

**GitHub Pages shows a 404**

- Make sure **Settings → Pages → Source = "GitHub Actions"** and that the
  workflow ran successfully in the **Actions** tab.

**CORS error in DevTools**

- Yahoo's public endpoints normally return `Access-Control-Allow-Origin: *`,
  but the response varies by region / endpoint. Switching the page to
  HTTPS (GitHub Pages serves over HTTPS automatically) usually resolves
  mixed-content issues when running locally.

---

## 📄 License

MIT — see [LICENSE](./LICENSE).

## ⚠️ Disclaimer

This application is for educational and portfolio tracking purposes only
and does not constitute financial advice. Market data may be delayed or
inaccurate; verify independently before making investment decisions.