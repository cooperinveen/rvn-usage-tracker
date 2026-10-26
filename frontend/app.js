// ── State ──────────────────────────────────────────────────────────────────
const state = {
    view: 'stories',           // 'stories' | 'channels'
    allStories: [],
    filteredStories: [],
    allChannels: [],
    filteredChannels: [],
    currentPage: 1,
    chCurrentPage: 1,
    pageSize: 50,
    sortKey: 'airings',
    sortDir: 'desc',
    chSortKey: 'airings',
    chSortDir: 'desc',
    searchQuery: '',
    regionFilter: 'all',
    summary: null,
    topChannels: [],
    topMarkets: [],
    dateRange: {},
    datasets: { full: null, ex_us: null },  // both views from one upload; toggle swaps which is live
    excludeUS: false,
    selectedDay: null,         // null = all days | 'YYYY-MM-DD' | 'earlier' (published before the window)
};

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uploadScreen = $('upload-screen');
const dashboardScreen = $('dashboard-screen');
const uploadZone = $('upload-zone');
const fileInput = $('file-input');
const progressText = $('progress-text');
const uploadError = $('upload-error');
const loadingOverlay = $('loading-overlay');
const loadingText = $('loading-text');
const storiesTbody = $('stories-tbody');
const searchInput = $('search-input');
const searchClear = $('search-clear');
const storyModal = $('story-modal');
const modalSlug = $('modal-slug');
const modalHeadline = $('modal-headline');
const modalFirstAired = $('modal-first-aired');
const modalAssetLength = $('modal-asset-length');
const modalBody = $('modal-body');
const headerStatus = $('header-status');
const dataBadge = $('data-badge');

// ── Upload ──────────────────────────────────────────────────────────────────
uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
});
uploadZone.addEventListener('click', e => {
    // The "Choose File" <label> already opens the picker natively — don't open it twice.
    if (e.target.closest('label, input')) return;
    fileInput.click();
});
fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function handleFile(file) {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.xlsx')) {
        showUploadError('Please upload a .csv or .xlsx file exported from Teletrax.');
        return;
    }
    uploadFile(file);
}

// Optional second file: a Teletrax Asset export, staged before the detections
// file so choosing detections kicks off a combined upload. Null when not used.
let stagedAssetFile = null;
const assetFileInput = $('asset-file-input');
const assetSlotAdd = $('asset-slot-add');
const assetSlotChosen = $('asset-slot-chosen');
const assetSlotClear = $('asset-slot-clear');

if (assetFileInput) {
    assetFileInput.addEventListener('change', () => {
        const f = assetFileInput.files[0];
        if (!f) return;
        const name = f.name.toLowerCase();
        if (!name.endsWith('.csv') && !name.endsWith('.xlsx')) {
            showUploadError('The Asset export must be a .csv or .xlsx file from Teletrax.');
            assetFileInput.value = '';
            return;
        }
        hideUploadError();
        stagedAssetFile = f;
        assetSlotChosen.textContent = f.name;
        assetSlotChosen.style.display = '';
        assetSlotAdd.style.display = 'none';
        assetSlotClear.style.display = '';
    });
}
if (assetSlotClear) {
    assetSlotClear.addEventListener('click', (e) => {
        e.preventDefault();
        stagedAssetFile = null;
        if (assetFileInput) assetFileInput.value = '';
        assetSlotChosen.style.display = 'none';
        assetSlotAdd.style.display = '';
        assetSlotClear.style.display = 'none';
    });
}

async function uploadFile(file) {
    hideUploadError();
    showLoading('Uploading…', 'Sending file to server');

    try {
        // Step 1: upload directly to Vercel Blob (no 4.5 MB limit).
        // Real progress ring — driven by actual bytes sent (see uploadToBlob).
        showLoading('Uploading…', 'Transferring file to secure storage');
        showLoadingRing(0);
        const blobResult = await uploadToBlob(file);

        // Optional: upload the staged Asset export too (small file, uploaded after
        // the main one so the progress ring tracks the larger detections file).
        let assetBlob = null;
        if (stagedAssetFile) {
            assetBlob = await uploadToBlob(stagedAssetFile);
        }

        // Step 2: ask Flask to fetch from blob, parse, and return aggregated data.
        // No measurable progress here (single request, whole-response wait), so
        // fall back to the indeterminate spinner rather than fake a percentage.
        showLoading('Analysing your data…', 'Processing — this may take a moment for large files');
        showLoadingSpinner();
        const payload = { url: blobResult.url, filename: file.name };
        if (assetBlob) {
            payload.asset_url = assetBlob.url;
            payload.asset_filename = stagedAssetFile.name;
        }
        const res = await fetch('/api/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (!res.ok) {
            hideLoading();
            showUploadError(data.error || 'Processing failed. Please try again.');
            return;
        }

        state.datasets = { full: data.full, ex_us: data.ex_us };
        state.excludeUS = false;
        state.selectedDay = null;
        const usToggleInput = $('us-toggle-input');
        if (usToggleInput) usToggleInput.checked = false;
        loadData(data.full);
        showDashboard();
        const sum = data.full.summary;
        const zu = sum.zero_use_stories || 0;
        const zuNote = zu ? ` · ${zu.toLocaleString()} zero-use` : '';
        showToast(`Loaded ${sum.total_stories.toLocaleString()} stories from ${sum.total_airings.toLocaleString()} airings${zuNote}`);
    } catch (err) {
        hideLoading();
        showUploadError(err.message || 'Could not connect to the server. Please try again.');
    }
}

async function uploadToBlob(file) {
    // Sanitize filename — Vercel Blob rejects spaces, em dashes, and non-ASCII chars
    const ext = file.name.split('.').pop().toLowerCase();
    const basename = file.name.replace(/\.[^.]+$/, '');
    const safeBasename = basename.replace(/[^\w\-]/g, '_').replace(/_+/g, '_');
    // Unique name per upload: each blob is deleted after processing, and re-using
    // the same name for the next upload of that file intermittently 404'd when
    // the server fetched it. A fresh name means a URL that's never existed before.
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const pathname = `${safeBasename}-${uniq}.${ext}`;

    // Step 1: get a client token from our server-side handler
    const callbackUrl = window.location.origin + '/api/blob-upload';
    const tokenRes = await fetch('/api/blob-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'blob.generate-client-token',
            payload: { pathname, callbackUrl, multipart: false },
        }),
    });
    if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}));
        throw new Error(err.error || 'Could not get upload token');
    }
    const tokenData = await tokenRes.json();
    const clientToken = tokenData.clientToken;
    if (!clientToken) throw new Error('Invalid upload token response');

    // Step 2: PUT the file directly to Vercel Blob (no 4.5 MB limit)
    // access=public is required for browser-side PUT uploads (CORS)
    // Vercel Blob API expects pathname as a query param: /?pathname=<name>
    // Uses XMLHttpRequest (not fetch) so upload.onprogress can drive the real
    // progress ring — fetch() gives no upload-progress events.
    const responseText = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `https://blob.vercel-storage.com/?pathname=${encodeURIComponent(pathname)}`);
        xhr.setRequestHeader('authorization', `Bearer ${clientToken}`);
        xhr.setRequestHeader('x-api-version', '9');
        xhr.setRequestHeader('x-content-length', String(file.size));
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setLoadingRing(e.loaded / e.total);
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                setLoadingRing(1);
                resolve(xhr.responseText);
            } else {
                reject(new Error(`File upload to storage failed (${xhr.status}). ${xhr.responseText || ''}`));
            }
        };
        xhr.onerror = () => reject(new Error('File upload to storage failed (network error).'));
        xhr.send(file);
    });
    // Vercel Blob may return empty body on overwrite — fall back to constructing URL from known store
    let blobData;
    try { blobData = JSON.parse(responseText); } catch {}
    const url = blobData?.url || `https://Wu7t55j7ojJBLHfF.public.blob.vercel-storage.com/${encodeURIComponent(pathname)}`;
    return { url };
}

function loadData(data) {
    setDataFields(data);
    state.currentPage = 1;
    state.chCurrentPage = 1;
    state.searchQuery = '';
    state.regionFilter = 'all';
    state.view = 'stories';
    searchInput.value = '';
    setActivePill('all');
    setActiveView('stories');
}

// Point every state field the renders, modals and exports read from at `data`.
// Split from loadData so the day strip can swap data without resetting the
// user's search, region filter, sort or tab.
function setDataFields(data) {
    state.allStories = data.stories;
    state.allChannels = data.channels || [];
    state.summary = data.summary;
    state.topChannels = data.top_channels;
    state.topMarkets = data.top_markets;
    state.dateRange = data.date_range;
    state.trendLabels = data.trend_labels || [];
    state.trendUnit = data.trend_unit || 'day';
    state.dayContext = data.day_context || {};
    state.zeroUseWarning = data.zero_use_warning || null;
}

// ── Show/hide screens ────────────────────────────────────────────────────────
function showDashboard() {
    hideLoading();
    uploadScreen.style.display = 'none';
    dashboardScreen.style.display = 'block';
    headerStatus.style.display = 'flex';
    // Only offer the ex-US lens when there are US channels to remove.
    $('us-toggle').hidden = !state.datasets.ex_us;
    renderDayStrip();
    renderSummaryBar();
    renderInsights();
    renderZeroUseWarning();
    applyFilters();
}

// Persistent (not auto-dismissing) notice shown when the Asset and Detections
// exports cover different windows, so the zero-use list may be incomplete.
function renderZeroUseWarning() {
    const box = $('zero-use-warning');
    if (!box) return;
    if (state.zeroUseWarning) {
        $('zero-use-warning-text').textContent = state.zeroUseWarning;
        box.style.display = '';
    } else {
        box.style.display = 'none';
    }
}
const zuDismiss = $('zero-use-warning-dismiss');
if (zuDismiss) {
    zuDismiss.addEventListener('click', () => {
        const box = $('zero-use-warning');
        if (box) box.style.display = 'none';
    });
}

function showUploadScreen() {
    dashboardScreen.style.display = 'none';
    uploadScreen.style.display = 'block';
    headerStatus.style.display = 'none';
    fileInput.value = '';
    hideUploadError();
}

$('btn-new-upload').addEventListener('click', showUploadScreen);

// ── Summary Bar ─────────────────────────────────────────────────────────────
// Pick a random banner photo once per page load so the hero feels fresh on each
// visit but stays stable while the dashboard is in use. Files are pre-cropped to
// 1920×400 (frontend/images/banners/banner-01..18.jpg); CSS center-crops to fit.
const BANNER_COUNT = 18;
function setRandomBanner() {
    const n = Math.floor(Math.random() * BANNER_COUNT) + 1;
    const file = `images/banners/banner-${String(n).padStart(2, '0')}.jpg`;
    const bar = $('summary-bar');
    if (bar) bar.style.backgroundImage = `url('${file}')`;
}
setRandomBanner();

function renderSummaryBar() {
    const s = state.summary;
    const day = state.selectedDay;
    const scope = $('summary-scope');
    scope.hidden = !day;
    if (day) scope.textContent = `Published ${dayLongLabel(day)}`;
    $('stat-stories-label').textContent = day ? 'Stories published' : 'Stories tracked';
    $('stat-stories').textContent = s.total_stories.toLocaleString();
    $('stat-airings').textContent = s.total_airings.toLocaleString();
    $('stat-channels').textContent = s.total_channels.toLocaleString();
    $('stat-countries').textContent = s.total_countries.toLocaleString();
    $('stat-airtime').textContent = s.total_air_time;
    dataBadge.textContent = `${state.dateRange.from} – ${state.dateRange.to}`;
}

// ── Insights Panel ───────────────────────────────────────────────────────────
// Top stories ranked by channels (breadth of pickup), airings as the tie-break.
// Shared by the sidebar and the one-page summary so they always agree.
function topStoriesByChannels(n) {
    return state.allStories
        .filter(st => !st.zero_use)
        .sort((a, b) => b.channels - a.channels || b.airings - a.airings)
        .slice(0, n);
}

function renderInsights() {
    const topStories = topStoriesByChannels(10);
    const maxChannels = topStories[0]?.channels || 1;

    $('top-stories-list').innerHTML = topStories.map((s, i) => `
        <div class="insight-item" data-story-id="${escHtml(s.story_id || s.slug)}">
            <span class="insight-rank">${i + 1}</span>
            <div style="flex:1; min-width:0">
                <div class="insight-name">${slugDisplay(s)}</div>
                ${s.headline ? `<div class="insight-headline">${escHtml(s.headline)}</div>` : ''}
                <div class="insight-bar-wrap"><div class="insight-bar" style="width:${Math.round(s.channels/maxChannels*100)}%"></div></div>
            </div>
            <span class="insight-count" title="${s.channels} channels · ${s.airings} airings">${s.channels}</span>
        </div>
    `).join('');

    const maxChAirings = state.topChannels[0]?.airings || 1;
    $('top-channels-list').innerHTML = state.topChannels.map((c, i) => `
        <div class="insight-item" data-channel="${escHtml(c.channel)}">
            <span class="insight-rank">${i + 1}</span>
            <div style="flex:1; min-width:0">
                <div class="insight-name">${escHtml(c.channel)}</div>
                <div style="font-size:11px; color:var(--tr-text-light)">${escHtml(c.country || '')}</div>
                <div class="insight-bar-wrap"><div class="insight-bar" style="width:${Math.round(c.airings/maxChAirings*100)}%"></div></div>
            </div>
            <span class="insight-count">${c.airings}</span>
        </div>
    `).join('');

    const maxMktAirings = state.topMarkets[0]?.airings || 1;
    $('top-markets-list').innerHTML = state.topMarkets.map((m, i) => `
        <div class="insight-item">
            <span class="insight-rank">${i + 1}</span>
            <div style="flex:1; min-width:0">
                <div class="insight-name">${escHtml(m.market)}</div>
                <div class="insight-bar-wrap"><div class="insight-bar" style="width:${Math.round(m.airings/maxMktAirings*100)}%"></div></div>
            </div>
            <span class="insight-count">${m.airings}</span>
        </div>
    `).join('');
}

