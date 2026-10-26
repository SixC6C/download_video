// Run: node server.js (needs Node 18+ and yt-dlp + ffmpeg)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');

// Safety handlers to prevent process termination on client aborts or network timeouts
process.on('uncaughtException', err => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.name === 'TimeoutError' || err.message?.includes('abort')) {
    return;
  }
  console.error('[Uncaught Exception]', err.message);
});

process.on('unhandledRejection', reason => {
  console.error('[Unhandled Rejection]', reason);
});

const PORT = process.env.PORT || 3000;
const HOSTS = /(^|\.)(tiktok\.com|instagram\.com|instagr\.am)$/i;
const hits = new Map(); // simple per-IP rate limit: 60 requests / 10 min

// Metadata cache for instant preview response
const metaCache = new Map(); // url -> { platform, title, author, cover, duration, playUrl, directUrl, timestamp }

// Video file cache for instant playback/downloads
const videoCache = new Map(); // url -> { filePath, size, timestamp }

// Cleanup caches older than 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [url, item] of videoCache.entries()) {
    if (now - item.timestamp > 900000) {
      if (fs.existsSync(item.filePath)) {
        fs.unlink(item.filePath, () => {});
      }
      videoCache.delete(url);
    }
  }
  for (const [url, item] of metaCache.entries()) {
    if (now - item.timestamp > 900000) {
      metaCache.delete(url);
    }
  }
}, 60000);

// Add common Linux/Railway and Windows paths to PATH so yt-dlp and ffmpeg are always found
const extraPaths = [
  path.join(__dirname, 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  '/root/.local/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/nix/var/nix/profiles/default/bin',
  '/root/.nix-profile/bin',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'Scripts'),
  path.join(process.env.APPDATA || '', 'Python', 'Python313', 'Scripts'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts')
].filter(p => fs.existsSync(p));

if (extraPaths.length > 0) {
  process.env.PATH = extraPaths.join(path.delimiter) + path.delimiter + (process.env.PATH || '');
}

let cachedRunner = null;

function getYtDlpRunner() {
  if (cachedRunner) return cachedRunner;

  const binPath = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const userBin = path.join(os.homedir(), '.local', 'bin', 'yt-dlp');

  const candidates = [
    ...(fs.existsSync(binPath) ? [{ cmd: binPath, baseArgs: [] }] : []),
    ...(fs.existsSync(userBin) ? [{ cmd: userBin, baseArgs: [] }] : []),
    ...(fs.existsSync('/root/.local/bin/yt-dlp') ? [{ cmd: '/root/.local/bin/yt-dlp', baseArgs: [] }] : []),
    ...(fs.existsSync('/usr/local/bin/yt-dlp') ? [{ cmd: '/usr/local/bin/yt-dlp', baseArgs: [] }] : []),
    ...(fs.existsSync('/usr/bin/yt-dlp') ? [{ cmd: '/usr/bin/yt-dlp', baseArgs: [] }] : []),
    { cmd: 'yt-dlp', baseArgs: [] },
    { cmd: 'python3', baseArgs: ['-m', 'yt_dlp'] },
    ...(fs.existsSync('/usr/bin/python3') ? [{ cmd: '/usr/bin/python3', baseArgs: ['-m', 'yt_dlp'] }] : []),
    ...(fs.existsSync('/usr/local/bin/python3') ? [{ cmd: '/usr/local/bin/python3', baseArgs: ['-m', 'yt_dlp'] }] : []),
    { cmd: 'python', baseArgs: ['-m', 'yt_dlp'] },
    { cmd: 'py', baseArgs: ['-m', 'yt_dlp'] }
  ];

  for (const item of candidates) {
    try {
      const res = spawnSync(item.cmd, [...item.baseArgs, '--version'], { encoding: 'utf8', env: process.env });
      if (!res.error && res.status === 0) {
        console.log(`Using yt-dlp runner: ${item.cmd} ${item.baseArgs.join(' ')} (version: ${res.stdout.trim()})`);
        cachedRunner = item;
        return item;
      }
    } catch {}
  }

  // On-demand self-healing download if missing in container
  try {
    const binDir = path.join(__dirname, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    const dlUrl = process.platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    console.log(`Attempting on-demand standalone yt-dlp download from ${dlUrl}...`);
    const curlRes = spawnSync('curl', ['-L', dlUrl, '-o', binPath], { env: process.env });
    if (curlRes.status === 0 && fs.existsSync(binPath)) {
      if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
      console.log('Successfully acquired standalone yt-dlp binary at', binPath);
      cachedRunner = { cmd: binPath, baseArgs: [] };
      return cachedRunner;
    }
  } catch (err) {
    console.error('On-demand yt-dlp download failed:', err.message);
  }

  return { cmd: 'yt-dlp', baseArgs: [] };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Accept-Ranges');
}

function limited(ip) {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return false;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 600000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 60;
}

const json = (res, code, obj) => {
  if (res.headersSent) return;
  setCors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Resolve short URLs (vt.tiktok.com, vm.tiktok.com) to full canonical video URLs in ~300ms
async function unshortenUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes('vt.tiktok.com') || u.hostname.includes('vm.tiktok.com')) {
      const resp = await fetch(rawUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(3000)
      });
      if (resp.url && resp.url !== rawUrl) {
        return resp.url;
      }
    }
  } catch {}
  return rawUrl;
}

