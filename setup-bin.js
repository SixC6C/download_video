// Download standalone yt-dlp binary during npm install (Linux/macOS/Windows)
const fs = require('fs');
const path = require('path');

async function setup() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const binDir = path.join(__dirname, 'bin');
  const binPath = path.join(binDir, binName);

  if (fs.existsSync(binPath) && fs.statSync(binPath).size > 1000000) {
    console.log(`[setup-bin] yt-dlp already present at ${binPath}`);
    return;
  }

  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const url = isWin
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  console.log(`[setup-bin] Downloading standalone yt-dlp binary for ${process.platform} from: ${url}`);
  
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(binPath, buf);
    if (!isWin) {
      fs.chmodSync(binPath, 0o755);
    }
    console.log(`[setup-bin] Successfully installed yt-dlp (${(buf.length / (1024 * 1024)).toFixed(2)} MB) to ${binPath}`);
  } catch (err) {
    console.warn('[setup-bin] Warning: Automatic download failed:', err.message);
  }
}

setup();