// ── View tabs (Stories / Channels) ───────────────────────────────────────────
function setActiveView(view) {
    state.view = view;
    document.querySelectorAll('.view-tab').forEach(t => {
        const on = t.dataset.view === view;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const isStories = view === 'stories';
    $('stories-table-wrap').style.display = isStories ? '' : 'none';
    $('channels-table-wrap').style.display = isStories ? 'none' : '';
    $('filter-row-stories').style.display = isStories ? '' : 'none';
    $('filter-row-channels').style.display = isStories ? 'none' : '';
    searchInput.placeholder = isStories
        ? 'Search by story slug — e.g. ukraine, iran, soccer...'
        : 'Search by channel — e.g. nhk, cnn, sky...';
    // Each view keeps its own search query/page so producers can flip between them.
    if (isStories) applyFilters();
    else applyChannelFilters();
}

document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => setActiveView(tab.dataset.view));
});

// Exclude-US toggle: swap the live dataset between the full and ex-US
// aggregations the backend returned. loadData() repoints every state field the
// renders, modals and exports read from, so the whole dashboard follows.
$('us-toggle-input').addEventListener('change', (e) => {
    const useExUS = e.target.checked;
    const ds = useExUS ? state.datasets.ex_us : state.datasets.full;
    if (!ds) return;
    state.excludeUS = useExUS;
    // Keep the chosen publish day across the swap, unless the ex-US data has no
    // stories published on it.
    if (state.selectedDay && !dayIndex(ds).some(d => d.key === state.selectedDay && d.stories > 0)) state.selectedDay = null;
    const keepView = state.view;   // don't bounce the user back to Stories
    loadData(dayView(ds, state.selectedDay));
    setActiveView(keepView);
    renderDayStrip();
    renderSummaryBar();
    renderInsights();
    showToast(useExUS ? 'US channels excluded' : 'Showing all channels');
});

// ── Publish-day view ─────────────────────────────────────────────────────────
// The day strip narrows every view to the stories *published* on one UTC day,
// with all of their airings across the export window. Built here from the
// breakdowns already in the payload — stories carry `publish_day` (UTC, from
// the activation date) and channels carry per-story rows in `all_stories` —
// so switching days is instant and needs no second trip to the server. The
// one thing that can't be rebuilt is a channel's airings-over-time trend.
const DAY_MS = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SIG_DIVERSITY_MIN_AIRINGS = 10;  // mirrors backend/parser.py

const storyKey = s => s.story_id || s.slug;  // same identity as the backend's _story_key
const ymdToMs = ymd => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const msToYmd = ms => new Date(ms).toISOString().slice(0, 10);

// '10 Oct 2026 01:30 UTC' (the backend's date_range format) → epoch ms, or null.
function parseRangeStamp(str) {
    const m = /^(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2})/.exec(str || '');
    const mon = m ? MONTHS_SHORT.indexOf(m[2]) : -1;
    return mon < 0 ? null : Date.UTC(+m[3], mon, +m[1], +m[4], +m[5]);
}

function windowBounds(ds) {
    const start = parseRangeStamp(ds.date_range?.from);
    return { startMs: start, startYmd: start != null ? msToYmd(start) : null, endMs: parseRangeStamp(ds.date_range?.to) };
}

// Strip bucket for a story: its UTC publish day, 'earlier' if it was published
// before the export window opened, or null when the publish time is unknown
// (those only appear under All days).
function dayBucket(s, startYmd) {
    if (!s.publish_day) return null;
    return startYmd && s.publish_day < startYmd ? 'earlier' : s.publish_day;
}

// 'Tue', '14 Oct' for a chip; 'Tue 14 Oct 2026' for labels.
function dayParts(ymd) {
    const d = new Date(ymdToMs(ymd));
    return [WEEKDAYS[d.getUTCDay()], `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`];
}
function dayLongLabel(key) {
    if (key === 'earlier') {
        const { startYmd } = windowBounds(state.datasets.full || {});
        return startYmd ? `before ${formatDayLabel(startYmd)}` : 'before this export';
    }
    return `${dayParts(key)[0]} ${formatDayLabel(key)}`;
}

// One entry per chip, oldest first: an 'earlier' bucket when needed, then every
// day from the first to the last publish day — quiet days stay in as empty
// chips so the row reads as a continuous calendar.
function dayIndex(ds) {
    const { startMs, startYmd, endMs } = windowBounds(ds);
    const byKey = new Map();
    for (const s of ds.stories) {
        const key = dayBucket(s, startYmd);
        if (!key) continue;
        const d = byKey.get(key) || { stories: 0, airings: 0 };
        d.stories++;
        d.airings += s.airings;
        byKey.set(key, d);
    }
    const out = [];
    if (byKey.has('earlier')) out.push({ key: 'earlier', ...byKey.get('earlier'), coverage: null, accumulating: false });
    const days = [...byKey.keys()].filter(k => k !== 'earlier').sort();
    if (!days.length) return out;
    for (let ms = ymdToMs(days[0]); ms <= ymdToMs(days[days.length - 1]); ms += DAY_MS) {
        const key = msToYmd(ms);
        // A story needs 24h on air before its numbers settle (the same bar
        // longevity uses). If the export ends under 48h after this day began,
        // some of its stories haven't had that yet.
        const accumulating = endMs != null && endMs < ms + 2 * DAY_MS;
        // Share of this UTC day that falls inside the export window (0–1), so
        // a day the export only partly covers is visible at a glance.
        const coverage = startMs != null && endMs != null
            ? Math.max(0, Math.min(ms + DAY_MS, endMs) - Math.max(ms, startMs)) / DAY_MS
            : null;
        out.push({ key, ...(byKey.get(key) || { stories: 0, airings: 0 }), coverage, accumulating });
    }
    return out;
}

// Dataset-shaped view of `ds` narrowed to one publish day, cached per dataset
// so flicking back and forth between days doesn't rebuild anything.
const dayViewCache = new WeakMap();
function dayView(ds, day) {
    if (!ds || !day) return ds;
    let perDs = dayViewCache.get(ds);
    if (!perDs) { perDs = new Map(); dayViewCache.set(ds, perDs); }
    if (!perDs.has(day)) perDs.set(day, buildDayView(ds, day));
    return perDs.get(day);
}

function buildDayView(ds, day) {
    const { startYmd } = windowBounds(ds);
    const stories = ds.stories.filter(s => dayBucket(s, startYmd) === day);
    const channels = deriveDayChannels(ds.channels || [], new Set(stories.map(storyKey)));

    // Distinct channels/countries come from each story's own breakdown, so a
    // channel that aired three of the day's stories still counts once.
    const chSet = new Set();
    const markets = new Map();
    let airings = 0, airSecs = 0;
    for (const s of stories) {
        airings += s.airings;
        airSecs += s.total_air_secs || 0;
        for (const c of s.all_channels || []) chSet.add(c.channel);
        for (const m of s.all_markets || []) markets.set(m.market, (markets.get(m.market) || 0) + m.airings);
    }
    const summary = {
        ...ds.summary,
        total_airings: airings,
        total_stories: stories.length,
        total_channels: chSet.size,
        total_countries: markets.size,
        total_air_time: secondsToHms(airSecs),
        zero_airing_stories: stories.filter(s => s.airings === 0 && !s.zero_use).length,
        zero_use_stories: stories.filter(s => s.zero_use).length,
    };
    const top_channels = channels.slice(0, 10).map(c => ({
        channel: c.channel, airings: c.airings, air_time: c.total_air_time, country: c.country,
    }));
    const top_markets = [...markets]
        .map(([market, a]) => ({ market, airings: a }))
        .sort((a, b) => b.airings - a.airings)
        .slice(0, 10);
    return { ...ds, summary, stories, channels, top_channels, top_markets };
}

// Rebuild each channel from just its rows for the day's stories. Mirrors the
// backend's per-channel pass: story-origin mix (top 8 + Other), damped
// Gini-Simpson diversity, and significance re-ranked among these channels.
function deriveDayChannels(channels, keys) {
    const out = [];
    for (const c of channels) {
        const rows = (c.all_stories || []).filter(r => keys.has(r.story_id || r.slug));
        if (!rows.length) continue;
        let airings = 0, secs = 0;
        const mix = new Map();
        for (const r of rows) {
            airings += r.airings;
            secs += hmsToSeconds(r.air_time);
            mix.set(r.origin_country, (mix.get(r.origin_country) || 0) + r.airings);
        }
        let simpson = 0;
        for (const v of mix.values()) simpson += (v / airings) ** 2;
        out.push({
            ...c,
            airings,
            stories: rows.length,
            total_air_secs: secs,
            total_air_time: secondsToHms(secs),
            avg_clip_secs: Math.floor(secs / airings),
            avg_clip: secondsToHms(secs / airings),
            all_stories: rows,
            story_country_mix: originMix(rows),
            trend: [],              // per-channel airing times aren't in the payload
            first_seen: '',
            last_seen: '',
            days_active: null,
            _diversity: (1 - simpson) * Math.min(1, airings / SIG_DIVERSITY_MIN_AIRINGS),
        });
    }
    const vol = percentileRanks(out.map(c => c.airings));
    const brd = percentileRanks(out.map(c => c.stories));
    const div = percentileRanks(out.map(c => c._diversity));
    out.forEach((c, i) => {
        c.sig_volume = roundHalfEven(vol[i]);
        c.sig_breadth = roundHalfEven(brd[i]);
        c.sig_diversity = roundHalfEven(div[i]);
        c.significance = roundHalfEven((vol[i] + brd[i] + div[i]) / 3);
        delete c._diversity;
    });
    return out.sort((a, b) => b.airings - a.airings);
}

// Python's round(): halves go to the even neighbour (62.5 → 62), so scores
// match the backend's exactly rather than drifting by 1 on a tie.
function roundHalfEven(x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Story-origin country mix for a channel's story rows, airings-weighted: top 8
// plus Other, as the backend builds story_country_mix.
function originMix(rows) {
    const mix = new Map();
    for (const r of rows) mix.set(r.origin_country, (mix.get(r.origin_country) || 0) + r.airings);
    let sorted = [...mix].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 8) {
        const other = sorted.slice(8).reduce((n, [, v]) => n + v, 0);
        sorted = [...sorted.slice(0, 8), ['Other', other]];
    }
    return sorted.map(([country, airings]) => ({ country, airings }));
}

// Port of backend _percentile_ranks: 0–100, ties share their average rank.
function percentileRanks(values) {
    const n = values.length;
    if (n === 0) return [];
    if (n === 1) return [100];
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const ranks = new Array(n);
    for (let i = 0; i < n;) {
        let j = i;
        while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
        const pctRank = 100 * ((i + j) / 2) / (n - 1);
        for (let k = i; k <= j; k++) ranks[order[k]] = pctRank;
        i = j + 1;
    }
    return ranks;
}