// Fast metadata resolver (< 1-2 seconds)
async function resolveVideoMeta(targetUrl, platform) {
  const cached = metaCache.get(targetUrl);
  if (cached && (Date.now() - cached.timestamp < 600000)) {
    return cached;
  }

  // Resolve short links first if needed (e.g. vt.tiktok.com -> full url)
  const canonicalUrl = await unshortenUrl(targetUrl);
  const isTikTok = platform === 'tiktok' || /(tiktok\.com)$/i.test(new URL(canonicalUrl).hostname);

  // TikTok: Direct API resolves in ~800ms
  if (isTikTok) {
    try {
      const apiUrl = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(canonicalUrl);
      const apiRes = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(4000)
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data && data.code === 0 && data.data) {
          const playUrl = data.data.play || data.data.wmplay || '';
          const meta = {
            platform: 'tiktok',
            title: data.data.title || 'TikTok Video',
            author: data.data.author?.nickname || data.data.author?.unique_id || '',
            cover: data.data.cover || data.data.origin_cover || '',
            duration: data.data.duration || 0,
            playUrl,
            timestamp: Date.now()
          };
          metaCache.set(targetUrl, meta);
          return meta;
        }
      }
    } catch (e) {
      console.warn('Fast TikTok API failed, falling back to yt-dlp metadata:', e.message);
    }
  }

  // Instagram or TikTok fallback: yt-dlp metadata dump (~1.5-2.5s)
  const runner = getYtDlpRunner();
  const args = [
    ...runner.baseArgs,
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--socket-timeout', '10',
    '--', targetUrl
  ];

  return new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    const proc = spawn(runner.cmd, args, { env: process.env });
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Metadata resolution timed out.'));
    }, 12000);

    proc.stdout.on('data', chunk => stdoutData += chunk.toString());
    proc.stderr.on('data', chunk => stderrData += chunk.toString());

    proc.on('close', code => {
      clearTimeout(killTimer);
      if (code === 0 && stdoutData) {
        try {
          const d = JSON.parse(stdoutData);
          const meta = {
            platform: isTikTok ? 'tiktok' : 'instagram',
            title: d.title || (isTikTok ? 'TikTok Video' : 'Instagram Reel'),
            author: d.uploader || d.channel || '',
            cover: d.thumbnail || '',
            duration: d.duration || 0,
            directUrl: d.url || '',
            timestamp: Date.now()
          };
          metaCache.set(targetUrl, meta);
          return resolve(meta);
        } catch (err) {
          return reject(new Error('Failed to parse video information.'));
        }
      }
      reject(new Error(stderrData || 'Could not retrieve video information.'));
    });

    proc.on('error', err => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

function streamVideoFile(req, res, filePath, isDownload, customFilename) {
  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  const downloadFilename = customFilename || `clip-${Date.now()}.mp4`;
  const range = req.headers.range;

  setCors(res);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');

  if (isDownload) {
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

    if (start >= totalSize || end >= totalSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
      return res.end();
    }

    const chunksize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': chunksize
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => {});
    res.on('close', () => { try { stream.destroy(); } catch {} });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': totalSize
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {});
    res.on('close', () => { try { stream.destroy(); } catch {} });
    stream.pipe(res);
  }
}

