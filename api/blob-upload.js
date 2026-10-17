import { handleUpload } from '@vercel/blob/client';

async function isSignedIn(req) {
    const cookie = req.headers.cookie;
    if (!cookie) return false;
    try {
        const r = await fetch(`https://${req.headers.host}/api/me`, {
            headers: { cookie },
            redirect: 'manual',
        });
        return r.status === 200;
    } catch {
        return false;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    // Read body from IncomingMessage stream
    const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });

    // Require a signed-in user. This Node function can't read Flask's signed
    // session cookie itself, so it forwards the cookie to Flask's /api/me
    // (behind login_required) and only issues a token on a 200. Host is safe to
    // use: Vercel only routes hosts attached to this project here.
    if (!(await isSignedIn(req))) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }

    // Validate pathname before issuing a token — reject any path separators or non-CSV/XLSX names
    const pathname = body?.payload?.pathname || '';
    if (/[/\\]/.test(pathname) || !/^[\w\-]+\.(csv|xlsx)$/i.test(pathname)) {
        res.status(400).json({ error: 'Invalid file name. Only .csv and .xlsx files are accepted.' });
        return;
    }

    try {
        const jsonResponse = await handleUpload({
            body,
            request: req,
            onBeforeGenerateToken: async () => ({
                allowedContentTypes: [
                    'text/csv',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ],
                maximumSizeInBytes: 50 * 1024 * 1024, // 50 MB — covers ~1 week XLSX exports; matches README promise
                addRandomSuffix: false,
                allowOverwrite: true,
                access: 'public',
            }),
            onUploadCompleted: async () => {},
        });

        res.status(200).json(jsonResponse);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}
