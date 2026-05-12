import { describe, expect, it } from 'vitest';
import compilecatDefault, { compilecat } from '../src/index';

describe('compilecat smoke', () => {
    it('exports a plugin factory', () => {
        expect(typeof compilecat).toBe('function');
    });

    it('default export is the plugin factory', () => {
        expect(compilecatDefault).toBe(compilecat);
    });

    it('produces a rollup-shaped plugin', () => {
        const plugin = compilecat();
        expect(plugin.name).toBe('compilecat');
        expect(typeof plugin.renderChunk).toBe('function');
    });
});
