// Download standalone yt-dlp binary during npm install (Linux/macOS/Windows)
const fs = require('fs');
const path = require('path');

async function setup() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const binDir = path.join(__dirname, 'bin');
  const binPath = path.join(binDir, binName);
  const minExpectedSize = isWin ? 10000000 : 25000000;

  if (fs.existsSync(binPath) && fs.statSync(binPath).size > minExpectedSize) {
    console.log(`[setup-bin] Standalone yt-dlp already present at ${binPath} (${(fs.statSync(binPath).size / (1024 * 1024)).toFixed(2)} MB)`);
    return;
  }

  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  // yt-dlp_linux is the self-contained PyInstaller standalone binary (with embedded Python)
  // whereas 'yt-dlp' is only a python script that throws "env: python3: No such file or directory"
  const url = isWin
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

  console.log(`[setup-bin] Downloading standalone self-contained binary for ${process.platform} from: ${url}`);
  
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(binPath, buf);
    if (!isWin) {
      fs.chmodSync(binPath, 0o755);
    }
    console.log(`[setup-bin] Successfully installed self-contained yt-dlp (${(buf.length / (1024 * 1024)).toFixed(2)} MB) to ${binPath}`);
  } catch (err) {
    console.warn('[setup-bin] Warning: Automatic download failed:', err.message);
  }
}

setup();
