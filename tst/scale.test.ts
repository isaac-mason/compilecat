// Scale / no-blowup regression net — the check a downstream crashcat build would
// otherwise give us for free. We assemble ONE large module: a deep `@flatten`
// chain (host → h1 → h2 → … → hN, N≈20, so the inliner must resolve a long
// transitive chain to a fixpoint) plus many verbatim mathcat corpus functions
// concatenated and exported. We compile it ONCE and assert three properties:
//
//   (a) the output still PARSES as valid JS (`new Function(toJs(out))` throws on
//       any structural corruption a miscompile might introduce);
//   (b) the deep chain fully INLINED — the host body has no residual `hK(` call
//       (a spot-check that transitive inlining didn't silently give up and leave
//       a now-free/undefined helper reference behind); and
//   (c) output size is within a BOUNDED multiple of input size — the guard against
//       runaway inlining blowup. We pick ≤ 20× as a generous-but-finite ceiling:
//       the real optimizer here runs well under 3×, so 20× leaves ample headroom
//       for formatting/temp expansion while still tripping on exponential blowup
//       (e.g. a chain that duplicated each level into every call site).

import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';

import { createCompiler } from '../src/compiler';
import { MATHCAT_CORPUS } from './fixtures/corpus/mathcat';

const compiler = createCompiler();

/** Strip TS → runnable JS, drop the ESM exports so `new Function` can parse it. */
function toJs(tsCode: string): string {
    return transformSync(tsCode, { loader: 'ts' }).code
        .replace(/\bexport\s*\{[^}]*\}\s*;?/g, '')
        .replace(/\bexport\s+/g, '');
}

/** A deep @flatten chain: host → h1 → … → hN, each a simple return-arithmetic
 *  helper (unique locals, no name reuse, so it never trips the pinned nested-
 *  inline collision bug). @flatten must inline the whole chain into `host`. */
function deepChain(n: number): { code: string; host: string } {
    const lines: string[] = [];
    // terminal helper
    lines.push(`function h${n}(a) { return a + ${n}; }`);
    for (let i = n - 1; i >= 1; i--) {
        lines.push(`function h${i}(a) { const c${i} = h${i + 1}(a * 2 - 1) + ${i}; return c${i} - ${i}; }`);
    }
    lines.push(`/* @flatten */ export function host(a) { return h1(a) + h1(a * 3); }`);
    return { code: lines.join('\n'), host: 'host' };
}

describe('scale / no-blowup net — large @flatten chain + corpus concat', () => {
    // Dedupe corpus by function name (many modules share `add`/`dot`/`scale`/…);
    // duplicate `export function` names would be a SyntaxError, so keep the first
    // of each name. Take a large slice to bulk up the module.
    const seen = new Set<string>();
    const uniqueCorpus = (MATHCAT_CORPUS as { fn: string; src: string }[]).filter((c) => {
        if (seen.has(c.fn)) return false;
        seen.add(c.fn);
        return true;
    });
    const CHAIN_N = 20;

    const { code: chain, host } = deepChain(CHAIN_N);
    // Annotate a spread of the corpus copies with @optimize so the compile does
    // real optimization at scale (not just carry the chain), then export the rest.
    const corpus = uniqueCorpus
        .map((c, i) => `${i % 3 === 0 ? '/* @optimize */ ' : ''}export ${c.src}`)
        .join('\n');
    const module = `${chain}\n${corpus}`;

    const out = compiler.compileChunk('scale.ts', module, {}).code;

    it('compiles to non-empty output', () => {
        expect(out.length).toBeGreaterThan(0);
    });

    it('(a) output parses as valid JS', () => {
        expect(() => {
            // biome-ignore lint/security/noGlobalEval: parsing compiled code under test
            new Function(toJs(out));
        }).not.toThrow();
    });

    it('(b) the deep @flatten chain fully inlined — no residual helper call in host', () => {
        const body = out.slice(out.indexOf(`function ${host}`));
        // no residual `h1(` … `h20(` calls survive in the host body
        for (let i = 1; i <= CHAIN_N; i++) {
            expect(body, `residual h${i}( in host`).not.toMatch(new RegExp(`\\bh${i}\\(`));
        }
        // and the now-inlined chain helpers should not be referenced elsewhere as
        // free identifiers either (spot-check a mid-chain and the terminal name).
        expect(out).not.toMatch(/\bh10\(/);
        expect(out).not.toMatch(new RegExp(`\\bh${CHAIN_N}\\(`));
    });

    it('(c) output size is within a bounded multiple of input (≤ 20×, no blowup)', () => {
        const ratio = out.length / module.length;
        // Generous-but-finite ceiling; real output runs well under this. If this
        // ever trips, suspect exponential inline duplication before raising it.
        expect(ratio, `output/input size ratio was ${ratio.toFixed(2)}×`).toBeLessThanOrEqual(20);
    });
});
