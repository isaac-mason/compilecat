export { unplugin, type Options } from './plugin/plugin';
export { unplugin as inlineFunctionsPlugin } from './plugin/plugin';
export { unplugin as default } from './plugin/plugin';
export { transform, type TransformOptions, type TransformResult, } from './plugin/transform';
export { createFileCache, type FileCache } from './plugin/analyses/fileindex';
export { defaultFileReader, type FileReader } from './plugin/analyses/resolve';
