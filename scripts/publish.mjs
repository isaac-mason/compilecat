// Publish everything in one shot: the 6 platform binary packages, then the
// wrapper. Run AFTER `pnpm release` (builds + assembles them) and once you're
// `npm login`'d with the `@compilecat` org created.
//
//   pnpm release:publish
//
// Order matters: platform packages first, so the wrapper's optionalDependencies
// already resolve on the registry when consumers install it.

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = join(ROOT, 'rust/crates/compilecat_napi/npm');
const WASM_PKG = join(ROOT, 'rust/crates/compilecat_wasm/pkg');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const run = (dir) => execSync('npm publish --access public', { cwd: dir, stdio: 'inherit' });

console.log(`publishing compilecat ${version} + @compilecat/core-* …\n`);

// 1. platform binary packages (@compilecat/core-<triple>)
for (const triple of readdirSync(NPM)) {
    const dir = join(NPM, triple);
    if (!statSync(dir).isDirectory()) continue;
    console.log(`=== @compilecat/core-${triple} ===`);
    run(dir);
}

// 2. the wasm binary package (@compilecat/wasm) — built + patched by build:wasm.
console.log('=== @compilecat/wasm ===');
run(WASM_PKG);

// 3. the wrapper (compilecat) — optional-deps now resolvable
console.log('=== compilecat ===');
run(ROOT);

console.log(`\n✓ published ${version}.`);