// Port of backend _seconds_to_hms ('45s', '2m 34s', '1h 4m') and its inverse.
function secondsToHms(seconds) {
    const s = Math.floor(seconds);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function hmsToSeconds(str) {
    const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(String(str || '').trim());
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

function baseDataset() {
    return state.excludeUS ? state.datasets.ex_us : state.datasets.full;
}

function renderDayStrip() {
    const strip = $('day-strip');
    const base = baseDataset();
    const days = base ? dayIndex(base) : [];
    strip.hidden = false;
    strip.classList.toggle('no-days', days.filter(d => d.stories > 0).length < 2);
    if (strip.classList.contains('no-days')) return;

    const sel = state.selectedDay;
    const allChip = `
        <button type="button" class="day-chip day-chip-all" role="radio" data-day=""
                aria-checked="${!sel}" tabindex="${sel ? -1 : 0}" title="Every story in this upload">
            <span class="day-chip-dow">All days</span>
            <span class="day-chip-date">${base.stories.length.toLocaleString()} stories</span>
            <span class="day-chip-bar" aria-hidden="true"></span>
        </button>`;
    const dayChips = days.map(d => {
        const on = d.key === sel;
        const [dow, date] = d.key === 'earlier' ? ['Earlier', 'pre-window'] : dayParts(d.key);
        const covered = d.coverage == null ? null : Math.round(d.coverage * 100);
        const tip = [
            dayLongLabel(d.key),
            covered == null ? null : covered === 100 ? 'whole day in this export' : `${covered}% of the day in this export`,
            d.stories
                ? `${d.stories.toLocaleString()} stor${d.stories === 1 ? 'y' : 'ies'} published · ${d.airings.toLocaleString()} airings`
                : 'no stories published',
            d.accumulating && d.stories ? 'some had under 24h on air before the export ended' : null,
        ].filter(Boolean).join(' · ');
        return `
        <button type="button" class="day-chip" role="radio"
                data-day="${d.key}" aria-checked="${on}" tabindex="${on ? 0 : -1}"
                title="${escHtml(tip)}" ${d.stories ? '' : 'disabled'}>
            <span class="day-chip-dow">${dow}</span>
            <span class="day-chip-date">${date}</span>
            ${d.accumulating && d.stories ? '<span class="day-chip-dot" aria-hidden="true"></span>' : ''}
            <span class="day-chip-bar${covered == null ? ' is-empty' : ''}" aria-hidden="true"><span class="day-chip-fill" style="width:${covered || 0}%"></span></span>
        </button>`;
    }).join('');
    $('day-strip-days').innerHTML = allChip + '<span class="day-strip-sep" aria-hidden="true"></span>' + dayChips;

}

function selectDay(day) {
    if (day === state.selectedDay) return;
    state.selectedDay = day;
    setDataFields(dayView(baseDataset(), day));
    state.currentPage = 1;
    state.chCurrentPage = 1;
    setActiveView(state.view);   // re-runs the live tab's search/filter/sort on the new data
    renderDayStrip();
    renderSummaryBar();
    renderInsights();
    // Brief fade on the figures that changed, so the swap reads as one motion.
    ['summary-bar', 'insights-panel', 'stories-table-wrap', 'channels-table-wrap'].forEach(id => {
        const el = $(id);
        el.classList.remove('day-swap');
        void el.offsetWidth;  // restart the animation
        el.classList.add('day-swap');
    });
}

$('day-strip-days').addEventListener('click', e => {
    const chip = e.target.closest('.day-chip');
    if (!chip || chip.disabled) return;
    selectDay(chip.dataset.day || null);
    $('day-strip-days').querySelector('.day-chip[aria-checked="true"]')?.focus();
});

// Radio-group keys: arrows step through the enabled chips, Home/End jump.
$('day-strip-days').addEventListener('keydown', e => {
    const chips = [...$('day-strip-days').querySelectorAll('.day-chip:not([disabled])')];
    const i = chips.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: chips.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    const target = chips[Math.max(0, Math.min(chips.length - 1, next))];
    selectDay(target.dataset.day || null);
    $('day-strip-days').querySelector('.day-chip[aria-checked="true"]')?.focus();
});

// ── Filtering & Search ───────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value.trim().toLowerCase();
    searchClear.style.display = state.searchQuery ? 'block' : 'none';
    if (state.view === 'stories') {
        state.currentPage = 1;
        applyFilters();
    } else {
        state.chCurrentPage = 1;
        applyChannelFilters();
    }
});
searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchClear.style.display = 'none';
    if (state.view === 'stories') {
        state.currentPage = 1;
        applyFilters();
    } else {
        state.chCurrentPage = 1;
        applyChannelFilters();
    }
});

document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
        state.regionFilter = pill.dataset.region;
        setActivePill(pill.dataset.region);
        state.currentPage = 1;
        applyFilters();
    });
});


function setActivePill(region) {
    document.querySelectorAll('.filter-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.region === region);
    });
}

function applyFilters() {
    let filtered = state.allStories;

    if (state.searchQuery) {
        const q = state.searchQuery;
        filtered = filtered.filter(s =>
            displaySlug(s).toLowerCase().includes(q) ||
            (s.headline && s.headline.toLowerCase().includes(q))
        );
    }

    if (state.regionFilter !== 'all') {
        filtered = filtered.filter(s =>
            s.regions && s.regions[state.regionFilter] > 0
        );
    }

    // Sort — nulls always last regardless of direction
    filtered = [...filtered].sort((a, b) => {
        let av = a[state.sortKey], bv = b[state.sortKey];
        const aNull = av == null, bNull = bv == null;
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        if (typeof av === 'string') av = av.toLowerCase();
        if (typeof bv === 'string') bv = bv.toLowerCase();
        if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
        if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
        return 0;
    });

    state.filteredStories = filtered;
    $('results-count').textContent = `${filtered.length.toLocaleString()} stor${filtered.length === 1 ? 'y' : 'ies'}`;
    renderTable();
    renderPagination();
}

// ── Table Rendering ──────────────────────────────────────────────────────────
function renderTable() {
    const start = (state.currentPage - 1) * state.pageSize;
    const page = state.filteredStories.slice(start, start + state.pageSize);

    if (page.length === 0) {
        storiesTbody.innerHTML = `
            <tr><td colspan="9">
                <div class="empty-state">
                    <svg class="empty-state-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="7" cy="7" r="5"/>
                        <path d="M11 11l3 3"/>
                    </svg>
                    <p class="empty-state-text">No stories match your search</p>
                    <p class="empty-state-sub">Try a different keyword or clear your filters</p>
                </div>
            </td></tr>`;
        return;
    }

    storiesTbody.innerHTML = page.map(s => {
        const sparkline = renderSparkline(s.trend, state.trendLabels, state.trendUnit);
        const publishDisplay = s.publish_time ? escHtml(s.publish_time) : '<span class="muted">—</span>';
        return `
        <tr class="story-row${s.zero_use ? ' zero-use-row' : ''}" data-story-id="${escHtml(s.story_id || s.slug)}" tabindex="0">
            <td class="slug-cell">
                <div class="slug-main">${escHtml(displaySlug(s))}</div>
                ${s.headline ? `<div class="slug-headline">${escHtml(s.headline)}</div>` : ''}
            </td>
            <td class="col-num">${s.channels}</td>
            <td class="col-num">${s.countries}</td>
            <td class="col-num">${s.airings.toLocaleString()}</td>
            <td class="col-time">${escHtml(s.total_air_time)}</td>
            <td class="col-trend">${sparkline}</td>
            <td class="col-significance">${reachDisplay(s.reach)}</td>
            <td class="col-longevity">${longevityDisplay(s.longevity)}</td>
            <td class="col-date">${publishDisplay}</td>
        </tr>`;
    }).join('');
}

// ── Sorting ──────────────────────────────────────────────────────────────────
// Story headers have data-sort; channel headers have data-ch-sort. Same shape, different state.
document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
            state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
            state.sortKey = key;
            state.sortDir = 'desc';
        }
        document.querySelectorAll('th[data-sort]').forEach(t => {
            t.classList.remove('sorted');
            t.querySelector('.sort-indicator').textContent = '';
        });
        th.classList.add('sorted');
        th.querySelector('.sort-indicator').textContent = state.sortDir === 'desc' ? '▼' : '▲';
        state.currentPage = 1;
        applyFilters();
    });
});

document.querySelectorAll('th[data-ch-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.chSort;
        if (state.chSortKey === key) {
            state.chSortDir = state.chSortDir === 'desc' ? 'asc' : 'desc';
        } else {
            state.chSortKey = key;
            state.chSortDir = 'desc';
        }
        document.querySelectorAll('th[data-ch-sort]').forEach(t => {
            t.classList.remove('sorted');
            t.querySelector('.sort-indicator').textContent = '';
        });
        th.classList.add('sorted');
        th.querySelector('.sort-indicator').textContent = state.chSortDir === 'desc' ? '▼' : '▲';
        state.chCurrentPage = 1;
        applyChannelFilters();
    });
});

// ── Channel filtering / rendering ────────────────────────────────────────────
function applyChannelFilters() {
    let filtered = state.allChannels;

    if (state.searchQuery) {
        const q = state.searchQuery;
        filtered = filtered.filter(c =>
            (c.channel && c.channel.toLowerCase().includes(q)) ||
            (c.country && c.country.toLowerCase().includes(q))
        );
    }

    filtered = [...filtered].sort((a, b) => {
        let av = a[state.chSortKey], bv = b[state.chSortKey];
        const aNull = av == null, bNull = bv == null;
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        if (typeof av === 'string') av = av.toLowerCase();
        if (typeof bv === 'string') bv = bv.toLowerCase();
        if (av < bv) return state.chSortDir === 'asc' ? -1 : 1;
        if (av > bv) return state.chSortDir === 'asc' ? 1 : -1;
        return 0;
    });

    state.filteredChannels = filtered;
    $('ch-results-count').textContent = `${filtered.length.toLocaleString()} channel${filtered.length === 1 ? '' : 's'}`;
    renderChannelTable();
    renderPagination();
}

