import os
import secrets
import urllib.request
from functools import wraps
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, Response, session, redirect
from backend.parser import parse_file, parse_asset_file, compute_zero_use, generate_export, generate_top_export

FRONTEND_DIR = str(Path(__file__).parent.parent / 'frontend')

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path='')
app.secret_key = os.environ.get('FLASK_SECRET_KEY', secrets.token_hex(32))

# Trust Vercel's proxy so session cookies are marked Secure correctly
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

IS_PRODUCTION = os.environ.get('VERCEL') == '1'
app.config.update(
    SESSION_COOKIE_SECURE=IS_PRODUCTION,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
)

# ── Auth helpers ──────────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('user'):
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Not authenticated'}), 401
            return redirect('/auth/login')
        return f(*args, **kwargs)
    return decorated


# ── Static / frontend ─────────────────────────────────────────────────────────

@app.route('/')
@login_required
def index():
    return send_from_directory(FRONTEND_DIR, 'index.html')


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route('/auth/login')
def auth_login():
    if session.get('user'):
        return redirect('/')
    from backend import auth
    flow = auth.get_auth_flow()
    auth_uri = flow.pop('auth_uri')  # strip before storing — auth_uri can push session cookie over 4KB limit
    session['auth_flow'] = flow
    return redirect(auth_uri)


@app.route('/auth/callback')
def auth_callback():
    from backend import auth
    if 'error' in request.args:
        return redirect('/auth/login?error=auth_failed')
    flow = session.pop('auth_flow', None)
    if not flow:
        return redirect('/auth/login?error=session_expired')

    try:
        result = auth.handle_callback(flow, dict(request.args))
        user = auth.get_user_info(result['access_token'])
        upn = user.get('userPrincipalName', '')
        if not auth.is_allowed_domain(upn):
            return redirect('/auth/login?error=unauthorized_domain')
        session['user'] = {
            'name': user.get('displayName', ''),
            'email': upn,
        }
        return redirect('/')
    except Exception:
        return redirect('/auth/login?error=auth_failed')


@app.route('/auth/logout')
def auth_logout():
    session.clear()
    return redirect('/auth/login')


@app.route('/api/me')
@login_required
def api_me():
    return jsonify(session['user'])


# ── Upload / process / export (all require login) ─────────────────────────────

@app.route('/api/upload', methods=['POST'])
@login_required
def upload():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    f = request.files['file']
    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400

    filename = f.filename.lower()
    if not (filename.endswith('.csv') or filename.endswith('.xlsx')):
        return jsonify({'error': 'Please upload a .csv or .xlsx file exported from Teletrax'}), 400

    file_bytes = f.read()
    if len(file_bytes) == 0:
        return jsonify({'error': 'The uploaded file is empty'}), 400

    try:
        data = parse_file(file_bytes, f.filename)
    except ValueError as e:
        return jsonify({'error': str(e)}), 422
    except Exception as e:
        return jsonify({'error': f'Could not parse file: {str(e)}'}), 500

    # parse_file returns {'full': {...}, 'ex_us': {...|None}} — pass straight
    # through; the client stores both and the toggle swaps which is live.
    # activation_window is internal (tz-aware Timestamps, not JSON-safe) — drop it.
    data.pop('activation_window', None)
    return jsonify(data)


def _blob_url_ok(blob_url):
    """Validate a Vercel Blob URL — HTTPS, our public store host, no creds."""
    ALLOWED_BLOB_SUFFIX = '.public.blob.vercel-storage.com'
    try:
        from urllib.parse import urlparse
        parsed = urlparse(blob_url)
        hostname = parsed.hostname or ''
        return (
            parsed.scheme == 'https'
            and hostname
            and '%' not in hostname
            and '@' not in blob_url.split('//')[1].split('/')[0]
            and hostname.endswith(ALLOWED_BLOB_SUFFIX)
        )
    except Exception:
        return False


def _fetch_blob(blob_url):
    """Fetch blob bytes. Raises on network error."""
    req = urllib.request.Request(blob_url)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def _delete_blob(blob_url):
    """Best-effort delete of a processed blob — never raises."""
    blob_token = os.environ.get('BLOB_READ_WRITE_TOKEN', '')
    if blob_url and blob_token:
        try:
            del_req = urllib.request.Request(
                blob_url, method='DELETE',
                headers={'Authorization': f'Bearer {blob_token}'}
            )
            urllib.request.urlopen(del_req, timeout=10)
        except Exception:
            pass


