// Run: node server.js (needs Node 18+ and yt-dlp + ffmpeg)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const HOSTS = /(^|\.)(tiktok\.com|instagram\.com|instagr\.am)$/i;
const hits = new Map(); // simple per-IP rate limit: 40 requests / 10 min

// Video cache for instant preview-to-download transitions
const videoCache = new Map(); // url -> { filePath, size, timestamp }

// Cleanup cache older than 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [url, item] of videoCache.entries()) {
    if (now - item.timestamp > 600000) {
      if (fs.existsSync(item.filePath)) {
        fs.unlink(item.filePath, () => {});
      }
      videoCache.delete(url);
    }
  }
}, 60000);

// Add common Python Scripts paths to PATH so yt-dlp and ffmpeg are always found
const extraPaths = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'Scripts'),
  path.join(process.env.APPDATA || '', 'Python', 'Python313', 'Scripts'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts'),
  path.join(__dirname, 'bin')
].filter(p => fs.existsSync(p));

if (extraPaths.length > 0) {
  process.env.PATH = extraPaths.join(path.delimiter) + path.delimiter + (process.env.PATH || '');
}

function getYtDlpRunner() {
  const candidates = [
    { cmd: 'yt-dlp', baseArgs: [] },
    { cmd: 'python3', baseArgs: ['-m', 'yt_dlp'] },
    { cmd: 'python', baseArgs: ['-m', 'yt_dlp'] },
    { cmd: 'py', baseArgs: ['-m', 'yt_dlp'] }
  ];

  for (const item of candidates) {
    try {
      const res = spawnSync(item.cmd, [...item.baseArgs, '--version'], { encoding: 'utf8', env: process.env });
      if (!res.error && res.status === 0) {
        console.log(`Using yt-dlp runner: ${item.cmd} ${item.baseArgs.join(' ')} (version: ${res.stdout.trim()})`);
        return item;
      }
    } catch {}
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
  return list.length > 40;
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

// Fast direct downloader for TikTok videos
async function downloadTikTokDirect(url, outPath) {
  const apiUrl = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url);
  const apiRes = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!apiRes.ok) throw new Error(`API HTTP ${apiRes.status}`);
  const data = await apiRes.json();
  
  if (data && data.code === 0 && data.data && (data.data.play || data.data.wmplay)) {
    const videoUrl = data.data.play || data.data.wmplay;
    const vidRes = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Referer': 'https://www.tiktok.com/'
      },
      signal: AbortSignal.timeout(45000)
    });
    
    if (!vidRes.ok) throw new Error(`Video fetch HTTP ${vidRes.status}`);
    const buf = Buffer.from(await vidRes.arrayBuffer());
    if (buf.length < 1000) throw new Error('Video buffer too small');
    fs.writeFileSync(outPath, buf);
    return {
      title: data.data.title || 'TikTok Video',
      author: data.data.author?.nickname || data.data.author?.unique_id || '',
      cover: data.data.cover || data.data.origin_cover || ''
    };
  } else {
    throw new Error(data?.msg || 'Could not parse TikTok link.');
  }
}

function streamVideoFile(req, res, filePath, isDownload) {
  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  const downloadFilename = `video-${Date.now()}.mp4`;
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
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': totalSize
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (u.pathname === '/api/download' || u.pathname === '/api/stream') {
    const clientIp = req.socket.remoteAddress;
    if (limited(clientIp)) {
      return json(res, 429, { error: 'Too many requests. Try again later.' });
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

    const isPreview = u.searchParams.get('preview') === '1' || u.pathname === '/api/stream';
    const isDownload = !isPreview && (u.searchParams.get('download') === '1' || u.pathname === '/api/download');

    // Check if video is already cached in temp
    const cached = videoCache.get(target.href);
    if (cached && fs.existsSync(cached.filePath)) {
      return streamVideoFile(req, res, cached.filePath, isDownload);
    }

    const isTikTok = /(tiktok\.com)$/i.test(target.hostname);
    const out = path.join(os.tmpdir(), `clip-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

    // For TikTok, direct fetch provides fast, anti-bot-resistant downloads
    if (isTikTok) {
      try {
        console.log('Downloading TikTok video via direct API for:', target.href);
        await downloadTikTokDirect(target.href, out);
        if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
          videoCache.set(target.href, { filePath: out, size: fs.statSync(out).size, timestamp: Date.now() });
          return streamVideoFile(req, res, out, isDownload);
        }
      } catch (directErr) {
        console.warn('Direct TikTok download failed, falling back to yt-dlp:', directErr.message);
      }
    }

    // Default & Fallback: Use yt-dlp
    const runner = getYtDlpRunner();
    const args = [
      ...runner.baseArgs,
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--extractor-retries', '3',
      '--socket-timeout', '30',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      '-f', 'mp4/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', out,
      '--', target.href
    ];

    let responded = false;
    let stderrData = '';

    const p = spawn(runner.cmd, args, { env: process.env });
    const killTimeout = setTimeout(() => {
      p.kill('SIGKILL');
    }, 90000);

    if (p.stderr) {
      p.stderr.on('data', chunk => {
        stderrData += chunk.toString();
      });
    }

    p.on('error', async err => {
      clearTimeout(killTimeout);
      if (responded || res.headersSent) return;
      responded = true;
      console.error('yt-dlp execution error:', err.message);
      json(res, 500, { error: 'Could not process video on the server.' });
    });

    p.on('close', async code => {
      clearTimeout(killTimeout);
      if (responded || res.headersSent) return;
      responded = true;

      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000) {
        videoCache.set(target.href, { filePath: out, size: fs.statSync(out).size, timestamp: Date.now() });
        return streamVideoFile(req, res, out, isDownload);
      }

      console.error(`yt-dlp exited with code ${code}. Stderr:\n${stderrData}`);
      let clientMsg = 'Could not download that video. Make sure the post is public and accessible.';
      if (stderrData.includes('Private') || stderrData.includes('Login required') || stderrData.includes('login')) {
        clientMsg = 'This post is private or requires login.';
      } else if (stderrData.includes('Video unavailable') || stderrData.includes('not found') || stderrData.includes('404')) {
        clientMsg = 'Video not found or has been deleted.';
      }
      return json(res, 502, { error: clientMsg });
    });
    return;
  }

  // Static files handling
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

server.listen(PORT, () => {
  console.log(`Clip Saver running on http://localhost:${PORT}`);
});