function renderChannelTable() {
    const tbody = $('channels-tbody');
    const start = (state.chCurrentPage - 1) * state.pageSize;
    const page = state.filteredChannels.slice(start, start + state.pageSize);
    const maxAirings = state.filteredChannels[0]?.airings || 1;

    if (page.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="7">
                <div class="empty-state">
                    <p class="empty-state-text">No channels match your search</p>
                    <p class="empty-state-sub">Try a different keyword or clear your filters</p>
                </div>
            </td></tr>`;
        return;
    }

    tbody.innerHTML = page.map(c => {
        const barWidth = Math.max(2, Math.round(c.airings / maxAirings * 60));
        const sparkline = renderSparkline(c.trend, state.trendLabels, state.trendUnit);
        return `
        <tr class="channel-row" data-channel="${escHtml(c.channel)}" tabindex="0">
            <td class="col-channel">
                <div class="channel-cell-main">${escHtml(c.channel)}</div>
            </td>
            <td class="col-country channel-cell-country">${escHtml(c.country || '')}</td>
            <td class="col-num">
                <div class="airing-bar-wrap">
                    <div class="airing-bar" style="width:${barWidth}px"></div>
                    <span>${c.airings.toLocaleString()}</span>
                </div>
            </td>
            <td class="col-num">${c.stories.toLocaleString()}</td>
            <td class="col-time">${escHtml(c.total_air_time)}</td>
            <td class="col-trend">${sparkline || '<span class="muted" title="Not available when viewing one publish day">—</span>'}</td>
            <td class="col-significance">${significanceDisplay(c.significance)}</td>
        </tr>`;
    }).join('');
}

// ── Pagination ────────────────────────────────────────────────────────────────
function renderPagination() {
    const isStories = state.view === 'stories';
    const total = isStories ? state.filteredStories.length : state.filteredChannels.length;
    const pages = Math.ceil(total / state.pageSize);
    const page = isStories ? state.currentPage : state.chCurrentPage;
    const bar = $('pagination-bar');

    if (pages <= 1) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';

    $('page-info').textContent = `Page ${page} of ${pages}`;
    $('btn-prev').disabled = page === 1;
    $('btn-next').disabled = page === pages;
}

$('btn-prev').addEventListener('click', () => {
    if (state.view === 'stories') {
        if (state.currentPage > 1) { state.currentPage--; renderTable(); renderPagination(); window.scrollTo(0, 0); }
    } else {
        if (state.chCurrentPage > 1) { state.chCurrentPage--; renderChannelTable(); renderPagination(); window.scrollTo(0, 0); }
    }
});
$('btn-next').addEventListener('click', () => {
    if (state.view === 'stories') {
        const pages = Math.ceil(state.filteredStories.length / state.pageSize);
        if (state.currentPage < pages) { state.currentPage++; renderTable(); renderPagination(); window.scrollTo(0, 0); }
    } else {
        const pages = Math.ceil(state.filteredChannels.length / state.pageSize);
        if (state.chCurrentPage < pages) { state.chCurrentPage++; renderChannelTable(); renderPagination(); window.scrollTo(0, 0); }
    }
});

// ── Trend-bar focus (story + channel windows) ────────────────────────────────
// Clicking a bar in a window's trend chart narrows that window to the airings
// inside the bar. Uses the per-bin breakdown the backend attaches to each
// story's channel and country rows: `bins: [[bin, airings, secs], ...]`.

// Bar label: 'Tue 14 Oct' / '14:00–15:00 UTC'; `inSentence` adds the
// preposition for running text ('on Tue 14 Oct' / 'at 14:00–15:00 UTC').
function trendBinLabel(bin, inSentence = false) {
    const start = parseRangeStamp(state.dateRange?.from);
    if (start == null) return state.trendLabels?.[bin] || '';
    if (state.trendUnit === 'hour') {
        const from = new Date(Math.floor(start / 3600000) * 3600000 + bin * 3600000);
        const hh = d => String(d.getUTCHours()).padStart(2, '0') + ':00';
        const label = `${hh(from)}–${hh(new Date(from.getTime() + 3600000))} UTC`;
        return inSentence ? `at ${label}` : label;
    }
    const [dow, date] = dayParts(msToYmd(Math.floor(start / DAY_MS) * DAY_MS + bin * DAY_MS));
    return inSentence ? `on ${dow} ${date}` : `${dow} ${date}`;
}

function trendFocusTag(bin) {
    if (bin == null) return '';
    return `
        <div class="trend-focus">
            <span>Showing airings ${state.trendUnit === 'hour' ? 'at' : 'on'} <strong>${escHtml(trendBinLabel(bin))}</strong></span>
            <button type="button" class="trend-focus-clear" data-trend-clear>All ${state.trendUnit === 'hour' ? 'hours' : 'days'} <span aria-hidden="true">✕</span></button>
        </div>`;
}

// What a click inside a window means for its focused bar: undefined = not a
// trend click; null = clear; a number = focus that bar (clicking the focused
// bar again clears it).
function trendBinFromEvent(e, current) {
    if (e.target.closest('[data-trend-clear]')) return null;
    const slot = e.target.closest('.trend-slot[data-bin]');
    if (!slot) return undefined;
    const bin = Number(slot.dataset.bin);
    return bin === current ? null : bin;
}

// Story figures for one bar: the channels and countries that aired it then.
function storyBinView(s, bin) {
    const chans = [];
    let airings = 0, secs = 0;
    for (const c of s.all_channels || []) {
        const hit = (c.bins || []).find(x => x[0] === bin);
        if (!hit) continue;
        chans.push({ channel: c.channel, country: c.country, airings: hit[1], air_time: secondsToHms(hit[2]) });
        airings += hit[1];
        secs += hit[2];
    }
    const markets = (s.all_markets || [])
        .map(m => ({ market: m.market, airings: ((m.bins || []).find(x => x[0] === bin) || [0, 0])[1] }))
        .filter(m => m.airings > 0);
    const byAirings = (a, b) => b.airings - a.airings;
    return {
        airings,
        channels: chans.length,
        countries: markets.length,
        total_air_time: secondsToHms(secs),
        avg_clip: airings ? secondsToHms(secs / airings) : '0s',
        all_channels: chans.sort(byAirings),
        all_markets: markets.sort(byAirings),
    };
}

// A channel's story rows for one bar, read off each story's own breakdown for
// this channel. Index of the live stories is cached per dataset array.
const storyIndexCache = new WeakMap();
function storyByKey(key) {
    let idx = storyIndexCache.get(state.allStories);
    if (!idx) {
        idx = new Map(state.allStories.map(s => [storyKey(s), s]));
        storyIndexCache.set(state.allStories, idx);
    }
    return idx.get(key);
}
function channelBinRows(c, bin) {
    const rows = [];
    for (const r of c.all_stories || []) {
        const story = storyByKey(r.story_id || r.slug);
        const ch = story?.all_channels?.find(x => x.channel === c.channel);
        const hit = (ch?.bins || []).find(x => x[0] === bin);
        if (!hit) continue;
        rows.push({ ...r, airings: hit[1], air_secs: hit[2], air_time: secondsToHms(hit[2]) });
    }
    return rows.sort((a, b) => b.airings - a.airings);
}

// Enter/Space on a focused bar acts like a click (SVG <g> has no .click()).
[modalBody, $('ch-modal-body')].forEach(el => el.addEventListener('keydown', e => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.closest?.('.trend-slot')) return;
    e.preventDefault();
    e.target.closest('.trend-slot').dispatchEvent(new MouseEvent('click', { bubbles: true }));
}));

// ── Story Detail Modal ────────────────────────────────────────────────────────
function openStoryModal(id) {
    // Identity is Story ID (slugs repeat across editions). Fall back to slug match
    // for the rare blank-ID row, whose data-story-id carries the slug instead.
    const story = state.allStories.find(s => s.story_id === id) ||
                  state.allStories.find(s => s.slug === id);
    if (!story) return;

    modalSlug.textContent = displaySlug(story);
    modalHeadline.textContent = story.headline || '';
    modalFirstAired.textContent = story.first_seen || '';
    modalAssetLength.textContent = story.asset_secs > 0 ? story.asset_length : '';
    storyModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    state.modalStory = story;
    state.modalBin = null;
    renderModalBody(story);
}

function renderModalBody(s) {
    const bin = state.modalBin;
    // v = the figures on show: the whole period, or just the focused trend bar.
    // Reach, longevity and "On this day" always describe the whole story.
    const v = bin == null ? s : storyBinView(s, bin);
    const trendChart = renderTrendChart(s.trend, state.trendLabels, state.trendUnit, { clickable: true, selected: bin });
    const periodTip = bin == null ? '' : ' title="Whole period — not affected by the selected bar"';

    // Mini-panel: top channel, top country, avg clip
    const topCh = v.all_channels?.[0];
    const topCtry = v.all_markets?.[0];
    const miniPanel = `
        <ul class="modal-mini-panel">
            ${topCh ? `<li><span class="mini-label">Most aired on</span><span class="mini-value">${escHtml(topCh.channel)} <span class="mini-sub">(${topCh.airings.toLocaleString()} airings)</span></span></li>` : ''}
            ${topCtry ? `<li><span class="mini-label">Most aired in</span><span class="mini-value">${escHtml(topCtry.market)} <span class="mini-sub">(${topCtry.airings.toLocaleString()} airings)</span></span></li>` : ''}
            <li><span class="mini-label">Avg clip used</span><span class="mini-value">${escHtml(v.avg_clip)}</span></li>
        </ul>
    `;

    const dayContextSection = renderDayContext(s);

    modalBody.innerHTML = `
        <!-- 1. Headline stats + trend chart (side-by-side) -->
        <div class="modal-section">
            <div class="modal-overview">
                <div class="modal-overview-stats">
                    <div class="stats-grid stats-grid-compact${bin == null ? '' : ' is-focused'}">
                        <div class="stat-card">
                            <span class="stat-card-value">${v.airings.toLocaleString()}</span>
                            <span class="stat-card-label">Airings</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${v.channels}</span>
                            <span class="stat-card-label">Channels</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${v.countries}</span>
                            <span class="stat-card-label">Countries</span>
                        </div>
                        <div class="stat-card is-period"${periodTip}>
                            <span class="stat-card-value">${reachDisplay(s.reach, true)}</span>
                            <span class="stat-card-label">Reach</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${escHtml(v.total_air_time)}</span>
                            <span class="stat-card-label">Total air time</span>
                        </div>
                        <div class="stat-card is-period"${periodTip}>
                            <span class="stat-card-value">${longevityDisplay(s.longevity, true)}</span>
                            <span class="stat-card-label">Longevity</span>
                        </div>
                    </div>
                </div>
                ${trendChart ? `
                <div class="modal-overview-chart">
                    ${trendFocusTag(bin)}
                    <div class="trend-chart-wrap">${trendChart}</div>
                    ${miniPanel}
                </div>` : `
                <div class="modal-overview-chart">${miniPanel}</div>`}
            </div>
        </div>

        ${dayContextSection}

        <!-- 3. Channel Breakdown (paginated) -->
        <div class="modal-section">
            <div class="modal-table-wrap">
                <table class="modal-table">
                    <thead><tr><th>Channel</th><th>Country</th><th>Airings</th><th>Air Time</th></tr></thead>
                    <tbody id="modal-channel-tbody"></tbody>
                </table>
            </div>
            <div class="modal-pagination" id="modal-channel-pagination"></div>
        </div>
    `;

    // Wire the paginated channel table
    state.modalChannels = v.all_channels;
    state.modalChannelPage = 1;
    renderModalChannelPage();
}

// "On this day" panel: stacked horizontal bar of the top slug families
// published the same UTC day as this story, so producers can see at a
// glance whether the story landed in a quiet news day or one dominated
// by a big editorial event (e.g. IRAN-CRISIS). The current story's
// family is outlined in Racing Green wherever it sits in the bar.
// Family names appear on hover via the title attribute — kept minimal
// to mirror the channel-modal aesthetic.
function renderDayContext(s) {
    if (!s.publish_day) return '';
    const day = state.dayContext?.[s.publish_day];
    if (!day || !day.top_families?.length) return '';
    const total = day.total_airings || 0;
    if (total === 0) return '';

    const dateLabel = formatDayLabel(s.publish_day);

    if (day.family_count === 1) {
        return `
            <div class="modal-section modal-day-context">
                <div class="day-context-caption">On this day · ${escHtml(dateLabel)}</div>
                <div class="day-context-empty">Only Reuters story published this day.</div>
            </div>
        `;
    }

    const top = day.top_families;
    const topSum = top.reduce((a, f) => a + (f.airings || 0), 0);
    const inTop = top.some(f => f.family === s.family);

    const segments = top.map((f, i) => ({
        family: f.family,
        pct: 100 * f.airings / total,
        rankClass: `rank-${i + 1}`,
        isCurrent: f.family === s.family,
        isOther: false,
    }));

    const otherAirings = Math.max(0, total - topSum);
    if (otherAirings > 0) {
        const remaining = day.family_count - top.length;
        // When this story's family is outside the top 5, mark Other as
        // current — the story lives inside that bucket, so highlighting
        // Other is a truthful "you're somewhere in here" signal and
        // avoids the unreadable hairline-sliver problem we'd get from
        // peeling out s.airings into its own segment.
        const otherIsCurrent = !inTop && Boolean(s.family);
        segments.push({
            family: remaining > 0 ? `Other (${remaining} ${remaining === 1 ? 'family' : 'families'})` : 'Other',
            pct: 100 * otherAirings / total,
            rankClass: 'is-other',
            isCurrent: otherIsCurrent,
            isOther: true,
        });
    }

    const bar = segments.map(seg => {
        const showLabel = seg.pct >= 8;
        const cls = [
            'day-stack-seg',
            seg.rankClass,
            seg.isCurrent ? 'is-current' : '',
        ].filter(Boolean).join(' ');
        const label = familyLabel(seg.family, seg.isOther);
        const tip = seg.isCurrent
            ? `${label} · ${seg.pct.toFixed(1)}% (this story)`
            : `${label} · ${seg.pct.toFixed(1)}%`;
        return `<div class="${cls}" style="flex-grow: ${seg.pct.toFixed(3)};" title="${escHtml(tip)}">${showLabel ? `<span class="seg-pct">${Math.round(seg.pct)}%</span>` : ''}</div>`;
    }).join('');

    return `
        <div class="modal-section modal-day-context">
            <div class="day-context-caption">On this day · ${escHtml(dateLabel)}</div>
            <div class="day-stack-bar" role="img" aria-label="Family share of airings on ${escHtml(dateLabel)}">${bar}</div>
        </div>
    `;
}

// Slug families in Reuters' master slug format end with a trailing '/'
// (IRAN-CRISIS/ , USA-SCREWWORM/). The backend stores the stem alone for
// grouping; this appends the '/' purely for display, and leaves the
// synthetic "Other" buckets untouched.
function familyLabel(family, isOther) {
    if (isOther || !family) return family || '';
    return family.endsWith('/') ? family : `${family}/`;
}

function formatDayLabel(ymd) {
    // ymd: 'YYYY-MM-DD' (UTC). Render as '13 Jun 2026' without timezone shifting.
    const parts = String(ymd).split('-');
    if (parts.length !== 3) return ymd;
    const [y, m, d] = parts.map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ymd;
    return `${d} ${months[m - 1] || ''} ${y}`.trim();
}

const MODAL_PAGE_SIZE = 10;

function renderModalChannelPage() {
    const all = state.modalChannels || [];
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / MODAL_PAGE_SIZE));
    const page = Math.min(state.modalChannelPage || 1, pages);
    const start = (page - 1) * MODAL_PAGE_SIZE;
    const slice = all.slice(start, start + MODAL_PAGE_SIZE);

    document.getElementById('modal-channel-tbody').innerHTML = slice.map(c => `
        <tr>
            <td>${escHtml(c.channel || '')}</td>
            <td>${escHtml(c.country || '')}</td>
            <td class="num">${c.airings}</td>
            <td class="num">${escHtml(c.air_time)}</td>
        </tr>`).join('');

    renderModalPagination('modal-channel-pagination', 'channel', page, pages, start, total, 'channels');
}

function renderModalPagination(elId, kind, page, pages, start, total, noun) {
    const pag = document.getElementById(elId);
    if (pages <= 1) { pag.innerHTML = ''; return; }
    const from = start + 1;
    const to = Math.min(start + MODAL_PAGE_SIZE, total);
    pag.innerHTML = `
        <button class="btn btn-outline btn-sm" data-page-kind="${kind}" data-page-action="prev" ${page === 1 ? 'disabled' : ''}>← Previous</button>
        <span class="page-info">Showing ${from}–${to} of ${total} ${noun} · Page ${page} of ${pages}</span>
        <button class="btn btn-outline btn-sm" data-page-kind="${kind}" data-page-action="next" ${page === pages ? 'disabled' : ''}>Next →</button>
    `;
}

// Open modal via delegated listeners (avoids inline onclick, which CSP blocks)
$('stories-tbody').addEventListener('click', e => {
    const row = e.target.closest('tr[data-story-id]');
    if (!row) return;
    // Don't open the modal if the user was selecting text inside the row
    if (window.getSelection().toString().length > 0) return;
    openStoryModal(row.dataset.storyId);
});
$('stories-tbody').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('tr[data-story-id]');
    if (row) openStoryModal(row.dataset.storyId);
});
$('top-stories-list').addEventListener('click', e => {
    const item = e.target.closest('[data-story-id]');
    if (item) openStoryModal(item.dataset.storyId);
});
$('top-channels-list').addEventListener('click', e => {
    const item = e.target.closest('[data-channel]');
    if (item) openChannelModal(item.dataset.channel);
});

$('channels-tbody').addEventListener('click', e => {
    const row = e.target.closest('tr[data-channel]');
    if (!row) return;
    if (window.getSelection().toString().length > 0) return;
    openChannelModal(row.dataset.channel);
});
$('channels-tbody').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('tr[data-channel]');
    if (row) openChannelModal(row.dataset.channel);
});

// Trend bars + modal table pagination — delegated so they survive re-renders
modalBody.addEventListener('click', e => {
    const bin = trendBinFromEvent(e, state.modalBin);
    if (bin !== undefined) {
        state.modalBin = bin;
        renderModalBody(state.modalStory);
        modalBody.querySelector('.trend-slot.is-selected')?.focus();
        return;
    }
    const btn = e.target.closest('[data-page-action]');
    if (!btn) return;
    if (btn.dataset.pageKind !== 'channel') return;
    const total = (state.modalChannels || []).length;
    const pages = Math.max(1, Math.ceil(total / MODAL_PAGE_SIZE));
    if (btn.dataset.pageAction === 'next' && state.modalChannelPage < pages) state.modalChannelPage++;
    if (btn.dataset.pageAction === 'prev' && state.modalChannelPage > 1) state.modalChannelPage--;
    renderModalChannelPage();
});

// Close modal
$('modal-close').addEventListener('click', closeModal);
storyModal.addEventListener('click', e => { if (e.target === storyModal) closeModal(); });
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeModal();
    closeChannelModal();
});

function closeModal() {
    storyModal.style.display = 'none';
    if ($('channel-modal').style.display === 'none') document.body.style.overflow = '';
}

// ── Channel Detail Modal ──────────────────────────────────────────────────────
const channelModal = $('channel-modal');
const chModalName = $('ch-modal-name');
const chModalCountry = $('ch-modal-country');
const chModalSummary = $('ch-modal-summary');
const chModalBody = $('ch-modal-body');

function openChannelModal(channelName) {
    const c = state.allChannels.find(x => x.channel === channelName);
    if (!c) return;
    chModalName.textContent = c.channel;
    chModalCountry.textContent = c.country || '';
    // Each modal open starts with a clean slate — no filter leakage between channels
    state.chModalChannel = c;
    state.chModalBin = null;
    state.chModalRegion = 'all';
    state.chModalCountry = null;
    state.chModalStoryPage = 1;
    channelModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    renderChannelModalBody(c);
}

function closeChannelModal() {
    channelModal.style.display = 'none';
    if (storyModal.style.display === 'none') document.body.style.overflow = '';
}

$('ch-modal-close').addEventListener('click', closeChannelModal);
channelModal.addEventListener('click', e => { if (e.target === channelModal) closeChannelModal(); });

// Cap the rows rendered into a PNG export. Top stories aired on 1,000+
// channels (and big channels air 100s of stories); a fully-expanded table
// produces a canvas taller than the browser's ~65,535px ceiling, which makes
// html2canvas/toDataURL silently return a BLANK image. 100 rows keeps the
// export well under the limit and shareable, and the note below tells the
// reader what was trimmed so nothing is dropped silently.
const EXPORT_ROW_CAP = 100;

// Returns a single full-width <tr> note row when the export was capped, else ''.
function exportCapNoteRow(shown, total, noun, cols) {
    if (total <= shown) return '';
    return `<tr class="export-cap-note"><td colspan="${cols}">Showing top ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun} — full list available in the app and the Excel export.</td></tr>`;
}

// ── Channel modal: download view as PNG ────────────────────────────────────
// Expands the paginated story list to render every filtered row (capped at
// EXPORT_ROW_CAP), hides the download/close controls (they don't belong in
// the export), captures the whole modal at 2x scale via html2canvas, then
// restores the previous DOM state. Filename includes channel + active filters
// so two downloads from the same channel don't collide.
$('ch-modal-download').addEventListener('click', async () => {
    if (typeof html2canvas === 'undefined') {
        showToast('Image library still loading — try again in a moment.');
        return;
    }
    const modal = channelModal.querySelector('.modal');
    if (!modal) return;

    const downloadBtn = $('ch-modal-download');
    const closeBtn = $('ch-modal-close');
    const footer = modal.querySelector('.modal-footer');
    const tbody = document.getElementById('ch-modal-story-tbody');
    const pagination = document.getElementById('ch-modal-story-pagination');
    const body = modal.querySelector('.modal-body');

    // Snapshot mutable bits before we touch them
    const stash = {
        tbodyHTML: tbody ? tbody.innerHTML : '',
        paginationHTML: pagination ? pagination.innerHTML : '',
        bodyMaxHeight: body ? body.style.maxHeight : '',
        bodyOverflow: body ? body.style.overflowY : '',
        modalMaxHeight: modal.style.maxHeight,
        modalOverflow: modal.style.overflow,
        footerDisplay: footer ? footer.style.display : '',
        closeDisplay: closeBtn ? closeBtn.style.display : '',
    };

    downloadBtn.disabled = true;
    downloadBtn.classList.add('is-loading');
    showToast('Preparing image…');

    try {
        // 1. Expand the story list to the filtered rows, capped at EXPORT_ROW_CAP
        //    (the breakdown is sorted airings-desc, so the cap keeps the top N).
        if (tbody) {
            const all = state.chModalStories || [];
            const shown = all.slice(0, EXPORT_ROW_CAP);
            tbody.innerHTML = (shown.map(s => `
                <tr>
                    <td>
                        <div class="slug-main">${escHtml(displaySlug(s))}</div>
                        ${s.headline ? `<div class="slug-headline">${escHtml(s.headline)}</div>` : ''}
                    </td>
                    <td class="num">${s.airings}</td>
                    <td class="num">${escHtml(s.air_time)}</td>
                </tr>`).join('') + exportCapNoteRow(shown.length, all.length, 'stories', 3)) || stash.tbodyHTML;
        }
        if (pagination) pagination.innerHTML = '';

        // 2. Let the modal grow to its natural height so the whole thing renders
        //    in one shot (no internal scroll cut-off).
        if (body) { body.style.maxHeight = 'none'; body.style.overflowY = 'visible'; }
        modal.style.maxHeight = 'none';
        modal.style.overflow = 'visible';

        // 3. Hide the chrome we don't want in the export.
        if (footer) footer.style.display = 'none';
        if (closeBtn) closeBtn.style.display = 'none';

        // 4. Force a layout pass so html2canvas sees the new heights.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const canvas = await html2canvas(modal, {
            scale: 2,
            backgroundColor: '#ffffff',
            useCORS: true,
            logging: false,
            // Match the on-screen size; the scale factor handles retina sharpness.
            windowWidth: document.documentElement.clientWidth,
        });

        const dataUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `${slugifyForFilename(chModalName.textContent)}${filterSuffix()}.png`;
        a.click();
        showToast('Image downloaded.');
    } catch (err) {
        console.error('Download failed:', err);
        showToast('Sorry — image export failed. Try again?');
    } finally {
        // Restore everything we changed
        if (tbody) tbody.innerHTML = stash.tbodyHTML;
        if (pagination) pagination.innerHTML = stash.paginationHTML;
        if (body) {
            body.style.maxHeight = stash.bodyMaxHeight;
            body.style.overflowY = stash.bodyOverflow;
        }
        modal.style.maxHeight = stash.modalMaxHeight;
        modal.style.overflow = stash.modalOverflow;
        if (footer) footer.style.display = stash.footerDisplay;
        if (closeBtn) closeBtn.style.display = stash.closeDisplay;
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('is-loading');
    }
});

// ── Story modal: download view as PNG ──────────────────────────────────────
// Same approach as the channel-modal download: expand the paginated channel
// breakdown to every row, hide the download/close chrome, capture the whole
// modal at 2x, then restore. Filename is the story slug.
$('story-modal-download').addEventListener('click', async () => {
    if (typeof html2canvas === 'undefined') {
        showToast('Image library still loading — try again in a moment.');
        return;
    }
    const modal = storyModal.querySelector('.modal');
    if (!modal) return;

    const downloadBtn = $('story-modal-download');
    const closeBtn = $('modal-close');
    const footer = modal.querySelector('.modal-footer');
    const tbody = document.getElementById('modal-channel-tbody');
    const pagination = document.getElementById('modal-channel-pagination');
    const body = modal.querySelector('.modal-body');

    const stash = {
        tbodyHTML: tbody ? tbody.innerHTML : '',
        paginationHTML: pagination ? pagination.innerHTML : '',
        bodyMaxHeight: body ? body.style.maxHeight : '',
        bodyOverflow: body ? body.style.overflowY : '',
        modalMaxHeight: modal.style.maxHeight,
        modalOverflow: modal.style.overflow,
        footerDisplay: footer ? footer.style.display : '',
        closeDisplay: closeBtn ? closeBtn.style.display : '',
    };

    downloadBtn.disabled = true;
    downloadBtn.classList.add('is-loading');
    showToast('Preparing image…');

    try {
        // 1. Expand the channel breakdown, capped at EXPORT_ROW_CAP (sorted
        //    airings-desc, so the cap keeps the top N).
        if (tbody) {
            const all = state.modalChannels || [];
            const shown = all.slice(0, EXPORT_ROW_CAP);
            tbody.innerHTML = (shown.map(c => `
                <tr>
                    <td>${escHtml(c.channel || '')}</td>
                    <td>${escHtml(c.country || '')}</td>
                    <td class="num">${c.airings}</td>
                    <td class="num">${escHtml(c.air_time)}</td>
                </tr>`).join('') + exportCapNoteRow(shown.length, all.length, 'channels', 4)) || stash.tbodyHTML;
        }
        if (pagination) pagination.innerHTML = '';

        // 2. Let the modal grow to its natural height for a single capture.
        if (body) { body.style.maxHeight = 'none'; body.style.overflowY = 'visible'; }
        modal.style.maxHeight = 'none';
        modal.style.overflow = 'visible';

        // 3. Hide the chrome we don't want in the export.
        if (footer) footer.style.display = 'none';
        if (closeBtn) closeBtn.style.display = 'none';

        // 4. Force a layout pass so html2canvas sees the new heights.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const canvas = await html2canvas(modal, {
            scale: 2,
            backgroundColor: '#ffffff',
            useCORS: true,
            logging: false,
            windowWidth: document.documentElement.clientWidth,
        });

        const dataUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataUrl;
        const binPart = state.modalBin == null ? '' : `-${slugifyForFilename(trendBinLabel(state.modalBin))}`;
        a.download = `${slugifyForFilename(modalSlug.textContent)}${binPart}.png`;
        a.click();
        showToast('Image downloaded.');
    } catch (err) {
        console.error('Download failed:', err);
        showToast('Sorry — image export failed. Try again?');
    } finally {
        if (tbody) tbody.innerHTML = stash.tbodyHTML;
        if (pagination) pagination.innerHTML = stash.paginationHTML;
        if (body) {
            body.style.maxHeight = stash.bodyMaxHeight;
            body.style.overflowY = stash.bodyOverflow;
        }
        modal.style.maxHeight = stash.modalMaxHeight;
        modal.style.overflow = stash.modalOverflow;
        if (footer) footer.style.display = stash.footerDisplay;
        if (closeBtn) closeBtn.style.display = stash.closeDisplay;
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('is-loading');
    }
});

function slugifyForFilename(s) {
    return (s || 'channel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'channel';
}

function filterSuffix() {
    const parts = [];
    if (state.chModalRegion && state.chModalRegion !== 'all') {
        parts.push(slugifyForFilename(state.chModalRegion));
    }
    if (state.chModalCountry) parts.push(slugifyForFilename(state.chModalCountry));
    if (state.chModalBin != null) parts.push(slugifyForFilename(trendBinLabel(state.chModalBin)));
    return parts.length ? '-' + parts.join('-') : '';
}

// Significance strip: one slim full-width band above the charts — the score on
// the left, then the three sub-scores as side-by-side mini-gauges, so a producer
// can see *why* a channel ranks where it does (e.g. high volume but narrow
// geography) without the panel overtaking the pie/trend charts below. All values
// are server-cast ints 0–100 — safe in innerHTML.
function renderSignificanceStrip(c) {
    if (c.significance == null) return '';
    const subs = [
        ['Volume', c.sig_volume, 'How many airings, vs other channels'],
        ['Breadth', c.sig_breadth, 'How many distinct stories, vs other channels'],
        ['Diversity', c.sig_diversity, 'How geographically spread the stories are'],
    ];
    const gauges = subs.map(([label, v, tip]) => `
        <div class="sig-gauge" title="${tip}">
            <span class="sig-gauge-label">${label}</span>
            <span class="sig-gauge-track"><span class="sig-gauge-fill" style="width:${v == null ? 0 : v}%"></span></span>
            <span class="sig-gauge-val">${v == null ? '—' : v}</span>
        </div>`).join('');
    return `
        <div class="modal-section sig-strip">
            <div class="sig-strip-head">
                ${significanceDisplay(c.significance, true)}
                <span class="sig-strip-label">Significance<small>ranked within ${state.selectedDay ? 'this publish day' : 'this upload'}</small></span>
            </div>
            <div class="sig-gauges">${gauges}</div>
        </div>`;
}

// Header line beside the country label. innerHTML is safe here: all
// interpolated values are server-cast ints, hms strings or our own labels.
function renderChannelSummary(c, rows) {
    const bin = state.chModalBin;
    let airings = c.airings, stories = c.stories, airTime = c.total_air_time, span;
    if (bin != null) {
        airings = rows.reduce((n, r) => n + r.airings, 0);
        stories = rows.length;
        airTime = secondsToHms(rows.reduce((n, r) => n + r.air_secs, 0));
        span = escHtml(trendBinLabel(bin, true));
    } else if (state.selectedDay) {
        span = `published ${escHtml(dayLongLabel(state.selectedDay))}`;
    } else {
        span = `over <strong>${c.days_active}</strong> ${c.days_active === 1 ? 'day' : 'days'}`;
    }
    chModalSummary.innerHTML = `
        <strong>${airings.toLocaleString()}</strong> airings of
        <strong>${stories.toLocaleString()}</strong> stories ${span}
        (<strong>${escHtml(airTime)}</strong> total air time)
    `;
}

function renderChannelModalBody(c) {
    const bin = state.chModalBin;
    // Story rows on show: the whole period, or just the focused trend bar's airings.
    const rows = bin == null ? (c.all_stories || []) : channelBinRows(c, bin);
    const mix = bin == null ? c.story_country_mix : originMix(rows);
    if (state.chModalCountry && !mix.some(m => m.country === state.chModalCountry)) state.chModalCountry = null;
    renderChannelSummary(c, rows);
    const trendChart = renderTrendChart(c.trend, state.trendLabels, state.trendUnit, { clickable: true, selected: bin });
    const pie = renderCountryPie(mix);

    chModalBody.innerHTML = `
        ${renderSignificanceStrip(c)}
        <div class="modal-section">
            <div class="modal-overview">
                <div class="modal-overview-stats">
                    ${pie || '<p class="pie-empty">No country data available.</p>'}
                </div>
                ${trendChart ? `
                <div class="modal-overview-chart">
                    ${trendFocusTag(bin)}
                    <div class="trend-chart-wrap">${trendChart}</div>
                </div>` : state.selectedDay ? `
                <div class="modal-overview-chart">
                    <p class="trend-na">Airings over time aren't broken down per channel for a single publish day. Switch to <strong>All days</strong> to see this channel's trend.</p>
                </div>` : ''}
            </div>
        </div>

        <div class="modal-section">
            <div class="ch-modal-filter-row">
                <span class="filter-label">Region:</span>
                <div class="filter-pills ch-modal-region-pills">
                    <button class="filter-pill active" data-ch-region="all">All</button>
                    <button class="filter-pill" data-ch-region="Europe">Europe</button>
                    <button class="filter-pill" data-ch-region="Americas">Americas</button>
                    <button class="filter-pill" data-ch-region="Asia Pacific">Asia Pacific</button>
                    <button class="filter-pill" data-ch-region="Middle East">Middle East</button>
                    <button class="filter-pill" data-ch-region="Africa">Africa</button>
                </div>
                <span class="results-count" id="ch-modal-story-count"></span>
            </div>
            <div class="modal-table-wrap">
                <table class="modal-table">
                    <thead><tr><th>Story</th><th>Airings</th><th>Air Time</th></tr></thead>
                    <tbody id="ch-modal-story-tbody"></tbody>
                </table>
            </div>
            <div class="modal-pagination" id="ch-modal-story-pagination"></div>
        </div>
    `;

    const sig = chModalBody.querySelector('.sig-strip');
    if (sig && bin != null) {
        sig.classList.add('is-period');
        sig.title = 'Whole period — not affected by the selected bar';
    }
    state.chModalAllStories = rows;
    applyChannelModalFilters();
}

// Slug-origin palette tuned to the Reuters brand: orange anchor, racing-green,
// then editorial supporting tones. "Other" always renders muted grey at the end.
const PIE_PALETTE = [
    '#D64000',  // TR orange
    '#123015',  // Racing green
    '#0874E3',  // Dark sky
    '#E9B045',  // Dark gold
    '#7A1C1C',  // Deep red
    '#3F7F44',  // Mid green
    '#D4792A',  // Dark amber
    '#5A4A99',  // Muted purple
];
const PIE_OTHER = '#9aa2a8';

function renderCountryPie(mix) {
    if (!mix || mix.length === 0) return '';
    const total = mix.reduce((s, m) => s + m.airings, 0);
    if (total === 0) return '';

    const r = 78, cx = 90, cy = 90;
    let acc = 0;
    const slices = mix.map((m, i) => {
        const frac = m.airings / total;
        const start = acc;
        const end = acc + frac;
        acc = end;
        // Single-slice case: render a full circle instead of a degenerate arc.
        if (frac >= 0.9999) {
            return { path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z`, ...m, frac, color: colorFor(m, i, mix.length) };
        }
        const a0 = start * 2 * Math.PI - Math.PI / 2;
        const a1 = end * 2 * Math.PI - Math.PI / 2;
        const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
        const large = frac > 0.5 ? 1 : 0;
        return {
            path: `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
            ...m,
            frac,
            color: colorFor(m, i, mix.length),
        };
    });

    // "Other" is an aggregate bucket, not a single rubric — don't make it a filter target.
    const paths = slices.map(s => {
        const clickable = s.country && s.country !== 'Other';
        const dataAttr = clickable ? ` data-country="${escHtml(s.country)}"` : '';
        return `
        <path d="${s.path}" fill="${s.color}" stroke="#fff" stroke-width="1.5"${dataAttr}>
            <title>${escHtml(s.country)}: ${s.airings.toLocaleString()} airings (${Math.round(s.frac * 100)}%)${clickable ? ' — click to filter' : ''}</title>
        </path>`;
    }).join('');

    const legend = slices.map(s => {
        const clickable = s.country && s.country !== 'Other';
        const dataAttr = clickable ? ` data-country="${escHtml(s.country)}"` : '';
        return `
        <li${dataAttr}>
            <span class="pie-swatch" style="background:${s.color}"></span>
            <span class="pie-country">${escHtml(s.country)}</span>
            <span class="pie-pct">${Math.round(s.frac * 100)}%</span>
        </li>`;
    }).join('');

    return `
        <div class="pie-wrap">
            <svg class="pie-chart" viewBox="0 0 180 180" aria-label="Story origin countries by airings">
                ${paths}
            </svg>
            <ul class="pie-legend">${legend}</ul>
        </div>
    `;
}

function colorFor(m, i, total) {
    if (m.country === 'Other') return PIE_OTHER;
    return PIE_PALETTE[i % PIE_PALETTE.length];
}

// Filters compose: region (slug → set of regions) AND country (slug → first rubric
// token). Both pulled from precomputed fields on each story row so pie labels
// and filter buckets stay in lockstep.
function applyChannelModalFilters() {
    const all = state.chModalAllStories || [];
    const region = state.chModalRegion || 'all';
    const country = state.chModalCountry;
    let filtered = all;
    if (region !== 'all') {
        filtered = filtered.filter(s => Array.isArray(s.regions) && s.regions.includes(region));
    }
    if (country) {
        filtered = filtered.filter(s => s.origin_country === country);
    }
    state.chModalStories = filtered;
    state.chModalStoryPage = 1;

    // Reflect region selection on the pills (active class) and country selection
    // on both the pie slice and its legend row.
    document.querySelectorAll('.ch-modal-region-pills .filter-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.chRegion === region);
    });
    document.querySelectorAll('.pie-chart path[data-country]').forEach(p => {
        p.classList.toggle('pie-slice-selected', country != null && p.dataset.country === country);
    });
    document.querySelectorAll('.pie-legend li[data-country]').forEach(li => {
        li.classList.toggle('pie-legend-selected', country != null && li.dataset.country === country);
    });
    // Whole-pie dim toggle: when a country is selected, hold the same "rest of
    // chart fades" look that exists on :hover so the selection itself is the
    // filter indicator. Click the slice again (or change region) to clear.
    document.querySelectorAll('.pie-chart').forEach(svg => {
        svg.classList.toggle('pie-has-selection', country != null);
    });

    renderChannelModalStoryPage();
}

function renderChannelModalStoryPage() {
    const all = state.chModalStories || [];
    const total = all.length;
    const totalUnfiltered = (state.chModalAllStories || []).length;
    const pages = Math.max(1, Math.ceil(total / MODAL_PAGE_SIZE));
    const page = Math.min(state.chModalStoryPage || 1, pages);
    const start = (page - 1) * MODAL_PAGE_SIZE;
    const slice = all.slice(start, start + MODAL_PAGE_SIZE);

    const countEl = document.getElementById('ch-modal-story-count');
    if (countEl) {
        const noun = total === 1 ? 'story' : 'stories';
        countEl.textContent = total === totalUnfiltered
            ? `${total.toLocaleString()} ${noun}`
            : `${total.toLocaleString()} of ${totalUnfiltered.toLocaleString()} ${noun}`;
    }

    const tbody = document.getElementById('ch-modal-story-tbody');
    if (total === 0) {
        tbody.innerHTML = `
            <tr><td colspan="3">
                <div class="ch-modal-empty">No stories match this filter — try a different region or clear the filter.</div>
            </td></tr>`;
        renderModalPagination('ch-modal-story-pagination', 'ch-story', 1, 1, 0, 0, 'stories');
        return;
    }

    tbody.innerHTML = slice.map(s => `
        <tr>
            <td>
                <div class="slug-main">${escHtml(displaySlug(s))}</div>
                ${s.headline ? `<div class="slug-headline">${escHtml(s.headline)}</div>` : ''}
            </td>
            <td class="num">${s.airings}</td>
            <td class="num">${escHtml(s.air_time)}</td>
        </tr>`).join('');

    renderModalPagination('ch-modal-story-pagination', 'ch-story', page, pages, start, total, 'stories');
}

// Delegated handler for the channel-modal body — survives re-renders. Handles
// pagination, region pills, pie/legend country selection, and chip clears.
chModalBody.addEventListener('click', e => {
    // 0. Trend bar → focus that bar's airings (click again or the tag to clear)
    const bin = trendBinFromEvent(e, state.chModalBin);
    if (bin !== undefined) {
        state.chModalBin = bin;
        renderChannelModalBody(state.chModalChannel);
        chModalBody.querySelector('.trend-slot.is-selected')?.focus();
        return;
    }

    // 1. Region pill → set region filter
    const pill = e.target.closest('.ch-modal-region-pills .filter-pill[data-ch-region]');
    if (pill) {
        state.chModalRegion = pill.dataset.chRegion;
        applyChannelModalFilters();
        return;
    }

    // 2. Pie slice or legend row → toggle country filter (click again to clear)
    const slice = e.target.closest('.pie-chart path[data-country], .pie-legend li[data-country]');
    if (slice) {
        const country = slice.dataset.country;
        state.chModalCountry = state.chModalCountry === country ? null : country;
        applyChannelModalFilters();
        return;
    }

    // 3. Pagination — existing behaviour
    const btn = e.target.closest('[data-page-action]');
    if (!btn || btn.dataset.pageKind !== 'ch-story') return;
    const total = (state.chModalStories || []).length;
    const pages = Math.max(1, Math.ceil(total / MODAL_PAGE_SIZE));
    if (btn.dataset.pageAction === 'next' && state.chModalStoryPage < pages) state.chModalStoryPage++;
    if (btn.dataset.pageAction === 'prev' && state.chModalStoryPage > 1) state.chModalStoryPage--;
    renderChannelModalStoryPage();
});

// ── Download Summary (one-page briefing) ─────────────────────────────────────
// Builds a fixed-width briefing card off-screen — headline numbers, plain-English
// highlights, top 10 stories / channels / countries — captures it with
// html2canvas, and saves it as PNG, JPEG or a single-page PDF. Follows whatever
// dataset is live, so the Exclude-US toggle carries through.
const SUMMARY_TOP_N = 10;

function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
}

function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n - 1).trimEnd() + '…' : str;
}

// Plain-English one-liners for the highlights box. Each is skipped when the
// data to back it isn't there (e.g. no Asset export → no zero-use line).
function summaryHighlights() {
    const s = state.summary;
    const aired = state.allStories.filter(st => !st.zero_use);
    const out = [];

    const top = topStoriesByChannels(SUMMARY_TOP_N);
    const topAirings = top.reduce((n, st) => n + st.airings, 0);
    if (aired.length > SUMMARY_TOP_N) {
        out.push(`The ${SUMMARY_TOP_N} most widely carried stories made up <strong>${pct(topAirings, s.total_airings)}%</strong> of all airings.`);
    }

    const widest = aired.reduce((best, st) => (!best || st.countries > best.countries ? st : best), null);
    if (widest) {
        out.push(`Widest reach: <strong>${escHtml(displaySlug(widest))}</strong> aired in ${widest.countries.toLocaleString()} countries on ${widest.channels.toLocaleString()} channels.`);
    }

    const full = dayView(state.datasets.full, state.selectedDay);
    const exUs = dayView(state.datasets.ex_us, state.selectedDay);
    if (state.excludeUS) {
        out.push('US channels are <strong>excluded</strong> from every figure on this page.');
    } else if (full && exUs) {
        const usShare = pct(full.summary.total_airings - exUs.summary.total_airings, full.summary.total_airings);
        out.push(`US channels accounted for <strong>${usShare}%</strong> of airings; ${100 - usShare}% came from outside the US.`);
    }

    const zu = s.zero_use_stories || 0;
    if (zu) {
        out.push(`<strong>${zu.toLocaleString()}</strong> published ${zu === 1 ? 'story wasn’t' : 'stories weren’t'} aired on any monitored channel.`);
    }
    return out;
}

function buildSummaryCard() {
    const s = state.summary;
    const stories = topStoriesByChannels(SUMMARY_TOP_N);
    const channels = state.topChannels.slice(0, SUMMARY_TOP_N);
    const markets = state.topMarkets.slice(0, SUMMARY_TOP_N);
    const generated = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

    const stat = (label, value) => `
        <div class="sc-stat"><div class="sc-stat-value">${value}</div><div class="sc-stat-label">${label}</div></div>`;

    const storyRows = stories.map((st, i) => `
        <tr>
            <td class="sc-rank">${i + 1}</td>
            <td class="sc-name">
                <div class="sc-slug">${escHtml(truncate(displaySlug(st), 48))}</div>
                ${st.headline ? `<div class="sc-sub">${escHtml(truncate(st.headline, 70))}</div>` : ''}
            </td>
            <td class="sc-num">${st.airings.toLocaleString()}</td>
            <td class="sc-num">${st.channels.toLocaleString()}</td>
            <td class="sc-num">${st.countries.toLocaleString()}</td>
        </tr>`).join('');

    const channelRows = channels.map((c, i) => `
        <tr>
            <td class="sc-rank">${i + 1}</td>
            <td class="sc-name">
                <div class="sc-strong">${escHtml(truncate(c.channel, 34))}</div>
                ${c.country ? `<div class="sc-sub">${escHtml(c.country)}</div>` : ''}
            </td>
            <td class="sc-num">${c.airings.toLocaleString()}</td>
        </tr>`).join('');

    const marketRows = markets.map((m, i) => `
        <tr>
            <td class="sc-rank">${i + 1}</td>
            <td class="sc-name"><div class="sc-strong">${escHtml(m.market)}</div></td>
            <td class="sc-num">${m.airings.toLocaleString()}</td>
        </tr>`).join('');

    const highlights = summaryHighlights();

    const card = document.createElement('div');
    card.className = 'summary-card';
    card.innerHTML = `
        <div class="sc-header">
            <img class="sc-logo" src="images/tr_pri_logo_rgb_color.png" alt="Thomson Reuters">
            <div class="sc-title-wrap">
                <div class="sc-title">RVN Usage Summary</div>
                <div class="sc-range">${escHtml(state.dateRange.from)} – ${escHtml(state.dateRange.to)}${state.selectedDay ? ` · <span class="sc-chip">Published ${escHtml(dayLongLabel(state.selectedDay))} only</span>` : ''}${state.excludeUS ? ' · <span class="sc-chip">Excluding US channels</span>' : ''}</div>
            </div>
        </div>
        <div class="sc-stats">
            ${stat('Airings', s.total_airings.toLocaleString())}
            ${stat('Stories', s.total_stories.toLocaleString())}
            ${stat('Channels', s.total_channels.toLocaleString())}
            ${stat('Countries', s.total_countries.toLocaleString())}
            ${stat('Air time', escHtml(s.total_air_time))}
        </div>
        ${highlights.length ? `<ul class="sc-highlights">${highlights.map(h => `<li>${h}</li>`).join('')}</ul>` : ''}
        <div class="sc-columns">
            <div class="sc-col sc-col-wide">
                <h3 class="sc-h">Top ${stories.length} stories <span class="sc-h-note">by channels</span></h3>
                <table class="sc-table">
                    <thead><tr><th class="sc-rank"></th><th>Story</th><th class="sc-num">Airings</th><th class="sc-num">Channels</th><th class="sc-num">Countries</th></tr></thead>
                    <tbody>${storyRows}</tbody>
                </table>
            </div>
            <div class="sc-col">
                <h3 class="sc-h">Top ${channels.length} channels</h3>
                <table class="sc-table">
                    <thead><tr><th class="sc-rank"></th><th>Channel</th><th class="sc-num">Airings</th></tr></thead>
                    <tbody>${channelRows}</tbody>
                </table>
                <h3 class="sc-h sc-h-gap">Top ${markets.length} countries</h3>
                <table class="sc-table">
                    <thead><tr><th class="sc-rank"></th><th>Country</th><th class="sc-num">Airings</th></tr></thead>
                    <tbody>${marketRows}</tbody>
                </table>
            </div>
        </div>
        <div class="sc-footer">Teletrax detections · generated ${escHtml(generated)} by RVN Usage Tracker</div>`;
    return card;
}

// Wrap one JPEG in a minimal single-page PDF. A JPEG can be embedded as-is
// (DCTDecode), so no PDF library is needed — page size matches the image's
// aspect ratio at a fixed 720pt width.
function jpegToPdf(jpegBytes, widthPx, heightPx) {
    const pageW = 720;
    const pageH = Math.round(pageW * heightPx / widthPx);
    const enc = new TextEncoder();
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = part => {
        const bytes = typeof part === 'string' ? enc.encode(part) : part;
        chunks.push(bytes);
        length += bytes.length;
    };
    const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n${body}\nendobj\n`); };

    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4] = length;
    push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
    push(jpegBytes);
    push('\nendstream\nendobj\n');
    obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

    const xrefAt = length;
    let xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (let n = 1; n <= 5; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
}

