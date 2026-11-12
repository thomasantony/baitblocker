// Zips dist/ into baitblocker-<version>.zip for a GitHub release. Run via `npm run package`.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const out = `baitblocker-${version}.zip`;
rmSync(out, { force: true });
execFileSync('zip', ['-qr', `../${out}`, '.'], { cwd: 'dist', stdio: 'inherit' });
console.log(`Wrote ${out}`);
