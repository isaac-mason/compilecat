// wasm-pack regenerates `rust/crates/compilecat_wasm/pkg/package.json` from the
// crate on every build (name `compilecat_wasm`, version `0.0.0`). Repoint it to
// the published identity — `@compilecat/wasm` at the root package's version — so
// it publishes as the binary backing the `compilecat/wasm` wrapper. Run as the
// tail of `build:wasm`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pkgPath = join(ROOT, 'rust/crates/compilecat_wasm/pkg/package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = '@compilecat/wasm';
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`patched ${pkgPath} → @compilecat/wasm@${version}`);
