import _generate from '@babel/generator';
export declare const traverse: {
    <S>(parent: import("@babel/types").Node, opts: import("@babel/traverse").TraverseOptions<S>, scope: import("@babel/traverse").Scope | undefined, state: S, parentPath?: import("@babel/traverse").NodePath): void;
    (parent: import("@babel/types").Node, opts?: import("@babel/traverse").TraverseOptions, scope?: import("@babel/traverse").Scope, state?: any, parentPath?: import("@babel/traverse").NodePath): void;
    visitors: typeof import("@babel/traverse").visitors;
    verify: typeof import("@babel/traverse").visitors.verify;
    explode: typeof import("@babel/traverse").visitors.explode;
    cheap: (node: import("@babel/types").Node, enter: (node: import("@babel/types").Node) => void) => void;
    node: (node: import("@babel/types").Node, opts: import("@babel/traverse").TraverseOptions, scope?: import("@babel/traverse").Scope, state?: any, path?: import("@babel/traverse").NodePath, skipKeys?: Record<string, boolean>) => void;
    clearNode: (node: import("@babel/types").Node, opts?: import("@babel/types").RemovePropertiesOptions) => void;
    removeProperties: (tree: import("@babel/types").Node, opts?: import("@babel/types").RemovePropertiesOptions) => import("@babel/types").Node;
    hasType: (tree: import("@babel/types").Node, type: import("@babel/types").Node["type"], denylistTypes?: string[]) => boolean;
    cache: typeof import("@babel/traverse").cache;
};
export declare const generate: typeof _generate;