function summaryFilename(ext) {
    const day = str => slugifyForFilename((str || '').split(' ').slice(0, 3).join(' '));
    const range = `${day(state.dateRange.from)}_to_${day(state.dateRange.to)}`;
    const published = state.selectedDay ? `_published-${state.selectedDay}` : '';
    return `rvn-usage-summary_${range}${published}${state.excludeUS ? '_ex-us' : ''}.${ext}`;
}

function triggerDownload(href, filename) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.click();
}

async function downloadSummary(format) {
    if (typeof html2canvas === 'undefined') {
        showToast('Image library still loading — try again in a moment.');
        return;
    }
    if (!state.summary) return;
    const btn = $('btn-export');
    btn.disabled = true;
    showToast('Preparing summary…');

    // Off-screen stage: rendered at a fixed width so the output is identical
    // whatever size the user's window is.
    const stage = document.createElement('div');
    stage.className = 'summary-card-stage';
    const card = buildSummaryCard();
    stage.appendChild(card);
    document.body.appendChild(stage);

    try {
        await document.fonts.ready;
        const logo = card.querySelector('.sc-logo');
        if (logo && !logo.complete) await new Promise(r => { logo.onload = logo.onerror = r; });

        const canvas = await html2canvas(card, {
            scale: 2,
            backgroundColor: '#ffffff',
            logging: false,
        });

        if (format === 'png') {
            triggerDownload(canvas.toDataURL('image/png'), summaryFilename('png'));
        } else {
            const jpegUrl = canvas.toDataURL('image/jpeg', 0.92);
            if (format === 'jpeg') {
                triggerDownload(jpegUrl, summaryFilename('jpg'));
            } else {
                const bin = atob(jpegUrl.split(',')[1]);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const url = URL.createObjectURL(jpegToPdf(bytes, canvas.width, canvas.height));
                triggerDownload(url, summaryFilename('pdf'));
                setTimeout(() => URL.revokeObjectURL(url), 10000);
            }
        }
        showToast('Summary downloaded.');
    } catch (err) {
        console.error('Summary export failed:', err);
        showToast('Sorry — summary export failed. Try again?');
    } finally {
        stage.remove();
        btn.disabled = false;
    }
}

