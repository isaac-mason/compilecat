// Build every published target locally (proven to work end-to-end on macOS),
// then assemble them into the npm/<triple>/ packages — ready to publish without
// CI. Requires: zig (`brew install zig`) for the linux/windows cross-compiles,
// and the rust targets (rustup adds them on first build).
//
//   pnpm build:all
//
// Afterward: `cd rust/crates/compilecat_napi && napi prepublish -t npm` publishes
// the @compilecat/core-* packages; `pnpm build:ts && pnpm build:loader && npm
// publish` publishes the main package. (CI does the same on a tag — this is the
// from-your-mac alternative.)

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAPI = join(dirname(fileURLToPath(import.meta.url)), '..', 'rust', 'crates', 'compilecat_napi');

// `cross: true` → needs zig/cargo-xwin (linux + windows-msvc). darwin + wasm
// build directly. (Verified: all six build from an arm64 mac.)
const TARGETS = [
    { triple: 'aarch64-apple-darwin' },
    { triple: 'x86_64-apple-darwin' },
    { triple: 'x86_64-unknown-linux-gnu', cross: true },
    { triple: 'aarch64-unknown-linux-gnu', cross: true },
    { triple: 'x86_64-pc-windows-msvc', cross: true },
    { triple: 'wasm32-wasip1-threads' },
];

const run = (cmd) => execSync(cmd, { cwd: NAPI, stdio: 'inherit' });

for (const { triple, cross } of TARGETS) {
    console.log(`\n=== building ${triple} ===`);
    run(`pnpm exec napi build --platform --release --target ${triple}${cross ? ' --cross-compile' : ''}`);
}

// `napi artifacts` collects from an `artifacts/` dir (the CI download layout);
// for a local build, stage the freshly-built binaries there, minus the debug wasm.
console.log('\n=== assembling into npm/<triple>/ ===');
const staging = join(NAPI, 'artifacts', 'local');
rmSync(join(NAPI, 'artifacts'), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const f of readdirSync(NAPI)) {
    const isBinary = (/\.(node|wasm)$/.test(f) && !f.includes('.debug.')) || /^(compilecat\.wasi|wasi-worker)/.test(f);
    if (isBinary) copyFileSync(join(NAPI, f), join(staging, f));
}
run('pnpm exec napi artifacts');

console.log('\nAll platforms built + assembled. `napi prepublish -t npm` to publish the binaries.');
