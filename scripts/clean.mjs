// Remove all build outputs so a release build is fresh. Keeps the committed
// loader (index.js/index.d.ts) and the platform-package manifests
// (npm/<triple>/package.json + README); only deletes generated binaries.
//
//   pnpm clean

import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAPI = join(ROOT, 'rust/crates/compilecat_napi');

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
rmSync(join(NAPI, 'artifacts'), { recursive: true, force: true });

// Generated binaries/wrappers in the crate root (keep index.js / index.d.ts).
const isBuilt = (f) => /\.(node|wasm)$/.test(f) || /^(compilecat\.wasi|wasi-worker|browser)/.test(f);
for (const f of readdirSync(NAPI)) {
    if (isBuilt(f)) rmSync(join(NAPI, f), { force: true });
}

// Binaries assembled into each platform package (keep package.json + README.md).
const npm = join(NAPI, 'npm');
try {
    for (const triple of readdirSync(npm)) {
        const dir = join(npm, triple);
        if (!statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir)) {
            if (f !== 'package.json' && f !== 'README.md') rmSync(join(dir, f), { force: true });
        }
    }
} catch {
    /* npm/ dirs not generated yet — nothing to clean */
}

console.log('cleaned: dist, build artifacts, platform binaries (kept loader + manifests)');
