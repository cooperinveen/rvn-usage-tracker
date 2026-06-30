# RVN Usage Tracker

A plain-English dashboard for Reuters broadcast monitoring data. Upload a Teletrax export and instantly see which stories aired, where, how many times, and on which channels — without needing to know how to use Teletrax.

**Live:** https://rvn-usage-tracker.vercel.app

---

## What it does

Teletrax monitors global TV broadcasts and detects when Reuters content airs. Their portal is complex enough that only a handful of people in the company can use it. This tool takes a Teletrax export file and turns it into something any producer can read.

Upload a `.csv` or `.xlsx` export → get:

- **Summary bar** — total stories, airings, channels, countries, air time for the period, over a random photo banner (one of 18, center-cropped, fresh on each page load)
- **Two views, one toggle** — switch between a **Stories** view (per-story rollup) and a **Channels** view (per-channel rollup) to answer either "how is this story performing?" or "what did NHK use of ours this week?"
- **Exclude US channels** — a switch beside the view tabs strips every US-based channel (and its airings) from the entire dashboard in one click. US channels are typically ~76% of channels and ~42% of airings, so editors and executives use this to see whether content has genuine international legs or whether the volume was all domestic pickup. Every metric recomputes correctly — reach, countries, trend, longevity and significance are all re-derived for the ex-US set, not just hidden — because the backend aggregates both the full and ex-US datasets up front and the toggle simply swaps which one is live (instant, no re-upload). Exports follow the toggle too.
- **Story table** — one row per story (columns: Story · Channels · Countries · Airings · Air Time · Trend · Reach · Longevity · Date Published), sortable by channels/countries/airings/reach/longevity/publish date, with search and region/minimum-airings filters. Each row shows an inline trend sparkline of airings per day across the dataset window.
- **Channel table** — one row per channel, sortable by airings/stories aired/significance, with search and min-airings filter. Same trend sparkline shape so rows compare visually.
- **Longevity stat** — for each story whose publish date is ≥24h before the dataset's end, the percentage of airings that happened *after* the first 24 hours from publish. Higher = the story had legs and kept being aired; lower = bursty pickup that died. Producers sort by this to find stories worth a follow-up.
- **Significance score** — a 0–100 composite per channel that rewards more than raw volume: it's the average of three percentile-ranked signals — **volume** (airings), **breadth** (distinct stories aired), and **diversity** (how geographically spread those stories' origins are, via a Gini-Simpson index, damped for tiny samples). Percentile-ranking each signal first stops the long-tailed airings count from dominating, so a wide, varied slate can out-rank a high-volume single-topic firehose. The score is *dataset-relative* — ranked against the other channels in the same upload.
- **Reach score** — the story-side analogue: a 0–100 per story rewarding *breadth of pickup* rather than raw airings. It's the mean of two percentile-ranked signals — **distinct channels** and **distinct countries** — so a story aired a few times each across many channels and countries out-ranks one aired hundreds of times on a single channel. Volume stays in the separate Airings column. Also *dataset-relative*.
- **Story detail modal** — click any row to see a full-size trend chart, six-card stats grid (airings, channels, countries, reach, total air time, longevity), top channel / top country / average clip length, and a paginated channel breakdown. An **"On this day"** stacked bar shows the top slug families (e.g. `IRAN-CRISIS/`, `USA-TARIFFS/`) published the same UTC day as this story by share of airings — Racing Green outline marks where this story's family sits, so producers can instantly see whether the story competed for attention against a dominant news event or had a quiet day to itself. A **Download view** button exports the whole modal as a single PNG, the same as the channel modal.
- **Channel detail modal** — click any channel row to see a slim **significance strip** at the top (the headline score plus its three sub-scores — volume / breadth / diversity — as side-by-side gauges, so producers see *why* a channel ranks where it does), a full trend chart, a story-origin pie chart, and a paginated list of every Reuters story that channel aired. The story list is filterable two ways: region pills (Europe / Americas / Asia Pacific / Middle East / Africa) and a **clickable pie** — click a slice (e.g. IRAN) and the list shrinks to that country's stories. Filters compose. A **Download view** button exports the whole modal — header, charts, filtered story list — as a single PNG for sharing.
- **Insights panel** — top 10 stories, channels, and countries at a glance. Click a top channel to open its detail modal.
- **Export** — download the aggregated summary as a clean Excel file. Split-button picker lets you choose top 25 / 50 / 100 rows for whichever view is active.

