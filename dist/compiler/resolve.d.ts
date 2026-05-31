export type FileReader = (absolutePath: string) => string | null;
export declare const defaultFileReader: FileReader;
export declare function resolveRelativeImport(fromFile: string, specifier: string, reader?: FileReader): string | null;
export declare function resolveLibraryImport(fromFile: string, specifier: string): string | null;
export declare function resolveImportSource(fromFile: string, specifier: string, allowLibrary: boolean, reader?: FileReader): string | null;
