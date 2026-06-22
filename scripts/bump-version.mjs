// One-shot version bump across every package that must stay in lockstep:
//   • compilecat (root)            — version + the @compilecat/* optionalDependency pins
//                                    (@compilecat/core-* and @compilecat/wasm)
//   • compilecat-napi (build pkg)  — version
//   • @compilecat/core-<triple>    — each platform manifest's version
//   (@compilecat/wasm's own manifest is set by build:wasm from the root version —
//    its pkg/ is generated, not committed.)
//
//   pnpm version:all 0.2.0
//
// Then commit, `git tag v0.2.0`, push → the release workflow publishes.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    console.error('usage: pnpm version:all <semver>   e.g. pnpm version:all 0.2.0');
    process.exit(1);
}

/** Edit one package.json in place, preserving its indentation (root uses tabs,
 *  the napi/platform manifests use 2 spaces). */
function patch(relPath, mutate) {
    const file = join(ROOT, relPath);
    const raw = readFileSync(file, 'utf8');
    const indent = raw.includes('\n\t') ? '\t' : 2;
    const json = JSON.parse(raw);
    mutate(json);
    writeFileSync(file, `${JSON.stringify(json, null, indent)}\n`);
    console.log(`  ${relPath}`);
}

console.log(`bumping → ${version}`);

// root: version + the exact-pinned optionalDependencies (@compilecat/core-* +
// @compilecat/wasm — all lockstep with the root version)
patch('package.json', (j) => {
    j.version = version;
    for (const k of Object.keys(j.optionalDependencies ?? {})) {
        if (k.startsWith('@compilecat/')) j.optionalDependencies[k] = version;
    }
});

// the napi build package (private, not published — but kept in sync)
patch('rust/crates/compilecat_napi/package.json', (j) => {
    j.version = version;
});

// every generated platform manifest
const npmDir = 'rust/crates/compilecat_napi/npm';
for (const triple of readdirSync(join(ROOT, npmDir))) {
    patch(join(npmDir, triple, 'package.json'), (j) => {
        j.version = version;
    });
}

console.log(`done — commit, \`git tag v${version}\`, push to publish.`);