// Full video downloader for persistent cache & direct download
async function downloadFullVideo(targetUrl, outPath, meta) {
  const directVideoUrl = (meta && (meta.playUrl || meta.directUrl)) || '';
  if (directVideoUrl) {
    try {
      const vidRes = await fetch(directVideoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          ...(meta.playUrl ? { 'Referer': 'https://www.tiktok.com/' } : {})
        },
        signal: AbortSignal.timeout(30000)
      });
      if (vidRes.ok) {
        const fileStream = fs.createWriteStream(outPath);
        await new Promise((resolve, reject) => {
          Readable.fromWeb(vidRes.body).pipe(fileStream);
          fileStream.on('finish', resolve);
          fileStream.on('error', reject);
        });
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
          return outPath;
        }
      }
    } catch (e) {
      console.warn('Direct stream fetch failed, falling back to yt-dlp:', e.message);
    }
  }

  const runner = getYtDlpRunner();
  const args = [
    ...runner.baseArgs,
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--extractor-retries', '2',
    '--socket-timeout', '20',
    '-f', 'mp4/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outPath,
    '--', targetUrl
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(runner.cmd, args, { env: process.env });
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 60000);
    proc.on('close', code => {
      clearTimeout(killTimer);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
        return resolve(outPath);
      }
      reject(new Error('Video download processing failed.'));
    });
    proc.on('error', err => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. FAST INFO ENDPOINT (Instant metadata in 1-2s)
  if (u.pathname === '/api/info') {
    const clientIp = req.socket.remoteAddress;
    if (limited(clientIp)) {
      return json(res, 429, { error: 'Too many requests. Please wait a minute.' });
    }

    const rawUrl = u.searchParams.get('url');
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      return json(res, 400, { error: 'Invalid link. Please provide a full URL.' });
    }

    if (!/^https?:$/.test(target.protocol) || !HOSTS.test(target.hostname)) {
      return json(res, 400, { error: 'Only TikTok and Instagram links are supported.' });
    }

    const isTikTok = /(tiktok\.com)$/i.test(target.hostname);
    const platform = u.searchParams.get('platform') || (isTikTok ? 'tiktok' : 'instagram');

    try {
      const meta = await resolveVideoMeta(target.href, platform);
      return json(res, 200, {
        ok: true,
        platform: meta.platform,
        title: meta.title,
        author: meta.author,
        cover: meta.cover,
        duration: meta.duration
      });
    } catch (e) {
      console.error('Info resolution error:', e.message);
      return json(res, 500, { error: e.message || 'Could not fetch video info. Make sure the post is public.' });
    }
  }

  // 2. STREAMING ENDPOINT (Progressive streaming directly to HTML5 <video>)
  if (u.pathname === '/api/stream') {
    const rawUrl = u.searchParams.get('url');
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      return json(res, 400, { error: 'Invalid link.' });
    }

    if (!/^https?:$/.test(target.protocol) || !HOSTS.test(target.hostname)) {
      return json(res, 400, { error: 'Unsupported URL.' });
    }

    // Check if video is already cached on disk
    const cached = videoCache.get(target.href);
    if (cached && fs.existsSync(cached.filePath)) {
      return streamVideoFile(req, res, cached.filePath, false);
    }

    const isTikTok = /(tiktok\.com)$/i.test(target.hostname);
    const platform = u.searchParams.get('platform') || (isTikTok ? 'tiktok' : 'instagram');

    try {
      const meta = await resolveVideoMeta(target.href, platform);
      const streamTargetUrl = meta.playUrl || meta.directUrl;

      // If we have a direct stream URL (from TikTok API or yt-dlp json), proxy stream it instantly!
      if (streamTargetUrl) {
        const range = req.headers.range;
        const forwardHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        };
        if (isTikTok) forwardHeaders['Referer'] = 'https://www.tiktok.com/';
        if (range) forwardHeaders['Range'] = range;

        const vidRes = await fetch(streamTargetUrl, {
          headers: forwardHeaders
        });

        if (vidRes.ok || vidRes.status === 206) {
          setCors(res);
          res.setHeader('Content-Type', vidRes.headers.get('content-type') || 'video/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          if (vidRes.headers.get('content-length')) res.setHeader('Content-Length', vidRes.headers.get('content-length'));
          if (vidRes.headers.get('content-range')) res.setHeader('Content-Range', vidRes.headers.get('content-range'));
          res.writeHead(vidRes.status);

          const nodeStream = Readable.fromWeb(vidRes.body);
          nodeStream.on('error', () => {});
          res.on('close', () => {
            try { nodeStream.destroy(); } catch {}
          });
          return nodeStream.pipe(res);
        }
      }

      // Fallback: download to temp and stream
      const out = path.join(os.tmpdir(), `${platform}-${Date.now()}.mp4`);
      await downloadFullVideo(target.href, out, meta);
      videoCache.set(target.href, { filePath: out, size: fs.statSync(out).size, timestamp: Date.now() });
      return streamVideoFile(req, res, out, false);
    } catch (e) {
      console.error('Streaming error:', e.message);
      return json(res, 502, { error: 'Could not stream video. Post may be private or unavailable.' });
    }
  }

  // 3. DOWNLOAD ENDPOINT (Full HD file attachment)
  if (u.pathname === '/api/download') {
    const rawUrl = u.searchParams.get('url');
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      return json(res, 400, { error: 'Invalid link.' });
    }

    if (!/^https?:$/.test(target.protocol) || !HOSTS.test(target.hostname)) {
      return json(res, 400, { error: 'Unsupported URL.' });
    }

    const isTikTok = /(tiktok\.com)$/i.test(target.hostname);
    const platform = u.searchParams.get('platform') || (isTikTok ? 'tiktok' : 'instagram');
    const downloadFilename = `${platform}-${Date.now()}.mp4`;

    // Check if already in cache
    const cached = videoCache.get(target.href);
    if (cached && fs.existsSync(cached.filePath)) {
      return streamVideoFile(req, res, cached.filePath, true, downloadFilename);
    }

    try {
      const meta = await resolveVideoMeta(target.href, platform).catch(() => ({}));
      const out = path.join(os.tmpdir(), `${platform}-${Date.now()}.mp4`);
      await downloadFullVideo(target.href, out, meta);
      videoCache.set(target.href, { filePath: out, size: fs.statSync(out).size, timestamp: Date.now() });
      return streamVideoFile(req, res, out, true, downloadFilename);
    } catch (e) {
      console.error('Download error:', e.message);
      return json(res, 502, { error: 'Could not download video. Make sure the post is public.' });
    }
  }

  // 4. STATIC ASSETS
  let reqPath = u.pathname === '/' ? '/index.html' : u.pathname;
  let file = path.join(__dirname, 'public', path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, ''));

  if (!fs.existsSync(file)) {
    file = path.join(__dirname, path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, ''));
  }

  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(file).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    setCors(res);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Clip Saver running on http://0.0.0.0:${PORT}`);
});
