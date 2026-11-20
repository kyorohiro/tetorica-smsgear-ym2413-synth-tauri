import { mkdtempSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

// Keep desktop outputs only. The source is the Tetorica SMSGEAR Synth icon.
const temporary = mkdtempSync(join(tmpdir(), 'tetorica-icons-'));
try {
  execFileSync(process.execPath,
    [require.resolve('@tauri-apps/cli/tauri.js'), 'icon', 'assets/app-icon.png', '--output', temporary], { stdio: 'inherit' });
  mkdirSync('src-tauri/icons', { recursive: true });
  for (const name of ['icon.png', 'icon.icns', 'icon.ico', '32x32.png', '128x128.png', '128x128@2x.png']) {
    copyFileSync(join(temporary, name), join('src-tauri/icons', name));
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
