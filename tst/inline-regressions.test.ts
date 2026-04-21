import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';
import { applyInline } from '../src/plugin/transforms/inline';
import { generate } from '../src/plugin/util/babel';

function run(code: string, withComments = false): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyInline(ast, '/virtual/test.ts', { effects: Effects.init() });
	return generate(ast, { retainLines: false, comments: withComments }).code.trim();
}

describe('plugin-alt/transforms/inline — regression guards', () => {
	it('expression-position multi-stmt body: hoists pure prelude and splices return expr', () => {
		// Mirrors the dbvt `proximity(o, a) < proximity(o, b)` case. `proximity`
		// has `const dx; const dy; const dz; return Math.abs(...) + ...`, so it
		// can't fit `inlineSimpleReturn`. The expression-position path should
		// hoist the three consts above the enclosing `const child = ...` and
		// replace each call with the return expression.
		const input = `
			/* @cc-inline */
			function proximity(a, b) {
				const dx = a[0] - b[0];
				const dy = a[1] - b[1];
				const dz = a[2] - b[2];
				return Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
			}
			export function pick(o, a, b) {
				const child = proximity(o, a) < proximity(o, b) ? 0 : 1;
				return child;
			}
		`;
		const out = run(input);
		// Neither call survives — both fully inlined.
		const pickBody = out.slice(out.indexOf('function pick'));
		expect(pickBody).not.toMatch(/\bproximity\(/);
		// Six hoisted consts (3 per call) plus the spliced return expressions
		// end up inside the pick body.
		expect((pickBody.match(/const dx_\d+/g) ?? []).length).toBe(2);
		expect((pickBody.match(/const dy_\d+/g) ?? []).length).toBe(2);
		expect((pickBody.match(/const dz_\d+/g) ?? []).length).toBe(2);
	});

	it('mutated param via AssignmentExpression: hoisted to a `let` temp', () => {
		// Mirrors `setAxisAngle(out, axis, rad) { rad *= 0.5; ... }` — the
		// callee mutates its own param. We must hoist the arg into a `let` and
		// rename every reference, including the assignment LHS.
		const input = `
			/* @cc-inline */
			function scaleInPlace(dst, v, rad) {
				rad *= 0.5;
				dst[0] = v[0] * rad;
				dst[1] = v[1] * rad;
			}
			export function work(out, src, angle) {
				scaleInPlace(out, src, angle);
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		// Original `rad` identifier must NOT leak into the caller scope.
		expect(workBody).not.toMatch(/\brad\b/);
		// The caller's `angle` local must not be mutated directly — we hoisted
		// a `let _arg_rad_...` and the `*= 0.5` lands on it.
		expect(workBody).toMatch(/let _arg_rad_\d+\s*=\s*angle/);
		expect(workBody).toMatch(/_arg_rad_\d+\s*\*=\s*0\.5/);
	});

	it('mutated param via UpdateExpression: hoisted to a `let` temp', () => {
		const input = `
			/* @cc-inline */
			function shiftAndStore(dst, i) {
				i++;
				dst[i] = 1;
			}
			export function work(out, start) {
				shiftAndStore(out, start);
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		// `i` shouldn't appear; the caller's `start` shouldn't get `++` applied.
		expect(workBody).not.toMatch(/\bi\+\+/);
		expect(workBody).not.toMatch(/\bstart\+\+/);
		expect(workBody).toMatch(/let _arg_i_\d+\s*=\s*start/);
		expect(workBody).toMatch(/_arg_i_\d+\+\+/);
	});

	it('pure-init check accepts nested member-chain computed keys', () => {
		// Mirrors `indexof(dbvt, nodeIndex)` where body has
		// `const parent = dbvt.nodes[node.parent];` — computed key is a
		// MemberExpression, which our pure-init walker must recurse into.
		const input = `
			/* @cc-inline */
			function indexof(dbvt, nodeIndex) {
				const node = dbvt.nodes[nodeIndex];
				const parent = dbvt.nodes[node.parent];
				return parent.right === nodeIndex ? 1 : 0;
			}
			export function work(dbvt, root) {
				if (indexof(dbvt, root) === 0) {
					return 'left';
				}
				return 'right';
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\bindexof\(/);
		// The two consts and the ternary come through.
		expect(workBody).toMatch(/const node_\d+\s*=\s*dbvt\.nodes\[root\]/);
		expect(workBody).toMatch(/const parent_\d+\s*=\s*dbvt\.nodes\[node_\d+\.parent\]/);
	});

	it('breadcrumbs reflect real callsite args, not nested param names', () => {
		// When `select` calls `proximity(o, a)` internally and `select` itself
		// is inlined at a consumer callsite, the `@inlined` breadcrumb must
		// record the consumer's call (`select(X, Y, Z)`) — NOT the synthetic
		// inner `proximity(o, a)` that never existed in the final source.
		const input = `
			/* @cc-inline */
			function proximity(a, b) {
				const dx = a[0] - b[0];
				return Math.abs(dx);
			}
			/* @cc-inline */
			function select(o, a, b) {
				return proximity(o, a) < proximity(o, b) ? 0 : 1;
			}
			export function work(origin, left, right) {
				const child = select(origin, left, right);
				return child;
			}
		`;
		const out = run(input, /*withComments=*/ true);
		// We want the outer breadcrumb with the real callsite:
		expect(out).toMatch(/@inlined select\(origin, left, right\)/);
		// And we explicitly do NOT want `proximity(o, a)` or `proximity(o, b)`
		// appearing — those were pre-inline artifacts.
		expect(out).not.toMatch(/@inlined proximity\(o,\s*a\)/);
		expect(out).not.toMatch(/@inlined proximity\(o,\s*b\)/);
	});

	it('sweeps residual @cc-inline markers from the final AST, including trailing-on-prev', () => {
		// Babel parks a block comment that sits between two statements as a
		// trailing comment on the previous one, not a leading on the next.
		// Per-callsite leading-only stripping misses that case; the global
		// sweep picks it up.
		const input = `
			/* @cc-inline */
			function helper(x) { return x + 1; }
			export function work(v) {
				const preceding = 1;
				/* @cc-inline */
				const result = helper(v);
				return result;
			}
		`;
		const out = run(input, /*withComments=*/ true);
		// No raw @cc-inline / @cc-inline-body markers should survive. Only the
		// `@inlined <sig>` breadcrumb format is allowed.
		expect(out).not.toMatch(/\/\*\s*@cc-inline\s*\*\//);
		expect(out).not.toMatch(/\/\*\s*@cc-inline-body\s*\*\//);
	});
});