const summaryMenu = $('summary-export-menu');
$('btn-export').addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.export-menu').forEach(m => { if (m !== summaryMenu) m.hidden = true; });
    summaryMenu.hidden = !summaryMenu.hidden;
    $('btn-export').setAttribute('aria-expanded', String(!summaryMenu.hidden));
});
summaryMenu.addEventListener('click', e => {
    const item = e.target.closest('.export-menu-item');
    if (!item) return;
    summaryMenu.hidden = true;
    $('btn-export').setAttribute('aria-expanded', 'false');
    downloadSummary(item.dataset.format);
});

// "Export top N" — context-aware: dumps whatever's currently on screen
// (filtered + sorted) capped to N rows. N selected via split-button dropdown.
async function exportTopN(kind, n) {
    const rows = (kind === 'channels' ? state.filteredChannels : state.filteredStories).slice(0, n);
    if (rows.length === 0) {
        showToast('Nothing to export — try clearing your search.');
        return;
    }
    try {
        const res = await fetch('/api/export-top', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, rows }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.error || 'Export failed');
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `reuters-top-${kind}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Downloading top ${rows.length} ${kind}…`);
    } catch (err) {
        showToast('Export failed — please try again');
    }
}

document.querySelectorAll('.export-split').forEach(split => {
    const kind = split.dataset.kind;
    const main = split.querySelector('.export-main');
    const chevron = split.querySelector('.export-chevron');
    const menu = split.querySelector('.export-menu');
    const label = split.querySelector('.export-count');

    function setCount(n) {
        main.dataset.count = String(n);
        label.textContent = String(n);
        split.querySelectorAll('.export-menu-item').forEach(it => {
            it.classList.toggle('active', it.dataset.count === String(n));
        });
    }
    setCount(25);

    main.addEventListener('click', () => {
        exportTopN(kind, parseInt(main.dataset.count, 10) || 25);
    });

    chevron.addEventListener('click', e => {
        e.stopPropagation();
        // Close every other split's menu before opening this one.
        document.querySelectorAll('.export-menu').forEach(m => { if (m !== menu) m.hidden = true; });
        menu.hidden = !menu.hidden;
    });

    menu.addEventListener('click', e => {
        const item = e.target.closest('.export-menu-item');
        if (!item) return;
        const n = parseInt(item.dataset.count, 10) || 25;
        setCount(n);
        menu.hidden = true;
    });
});

