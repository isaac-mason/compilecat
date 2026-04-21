import { describe, expect, it } from 'vitest';
import { transform as altTransform } from '../src/plugin/transform';

describe('plugin-alt scaffold', () => {
	it('passes unannotated code through unchanged', () => {
		const input = 'const x = 1 + 2;';
		const { code } = altTransform(input, 'test.ts');
		expect(code.trim()).toBe(input);
	});

	it('returns undefined sourcemap when not provided', () => {
		const result = altTransform('const x = 1;', 'test.ts');
		expect(result.map).toBeUndefined();
	});
});
