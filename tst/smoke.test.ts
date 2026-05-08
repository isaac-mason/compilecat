import { describe, expect, it } from 'vitest';
import compilecatDefault, { unplugin } from '../src/index';

describe('compilecat smoke', () => {
    it('exports unplugin factory', () => {
        expect(unplugin).toBeDefined();
        expect(typeof unplugin.vite).toBe('function');
        expect(typeof unplugin.webpack).toBe('function');
        expect(typeof unplugin.rollup).toBe('function');
        expect(typeof unplugin.esbuild).toBe('function');
        expect(typeof unplugin.rolldown).toBe('function');
    });

    it('default export is the unplugin factory', () => {
        expect(compilecatDefault).toBe(unplugin);
    });

    it('vite plugin is wireable', () => {
        const plugin = unplugin.vite();
        expect(plugin).toBeDefined();
    });
});
