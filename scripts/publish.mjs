// Publish everything in one shot: the 6 platform binary packages, then the
// wrapper. Run AFTER `pnpm release` (builds + assembles them) and once you're
// `npm login`'d with the `@compilecat` org created.
//
//   pnpm release:publish
//
// Order matters: platform packages first, so the wrapper's optionalDependencies
// already resolve on the registry when consumers install it.

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = join(ROOT, 'rust/crates/compilecat_napi/npm');
const WASM_PKG = join(ROOT, 'rust/crates/compilecat_wasm/pkg');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Is this exact name@version already on the registry? (`npm view` exits non-zero
// when not found.) Lets a re-run after a partial publish skip what already went
// out, instead of dying on "cannot publish over the previously published version".
function onRegistry(name, v) {
    try {
        const out = execSync(`npm view ${name}@${v} version`, {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.toString().trim() === v;
    } catch {
        return false;
    }
}

const run = (dir) => {
    const { name, version: v } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (onRegistry(name, v)) {
        console.log(`  ${name}@${v} already published — skipping`);
        return;
    }
    execSync('npm publish --access public', { cwd: dir, stdio: 'inherit' });
};

console.log(`publishing compilecat ${version} + @compilecat/core-* …\n`);

// 1. platform binary packages (@compilecat/core-<triple>)
for (const triple of readdirSync(NPM)) {
    const dir = join(NPM, triple);
    if (!statSync(dir).isDirectory()) continue;
    console.log(`=== @compilecat/core-${triple} ===`);
    run(dir);
}

// 2. the wasm binary package (@compilecat/wasm). `build:wasm` sets its version
// from root, but re-sync here so a publish always ships it at the wrapper's
// version even if build:wasm last ran against an older root (the binary itself is
// version-agnostic). This is what `version:all` can't reach — pkg/ is generated.
const wasmPkgPath = join(WASM_PKG, 'package.json');
const wasmPkg = JSON.parse(readFileSync(wasmPkgPath, 'utf8'));
if (wasmPkg.version !== version) {
    wasmPkg.version = version;
    writeFileSync(wasmPkgPath, `${JSON.stringify(wasmPkg, null, 2)}\n`);
    console.log(`synced @compilecat/wasm → ${version}`);
}
console.log('=== @compilecat/wasm ===');
run(WASM_PKG);

// 3. the wrapper (compilecat) — optional-deps now resolvable
console.log('=== compilecat ===');
run(ROOT);

console.log(`\n✓ published ${version}.`);
