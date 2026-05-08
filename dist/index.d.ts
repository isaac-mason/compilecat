export { unplugin, type Options } from './plugin';
export { unplugin as default } from './plugin';
export { transform, type TransformOptions, type TransformResult } from './compiler/pipeline';
export { createFileCache, type FileCache } from './compiler/file-index';
export type { FileReader } from './compiler/resolve';
export { inlineFunctions, type InlineResult } from './compiler/inline-functions';
export { simplifyAll, simplifyFunction, type SimplifyStats } from './compiler/simplifier';
