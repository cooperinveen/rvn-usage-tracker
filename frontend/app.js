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
uploadZone.addEventListener('click', () => fileInput.click());
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
    const pathname = safeBasename + '.' + ext;

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
    state.currentPage = 1;
    state.chCurrentPage = 1;
    state.searchQuery = '';
    state.regionFilter = 'all';
    state.view = 'stories';
    searchInput.value = '';
    setActivePill('all');
    setActiveView('stories');
}

// ── Show/hide screens ────────────────────────────────────────────────────────
function showDashboard() {
    hideLoading();
    uploadScreen.style.display = 'none';
    dashboardScreen.style.display = 'block';
    headerStatus.style.display = 'flex';
    // Only offer the ex-US lens when there are US channels to remove.
    $('us-toggle').hidden = !state.datasets.ex_us;
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
    $('stat-stories').textContent = s.total_stories.toLocaleString();
    $('stat-airings').textContent = s.total_airings.toLocaleString();
    $('stat-channels').textContent = s.total_channels.toLocaleString();
    $('stat-countries').textContent = s.total_countries.toLocaleString();
    $('stat-airtime').textContent = s.total_air_time;
    dataBadge.textContent = `${state.dateRange.from} – ${state.dateRange.to}`;
}

// ── Insights Panel ───────────────────────────────────────────────────────────
function renderInsights() {
    const topStories = state.allStories.slice(0, 10);
    const maxAirings = topStories[0]?.airings || 1;

    $('top-stories-list').innerHTML = topStories.map((s, i) => `
        <div class="insight-item" data-story-id="${escHtml(s.story_id || s.slug)}">
            <span class="insight-rank">${i + 1}</span>
            <div style="flex:1; min-width:0">
                <div class="insight-name">${slugDisplay(s)}</div>
                ${s.headline ? `<div class="insight-headline">${escHtml(s.headline)}</div>` : ''}
                <div class="insight-bar-wrap"><div class="insight-bar" style="width:${Math.round(s.airings/maxAirings*100)}%"></div></div>
            </div>
            <span class="insight-count">${s.airings}</span>
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
    const keepView = state.view;   // don't bounce the user back to Stories
    loadData(ds);
    setActiveView(keepView);
    renderSummaryBar();
    renderInsights();
    showToast(useExUS ? 'US channels excluded' : 'Showing all channels');
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
            <td class="col-trend">${sparkline}</td>
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
    renderModalBody(story);
}

function renderModalBody(s) {
    const trendChart = renderTrendChart(s.trend, state.trendLabels, state.trendUnit);

    // Mini-panel: top channel, top country, avg clip
    const topCh = s.all_channels?.[0];
    const topCtry = s.all_markets?.[0];
    const miniPanel = `
        <ul class="modal-mini-panel">
            ${topCh ? `<li><span class="mini-label">Most aired on</span><span class="mini-value">${escHtml(topCh.channel)} <span class="mini-sub">(${topCh.airings.toLocaleString()} airings)</span></span></li>` : ''}
            ${topCtry ? `<li><span class="mini-label">Most aired in</span><span class="mini-value">${escHtml(topCtry.market)} <span class="mini-sub">(${topCtry.airings.toLocaleString()} airings)</span></span></li>` : ''}
            <li><span class="mini-label">Avg clip used</span><span class="mini-value">${escHtml(s.avg_clip)}</span></li>
        </ul>
    `;

    const dayContextSection = renderDayContext(s);

    modalBody.innerHTML = `
        <!-- 1. Headline stats + trend chart (side-by-side) -->
        <div class="modal-section">
            <div class="modal-overview">
                <div class="modal-overview-stats">
                    <div class="stats-grid stats-grid-compact">
                        <div class="stat-card">
                            <span class="stat-card-value">${s.airings.toLocaleString()}</span>
                            <span class="stat-card-label">Airings</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${s.channels}</span>
                            <span class="stat-card-label">Channels</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${s.countries}</span>
                            <span class="stat-card-label">Countries</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${reachDisplay(s.reach, true)}</span>
                            <span class="stat-card-label">Reach</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${escHtml(s.total_air_time)}</span>
                            <span class="stat-card-label">Total air time</span>
                        </div>
                        <div class="stat-card">
                            <span class="stat-card-value">${longevityDisplay(s.longevity, true)}</span>
                            <span class="stat-card-label">Longevity</span>
                        </div>
                    </div>
                </div>
                ${trendChart ? `
                <div class="modal-overview-chart">
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
    state.modalChannels = s.all_channels;
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

// Modal table pagination — delegated so it survives re-renders
modalBody.addEventListener('click', e => {
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
    // Promoted from the body — sits right-aligned next to the country label.
    // innerHTML is safe here: all interpolated values are server-cast ints or
    // the _seconds_to_hms string (no user-controlled content).
    const daysWord = c.days_active === 1 ? 'day' : 'days';
    chModalSummary.innerHTML = `
        <strong>${c.airings.toLocaleString()}</strong> airings of
        <strong>${c.stories.toLocaleString()}</strong> stories over
        <strong>${c.days_active}</strong> ${daysWord}
        (<strong>${escHtml(c.total_air_time)}</strong> total air time)
    `;
    // Each modal open starts with a clean slate — no filter leakage between channels
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
        a.download = `${slugifyForFilename(modalSlug.textContent)}.png`;
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
                <span class="sig-strip-label">Significance<small>ranked within this upload</small></span>
            </div>
            <div class="sig-gauges">${gauges}</div>
        </div>`;
}

function renderChannelModalBody(c) {
    const trendChart = renderTrendChart(c.trend, state.trendLabels, state.trendUnit);
    const pie = renderCountryPie(c.story_country_mix);

    chModalBody.innerHTML = `
        ${renderSignificanceStrip(c)}
        <div class="modal-section">
            <div class="modal-overview">
                <div class="modal-overview-stats">
                    ${pie || '<p class="pie-empty">No country data available.</p>'}
                </div>
                ${trendChart ? `
                <div class="modal-overview-chart">
                    <div class="trend-chart-wrap">${trendChart}</div>
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

    state.chModalAllStories = c.all_stories || [];
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

// ── Export ───────────────────────────────────────────────────────────────────
$('btn-export').addEventListener('click', async () => {
    try {
        const res = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stories: state.allStories }),
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
        a.download = 'reuters-usage-summary.xlsx';
        a.click();
        URL.revokeObjectURL(url);
        showToast('Downloading summary…');
    } catch (err) {
        showToast('Export failed — please try again');
    }
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
    if (e.target.closest('.export-split')) return;
    document.querySelectorAll('.export-menu').forEach(m => { m.hidden = true; });
});

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

function renderTrendChart(counts, labels, unit) {
    if (!counts || counts.length === 0) return '';
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
        return `
            <rect class="trend-bar" x="${x.toFixed(2)}" y="${y}" width="${barW.toFixed(2)}" height="${barH}">
                <title>${escHtml(label)}</title>
            </rect>
        `;
    }).join('');

    // X axis labels — show every nth label if crowded
    const labelStep = Math.max(1, Math.ceil(counts.length / 8));
    const xLabels = (labels || []).map((lbl, i) => {
        if (i % labelStep !== 0 && i !== counts.length - 1) return '';
        const x = padL + i * slot + slot / 2;
        return `<text x="${x.toFixed(2)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="var(--tr-text-light)">${escHtml(lbl)}</text>`;
    }).join('');

    return `<svg class="trend-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-label="Airings per ${unit}">
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