@app.route('/api/process', methods=['POST'])
@login_required
def process_blob():
    """Process a detections file already uploaded to Vercel Blob (fetch, parse,
    delete). Optionally also takes an Asset export (asset_url/asset_filename) and
    merges window-constrained zero-use stories into both datasets."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'Invalid request body'}), 400

    blob_url = body.get('url', '').strip()
    filename = body.get('filename', 'upload.xlsx').strip()
    asset_url = body.get('asset_url', '').strip()
    asset_filename = body.get('asset_filename', 'asset.xlsx').strip()

    if not blob_url:
        return jsonify({'error': 'No blob URL provided'}), 400
    if not _blob_url_ok(blob_url):
        return jsonify({'error': 'Invalid file URL'}), 400
    if asset_url and not _blob_url_ok(asset_url):
        return jsonify({'error': 'Invalid asset file URL'}), 400

    try:
        file_bytes = _fetch_blob(blob_url)
    except Exception as e:
        return jsonify({'error': f'Could not fetch uploaded file: {str(e)}'}), 500
    if len(file_bytes) == 0:
        return jsonify({'error': 'The uploaded file is empty'}), 400

    asset_bytes = None
    if asset_url:
        try:
            asset_bytes = _fetch_blob(asset_url)
        except Exception as e:
            return jsonify({'error': f'Could not fetch asset file: {str(e)}'}), 500

    try:
        data = parse_file(file_bytes, filename)
        if asset_bytes:
            _merge_zero_use(data, asset_bytes, asset_filename)
    except ValueError as e:
        return jsonify({'error': str(e)}), 422
    except Exception as e:
        return jsonify({'error': f'Could not parse file: {str(e)}'}), 500
    finally:
        _delete_blob(blob_url)
        if asset_url:
            _delete_blob(asset_url)

    # activation_window is internal (tz-aware Timestamps, not JSON-safe) — drop it.
    data.pop('activation_window', None)
    return jsonify(data)


def _merge_zero_use(data, asset_bytes, asset_filename):
    """Compute zero-use stories from an Asset export and merge them into both the
    full and ex_us datasets in-place. Zero-use rows are channel-agnostic, so the
    same set applies to both. Appended AFTER aggregation/reach so they don't
    dilute real stories' reach percentiles."""
    asset_data = parse_asset_file(asset_bytes, asset_filename)
    det_window = data.get('activation_window')
    full = data['full']
    trend_len = len(full.get('trend_labels') or [])
    result = compute_zero_use(full['stories'], det_window, asset_data, trend_len=trend_len)
    zero_use = result['zero_use']

    for ds in (data.get('full'), data.get('ex_us')):
        if not ds:
            continue
        # Fresh copies per dataset — they're sorted independently downstream.
        ds['stories'] = ds['stories'] + [dict(z) for z in zero_use]
        ds['stories'].sort(key=lambda x: x['airings'], reverse=True)
        ds['summary']['total_stories'] = int(ds['summary']['total_stories']) + len(zero_use)
        ds['summary']['zero_use_stories'] = len(zero_use)
        ds['zero_use_warning'] = result['warning']
        ds['zero_use_excluded'] = result['excluded_recent']


@app.route('/api/export', methods=['POST'])
@login_required
def export_summary():
    """Generate XLSX from stories supplied by the client — no server-side state."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'Invalid request body'}), 400

    stories = body.get('stories')
    if not isinstance(stories, list) or len(stories) == 0:
        return jsonify({'error': 'No stories provided'}), 400

    try:
        xlsx_bytes = generate_export(stories)
    except Exception as e:
        return jsonify({'error': f'Could not generate export: {str(e)}'}), 500

    return Response(
        xlsx_bytes,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers={'Content-Disposition': 'attachment; filename="reuters-usage-summary.xlsx"'}
    )


@app.route('/api/export-top', methods=['POST'])
@login_required
def export_top():
    """Top-N export — kind is 'stories' or 'channels', rows are already
    filtered + sorted client-side. Server just transforms to XLSX."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'Invalid request body'}), 400

    kind = body.get('kind')
    rows = body.get('rows')
    if kind not in ('stories', 'channels'):
        return jsonify({'error': 'Invalid export kind'}), 400
    if not isinstance(rows, list) or len(rows) == 0:
        return jsonify({'error': 'No rows to export'}), 400

    # Hard cap at 100 to keep payload and XLSX size bounded;
    # the button asks for 25 but we leave headroom for future tweaks.
    rows = rows[:100]

    try:
        xlsx_bytes = generate_top_export(kind, rows)
    except Exception as e:
        return jsonify({'error': f'Could not generate export: {str(e)}'}), 500

    fname = f"reuters-top-{kind}.xlsx"
    return Response(
        xlsx_bytes,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers={'Content-Disposition': f'attachment; filename="{fname}"'}
    )


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=True, port=port)