// Click anywhere else closes any open export menu.
document.addEventListener('click', e => {
    if (e.target.closest('.export-split') || e.target.closest('.summary-export')) return;
    document.querySelectorAll('.export-menu').forEach(m => { m.hidden = true; });
    $('btn-export').setAttribute('aria-expanded', 'false');
});

// ── Help drawer ──────────────────────────────────────────────────────────────
// Searchable key to everything on the dashboard. Each entry is plain text
// (paragraphs) so search highlighting can't break markup; `demo` is optional
// trusted HTML showing the real symbol, and `keys` adds search-only synonyms.
const helpDemoChip = (dow, date, fill, dot) => `
    <span class="day-chip"><span class="day-chip-dow">${dow}</span><span class="day-chip-date">${date}</span>
    ${dot ? '<span class="day-chip-dot"></span>' : ''}
    <span class="day-chip-bar"><span class="day-chip-fill" style="width:${fill}%"></span></span></span>`;

const HELP_SECTIONS = [
    { title: 'The basics', entries: [
        { title: 'Airings', keys: 'detection hit plays',
          body: ['One airing is one Teletrax detection: a monitored channel playing part of a Reuters story. A story played five times on one channel counts as five airings.'] },
        { title: 'Channels and countries', keys: 'markets international region broadcast',
          body: ['Channels is the number of different monitored channels that aired the story. Countries is where those channels broadcast, taken from Teletrax’s channel region — so pan-regional channels such as France 24 count as “International”.'] },
        { title: 'Air time', keys: 'duration length seconds',
          body: ['The total amount of the story actually played, added up across every airing. In a story’s window, “Avg clip used” is that total divided by the number of airings.'] },
        { title: 'Number before the slug', keys: 'story id prefix 9205 edition',
          body: ['The number in front of each slug (e.g. 9205-POPE-HEALTH/) is the start of the story’s Story ID. Reuters reuses slugs, so it tells different editions of the same slug apart.'] },
        { title: 'Date published', keys: 'activation publish time utc',
          body: ['When the story was published — its activation date in Teletrax — in UTC.'] },
    ]},
    { title: 'Publish days', entries: [
        { title: 'Picking a day', keys: 'day strip chip filter published date select arrow keys',
          demo: helpDemoChip('Tue', '13 Oct', 100),
          body: ['Click a day under the banner to narrow everything — the banner numbers, both tables, the sidebar, channel windows and Download Summary — to the stories published that day. “All days” goes back to the whole upload. Arrow keys step through the days.',
                 'Each story still shows all of its airings across the whole export, not just the airings that happened on that day.'] },
        { title: 'Days run on UTC', keys: 'timezone midnight singapore sgt gmt',
          body: ['A day is midnight to midnight UTC, so every story is filed under the same day for everyone. For example, a story published at 07:00 Singapore time on a Tuesday counts as Monday (23:00 UTC).'] },
        { title: 'Orange bar under a day', keys: 'coverage partial bar line full',
          demo: helpDemoChip('Sat', '10 Oct', 94) + helpDemoChip('Sun', '11 Oct', 100),
          body: ['How much of that day the export covers. A full bar means the whole day is in the upload; a shorter bar means the export starts or ends partway through it, so that day isn’t fully represented. Hover a day for the exact figure.'] },
        { title: 'Amber dot on a day', keys: 'dot warning 24 hours still climbing incomplete accumulating',
          demo: '<span class="help-dot"></span>',
          body: ['Some stories published that day had less than 24 hours on air before the export ended, so their numbers are still climbing. Compare that day with earlier days carefully.'] },
        { title: 'Earlier', keys: 'before window pre-window older',
          body: ['Appears only if the upload includes stories published before the export window opened. Only their airings inside the window are counted.'] },
        { title: 'Faded day', keys: 'disabled grey empty no stories',
          body: ['No stories were published that day, so there’s nothing to show.'] },
        { title: 'Channel trend in a single day', keys: 'dash missing unavailable sparkline',
          body: ['When one day is picked, the Channels table shows “—” for Trend. The export doesn’t break each channel’s airings down by time for a subset of stories. Switch to All days to see channel trends.'] },
    ]},
    { title: 'Scores and symbols', entries: [
        { title: 'Reach (stories)', keys: 'score 0-100 breadth widest pickup',
          demo: reachDisplay(97) + reachDisplay(52) + reachDisplay(14),
          body: ['How widely a story was picked up, from 0 to 100. It averages how the story ranks on number of channels and number of countries against every other story in this upload — 100 is the widest in the upload. Airings don’t count towards it.',
                 'Green is 66 and above, gold 33–65, grey below 33. When a day is picked, scores stay ranked against the whole upload so days can be compared.'] },
        { title: 'Longevity', keys: 'legs 24 hours percent dash staying power',
          demo: longevityDisplay(73) + longevityDisplay(42) + longevityDisplay(11),
          body: ['The share of a story’s airings that came more than 24 hours after it was published. Higher means the story had legs. Green is 60% and above, gold 30–59%, grey below 30%.',
                 '“—” means it was published less than 24 hours before the export ended (or has no publish time), so it can’t be judged fairly yet.'] },
        { title: 'Significance (channels)', keys: 'score volume breadth diversity 0-100',
          demo: significanceDisplay(91) + significanceDisplay(47),
          body: ['An overall score for a channel, from 0 to 100: the average of how it ranks against the other channels in this upload on Volume (airings), Breadth (different stories aired) and Diversity (how spread its stories’ origin countries are — channels with under 10 airings are scored down so a handful of plays can’t look diverse).',
                 'When a day is picked, channels are re-ranked against the other channels that aired that day’s stories.'] },
        { title: 'Trend', keys: 'sparkline bars chart per day hour',
          demo: renderSparkline([2, 6, 9, 4, 2, 1, 3], null, 'day'),
          body: ['Airings per day across the export (per hour if the export covers less than a day; at most 14 bars). Hover a bar for its count.'] },
        { title: 'Sidebar bars', keys: 'top stories channels countries orange line',
          body: ['The orange line under each sidebar item shows it relative to the number-one item in that list. Top Stories are ranked by number of channels.'] },
        { title: 'Tinted rows with zeros', keys: 'zero-use zero use never aired asset export',
          body: ['If you added an Asset export when uploading, stories that were published but never aired on any monitored channel are listed with zeros on a lightly tinted row, and counted as zero-use.'] },
    ]},
    { title: 'Filters and windows', entries: [
        { title: 'Region filter', keys: 'europe americas asia pacific middle east africa pills',
          body: ['Based on the story’s slug, not where it aired — USA-CHINA/… counts for both Americas and Asia Pacific. A story can sit in more than one region.'] },
        { title: 'Search', keys: 'find slug headline channel name',
          body: ['On Stories, searches slugs and headlines. On Channels, searches channel names and countries.'] },
        { title: 'Exclude US channels', keys: 'usa toggle ex-us international',
          body: ['Removes US-based channels and their airings from every figure, including the summary download. Switching it clears your search and region filter.'] },
        { title: 'Clicking a trend bar', keys: 'chart bar day hour focus filter aired that day single story channel window',
          body: ['In a story or channel window, click a bar in the airings chart to see just the airings in that bar — the numbers, channel or story list and pie all switch to that day (or hour). Click the bar again, or “All days”, to go back.',
                 'This is about when the story aired, not when it was published — for that, use the publish days under the banner. Reach, Longevity and Significance always describe the whole period, so they fade while a bar is picked.'] },
        { title: 'Story window', keys: 'modal details on this day family',
          body: ['Click a story for its full channel list. “On this day” shows how that day’s airings split across slug families (IRAN-CRISIS, USA-TARIFFS…) for stories published the same day — this story’s family is outlined.'] },
        { title: 'Channel window', keys: 'modal pie chart origin country click',
          body: ['Click a channel for its stories. The pie shows where its stories came from, using the first word of each slug (USA, IRAN…), weighted by airings. Click a slice or legend row to filter the list; click again to clear.'] },
    ]},
    { title: 'Downloads', entries: [
        { title: 'Download Summary', keys: 'png jpeg pdf one page briefing export',
          body: ['A one-page briefing of what’s on screen — headline numbers, highlights and top 10 stories, channels and countries. It follows the picked day and the Exclude US switch, and says so on the page.'] },
        { title: 'Export top 25 / 50 / 100', keys: 'excel xlsx spreadsheet',
          body: ['An Excel file of the top rows currently in the table, in your current order, with your search and filters applied.'] },
        { title: 'Download view', keys: 'png image story channel window',
          body: ['Saves a story or channel window as an image, with up to 100 rows of its list.'] },
    ]},
];