Each row is one **Story ID**, not one slug. Reuters reuses slugs daily (the only rule is not the same slug twice in 24h), so a single slug can cover several distinct stories in a week — each is kept as its own row. Stories are labelled in the Reuters producer-style format: first 4 digits of the story ID prepended to the slug (e.g. `5890-USA-SCREWWORM/`), which also disambiguates same-slug editions on screen.

Access is restricted to Thomson Reuters staff via Microsoft / Azure AD SSO.

---

## How to export from Teletrax

1. Log in at **teletrax.com**
2. Go to **Detections → New Report** (or open a saved report)
3. Set your date range and any filters
4. Click **Export** → choose **CSV** or **Excel (.xlsx)**
5. Upload the downloaded file at https://rvn-usage-tracker.vercel.app

Files up to ~50 MB are supported. For best performance, keep exports to 24–72 hours.

---

## Running locally

**Requirements:** Python 3.10+, Node.js 18+

```bash
# Clone and set up Python environment
cd rvn-usage-tracker
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Start the Flask server
python backend/app.py
```

Open http://localhost:5001. Local mode uses the `/api/upload` endpoint directly (no Vercel Blob needed).

---

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Python / Flask |
| Frontend | Vanilla HTML, CSS, JavaScript — no framework, no build step |
| Deployment | Vercel serverless |
| Large file uploads | Vercel Blob (browser → blob storage → Flask fetch) |
| Branding | Reuters design system (Clario font, TR Orange, Racing Green) |

---

## Project structure

```
api/                  Vercel entry points
  blob-upload.js      Node.js handler — generates signed upload tokens
  index.py            Python entry point (imports Flask app)
backend/
  app.py              Flask routes (/auth/*, /api/process, /api/upload, /api/export, /api/me)
  auth.py             MSAL wrapper for Azure AD auth code flow
  parser.py           Teletrax CSV/XLSX ingestion and aggregation
frontend/
  index.html          Single-page app (requires login)
  login.html          Sign-in screen with Microsoft button (rendered on auth errors)
  style.css           Reuters branding + all layout
  app.js              All client logic
  html2canvas.min.js  Vendored — used for modal PNG export. Not loaded via CDN
                      because vercel.json sets script-src 'self'
  images/banners/     18 pre-cropped 1920×400 hero photos (random per page load).
                      Force-added — .gitignore blanket-ignores images/
docs/                 Teletrax API reference (local only, gitignored)
requirements.txt      Python dependencies (root-level, required by Vercel)
vercel.json           Routing — blob-upload.js → Node, everything else → Python
```

---

## Deployment

The app is deployed on Vercel. To deploy:

```bash
npm install -g vercel   # first time only
vercel --prod
```

### Environment variables (set in Vercel dashboard)

| Variable | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store token — never log or print this |
| `AZURE_CLIENT_ID` | Azure AD app registration client ID |
| `AZURE_CLIENT_SECRET` | The secret **Value** (not the secret ID) from Azure → App registration → Certificates & secrets. Pasting the secret ID instead of the value causes `AADSTS7000215` and a silent redirect loop |
| `AZURE_TENANT_ID` | Reuters tenant ID |
| `REDIRECT_URI` | OAuth callback URL, e.g. `https://rvn-usage-tracker.vercel.app/auth/callback` |
| `FLASK_SECRET_KEY` | Static signing key for session cookies (generate with `python -c "import secrets; print(secrets.token_hex(32))"`) |

### Key constraints

- **4.5 MB serverless body limit** — files are uploaded directly to Vercel Blob by the browser, then fetched by Flask. This bypasses the limit entirely.
- **Stateless instances** — each serverless request may hit a different cold instance. All story data is returned in the upload response and stored in the browser; there are no follow-up server calls for story details.
- **60-second function timeout** — set in `vercel.json`. A 6 MB file (~116k rows) parses in roughly 20–30 seconds on Vercel.
