import type React from 'react';

type SyntaxHighlighterComponent = React.ComponentType<any>;

let prismSyntaxHighlighterPromise: Promise<SyntaxHighlighterComponent> | null = null;
let prismSyntaxHighlighterComponent: SyntaxHighlighterComponent | null = null;

export function getLoadedPrismSyntaxHighlighter(): SyntaxHighlighterComponent | null {
  return prismSyntaxHighlighterComponent;
}

export function loadPrismSyntaxHighlighter(): Promise<SyntaxHighlighterComponent> {
  prismSyntaxHighlighterPromise ??= import('react-syntax-highlighter/dist/esm/prism-async-light').then(
    async (module) => {
      // The async component module can resolve before its AST engine. Keep the
      // caller's fallback until the engine is ready to avoid its interim,
      // separate line-number column replacing the final inline-number layout.
      // The package implements preload on async variants, but its shared
      // declaration only describes the synchronous component API.
      const component = module.default as unknown as SyntaxHighlighterComponent & {
        preload: () => Promise<void>;
      };
      await component.preload();
      prismSyntaxHighlighterComponent = component;
      return prismSyntaxHighlighterComponent;
    },
  );

  return prismSyntaxHighlighterPromise;
}
