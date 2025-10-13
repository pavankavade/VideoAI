const fs = require('fs');
const path = require('path');

// Use direct node_modules paths to avoid issues with ESM exports
const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const CORE_UMD = path.join(NM, '@ffmpeg', 'core', 'dist', 'umd');
const FFMPEG_UMD = path.join(NM, '@ffmpeg', 'ffmpeg', 'dist', 'umd');
const VENDOR_PATH = path.join(ROOT, 'static', 'vendor', 'ffmpeg');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${path.basename(src)} -> ${dest}`);
    return true;
  }
  console.warn(`Missing: ${src}`);
  return false;
}

try {
  ensureDir(VENDOR_PATH);
  // Copy core files
  copyIfExists(path.join(CORE_UMD, 'ffmpeg-core.js'), path.join(VENDOR_PATH, 'ffmpeg-core.js'));
  copyIfExists(path.join(CORE_UMD, 'ffmpeg-core.wasm'), path.join(VENDOR_PATH, 'ffmpeg-core.wasm'));
  // Worker is optional but try to copy
  copyIfExists(path.join(CORE_UMD, 'ffmpeg-core.worker.js'), path.join(VENDOR_PATH, 'ffmpeg-core.worker.js'));
  // Copy UMD wrapper
  const okMin = copyIfExists(path.join(FFMPEG_UMD, 'ffmpeg.min.js'), path.join(VENDOR_PATH, 'ffmpeg.min.js'));
  if (!okMin) {
    // fallback to non-minified
    copyIfExists(path.join(FFMPEG_UMD, 'ffmpeg.js'), path.join(VENDOR_PATH, 'ffmpeg.min.js'));
  }
  // Copy worker chunk(s) like 814.ffmpeg.js required by the UMD
  try {
    const entries = fs.readdirSync(FFMPEG_UMD);
    entries
      .filter(name => /\.ffmpeg\.js$/.test(name))
      .forEach(name => {
        copyIfExists(path.join(FFMPEG_UMD, name), path.join(VENDOR_PATH, name));
      });
  } catch (e) {
    console.warn('Unable to scan UMD directory for worker chunks:', e.message);
  }
  console.log('FFmpeg assets copy completed.');
} catch (err) {
  console.error('Error copying FFmpeg assets:', err);
}