function helpHighlight(text, terms) {
    if (!terms.length) return escHtml(text);
    const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re).map((part, i) => i % 2 ? `<mark>${escHtml(part)}</mark>` : escHtml(part)).join('');
}

function renderHelp() {
    const terms = $('help-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    const html = HELP_SECTIONS.map(sec => {
        const entries = sec.entries.filter(e => {
            const hay = `${e.title} ${e.keys || ''} ${e.body.join(' ')}`.toLowerCase();
            return terms.every(t => hay.includes(t));
        });
        shown += entries.length;
        if (!entries.length) return '';
        return `
            <h3 class="help-section-title">${escHtml(sec.title)}</h3>
            ${entries.map(e => `
            <div class="help-entry">
                <div class="help-entry-head">
                    <h4 class="help-entry-title">${helpHighlight(e.title, terms)}</h4>
                    ${e.demo ? `<span class="help-demo" aria-hidden="true">${e.demo}</span>` : ''}
                </div>
                ${e.body.map(p => `<p>${helpHighlight(p, terms)}</p>`).join('')}
            </div>`).join('')}`;
    }).join('');
    $('help-body').innerHTML = shown
        ? (terms.length ? `<p class="help-count">${shown} result${shown === 1 ? '' : 's'}</p>` : '') + html
        : `<div class="help-empty">Nothing matches “${escHtml(terms.join(' '))}”. Try a simpler word.</div>`;
    $('help-search-clear').style.display = terms.length ? 'block' : 'none';
}

function openHelp() {
    $('help-drawer').hidden = false;
    document.body.style.overflow = 'hidden';
    renderHelp();
    $('help-search').focus();
}
function closeHelp() {
    if ($('help-drawer').hidden) return;
    $('help-drawer').hidden = true;
    if (storyModal.style.display === 'none' && channelModal.style.display === 'none') document.body.style.overflow = '';
    $('btn-help').focus();
}

$('btn-help').addEventListener('click', openHelp);
$('help-close').addEventListener('click', closeHelp);
$('help-drawer').addEventListener('click', e => { if (e.target === $('help-drawer')) closeHelp(); });
$('help-search').addEventListener('input', renderHelp);
$('help-search-clear').addEventListener('click', () => {
    $('help-search').value = '';
    renderHelp();
    $('help-search').focus();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHelp(); });

// ── Loading helpers ──────────────────────────────────────────────────────────
const RING_CIRCUMFERENCE = 163.4; // 2π·26, must match .progress-ring-fill dasharray
function showLoading(text, sub) {
    loadingText.textContent = text || 'Loading…';
    $('loading-sub').textContent = sub || '';
    loadingOverlay.style.display = 'flex';
}
function hideLoading() {
    loadingOverlay.style.display = 'none';
    showLoadingSpinner(); // reset to spinner for the next open
}
// Indeterminate mode — used when we can't measure progress (analyse phase).
function showLoadingSpinner() {
    $('loading-spinner').style.display = '';
    $('loading-ring').style.display = 'none';
}
// Determinate mode — show the ring and set it to a 0–1 fraction (upload phase).
function showLoadingRing(fraction) {
    $('loading-spinner').style.display = 'none';
    $('loading-ring').style.display = '';
    setLoadingRing(fraction);
}
function setLoadingRing(fraction) {
    const f = Math.max(0, Math.min(1, fraction || 0));
    $('loading-ring-fill').style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - f);
    $('loading-ring-pct').textContent = Math.round(f * 100) + '%';
}

// ── Upload error helpers ─────────────────────────────────────────────────────
function showUploadError(msg) {
    uploadError.textContent = msg;
    uploadError.style.display = 'block';
}
function hideUploadError() {
    uploadError.style.display = 'none';
    uploadError.textContent = '';
}

// ── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
    const wrap = $('toast-wrap');
    $('toast-msg').textContent = msg;
    wrap.style.display = 'flex';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { wrap.style.display = 'none'; }, 3000);
}

// ── Utility ──────────────────────────────────────────────────────────────────
function escHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function slugPrefix(story) {
    if (!story || !story.story_id) return null;
    const m = String(story.story_id).match(/^\d{1,4}/);
    return m ? m[0] : null;
}

function displaySlug(story) {
    const prefix = slugPrefix(story);
    return prefix ? `${prefix}-${story.slug}` : story.slug;
}

function slugDisplay(slugOrStory) {
    // Backwards-compat: callers may pass either a story object or just a slug string.
    if (typeof slugOrStory === 'string') return escHtml(slugOrStory);
    return escHtml(displaySlug(slugOrStory));
}

function longevityDisplay(pct, plain) {
    if (pct == null) return `<span class="longevity longevity-na" title="Published too late in the dataset to compute longevity">—</span>`;
    const cls = pct >= 60 ? 'longevity-high' : pct >= 30 ? 'longevity-mid' : 'longevity-low';
    const variant = plain ? 'longevity-plain' : '';
    return `<span class="longevity ${cls} ${variant}" title="${pct}% of airings happened after the first 24h">${pct}%</span>`;
}

// Composite 0–100 channel significance — volume + story breadth + geographic
// diversity, each percentile-ranked within this dataset then averaged. Same
// pill idiom as longevity so the two columns read consistently.
function significanceDisplay(score, plain) {
    if (score == null) return `<span class="significance significance-na" title="No significance score">—</span>`;
    const cls = score >= 66 ? 'significance-high' : score >= 33 ? 'significance-mid' : 'significance-low';
    const variant = plain ? 'significance-plain' : '';
    return `<span class="significance ${cls} ${variant}" title="Composite of airings volume, story breadth, and geographic diversity (0–100, relative to this dataset)">${score}</span>`;
}

// Story reach — 0–100 breadth score, mean of percentile-ranked distinct
// channels and distinct countries within this dataset. Complements the airings
// column (volume) and reuses the significance pill idiom so the columns match.
function reachDisplay(score, plain) {
    if (score == null) return `<span class="significance significance-na" title="No reach score">—</span>`;
    const cls = score >= 66 ? 'significance-high' : score >= 33 ? 'significance-mid' : 'significance-low';
    const variant = plain ? 'significance-plain' : '';
    return `<span class="significance ${cls} ${variant}" title="Breadth of pickup — distinct channels and countries, percentile-ranked (0–100, relative to this dataset)">${score}</span>`;
}

// opts.clickable: each bar with airings gets a full-height hit area carrying
// data-bin, so the story/channel windows can narrow to that bar's airings.
// opts.selected: bin index currently focused (others fade, like the pie).
function renderTrendChart(counts, labels, unit, opts = {}) {
    if (!counts || counts.length === 0) return '';
    const { clickable = false, selected = null } = opts;
    const w = 480, h = 150;
    const padL = 28, padR = 6, padT = 14, padB = 26;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    // Tighter bars: 60% of slot is bar, 40% is gap. Slim and editorial.
    const slot = chartW / counts.length;
    const barW = Math.max(3, slot * 0.6);
    const peak = Math.max(...counts, 1);

    // Single baseline + a faint peak gridline. No mid-line clutter.
    const baselineY = padT + chartH;
    const peakY = padT;
    const axis = `
        <line x1="${padL}" y1="${baselineY}" x2="${w - padR}" y2="${baselineY}" stroke="var(--tr-border)" stroke-width="1"></line>
        <line x1="${padL}" y1="${peakY}" x2="${w - padR}" y2="${peakY}" stroke="var(--tr-border)" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"></line>
        <text x="${padL - 6}" y="${baselineY + 3}" text-anchor="end" font-size="10" fill="var(--tr-text-light)">0</text>
        <text x="${padL - 6}" y="${peakY + 3}" text-anchor="end" font-size="10" fill="var(--tr-text-light)">${peak}</text>
    `;

    const bars = counts.map((c, i) => {
        const barH = c === 0 ? 0 : Math.max(2, Math.round(c / peak * chartH));
        const x = padL + i * slot + (slot - barW) / 2;
        const y = baselineY - barH;
        const label = labels?.[i] ? `${labels[i]}: ${c} airing${c === 1 ? '' : 's'}` : `${c} airing${c === 1 ? '' : 's'}`;
        if (!clickable || c === 0) {
            return `
            <rect class="trend-bar" x="${x.toFixed(2)}" y="${y}" width="${barW.toFixed(2)}" height="${barH}">
                <title>${escHtml(label)}</title>
            </rect>
        `;
        }
        const on = selected === i;
        const tip = on ? `${label} — click again to show every ${unit}` : `${label} — click to see just this ${unit}`;
        return `
            <g class="trend-slot${on ? ' is-selected' : ''}" data-bin="${i}" role="button" tabindex="0" aria-pressed="${on}">
                <title>${escHtml(tip)}</title>
                <rect class="trend-hit" x="${(padL + i * slot).toFixed(2)}" y="${padT - 4}" width="${slot.toFixed(2)}" height="${chartH + 4}"></rect>
                <rect class="trend-bar" x="${x.toFixed(2)}" y="${y}" width="${barW.toFixed(2)}" height="${barH}"></rect>
            </g>
        `;
    }).join('');

    // X axis labels — show every nth label if crowded
    const labelStep = Math.max(1, Math.ceil(counts.length / 8));
    const xLabels = (labels || []).map((lbl, i) => {
        if (i % labelStep !== 0 && i !== counts.length - 1) return '';
        const x = padL + i * slot + slot / 2;
        return `<text x="${x.toFixed(2)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="var(--tr-text-light)">${escHtml(lbl)}</text>`;
    }).join('');

    const cls = ['trend-chart', clickable ? 'is-clickable' : '', selected != null ? 'has-selection' : ''].filter(Boolean).join(' ');
    return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-label="Airings per ${unit}">
        ${axis}
        ${bars}
        ${xLabels}
    </svg>`;
}

function renderSparkline(counts, labels, unit) {
    if (!counts || counts.length === 0) return '';
    const w = 84, h = 22, gap = 2;
    const barW = Math.max(2, (w - gap * (counts.length - 1)) / counts.length);
    const peak = Math.max(...counts, 1);
    const bars = counts.map((c, i) => {
        const barH = c === 0 ? 1 : Math.max(2, Math.round(c / peak * h));
        const x = i * (barW + gap);
        const y = h - barH;
        const label = labels?.[i] ? `${labels[i]}: ${c} airing${c === 1 ? '' : 's'}` : `${c} airing${c === 1 ? '' : 's'}`;
        const cls = c === 0 ? 'spark-bar spark-bar-empty' : 'spark-bar';
        return `<rect class="${cls}" x="${x.toFixed(2)}" y="${y}" width="${barW.toFixed(2)}" height="${barH}"><title>${escHtml(label)}</title></rect>`;
    }).join('');
    return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="Airings per ${unit}">${bars}</svg>`;
}

