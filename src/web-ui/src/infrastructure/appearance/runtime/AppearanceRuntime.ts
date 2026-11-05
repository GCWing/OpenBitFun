import { createLogger } from '@/shared/utils/logger';
import { AppearanceCompiler } from '../compiler/AppearanceCompiler';
import type { AppearanceRegistry } from '../registry/AppearanceRegistry';
import type {
  AppearancePackage,
  AppearanceRendererId,
  AppearanceRendererContext,
  RegisteredAppearanceRendererAdapter,
  ResolvedAppearance,
  ResolvedAppearanceAsset,
  StoredAppearanceAsset,
} from '../types';

const log = createLogger('AppearanceRuntime');
const STYLE_ATTRIBUTE = 'data-openbitfun-appearance-runtime';

interface PreparedRendererTransaction {
  id: AppearanceRendererId;
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

interface AssetGeneration {
  urls: Map<string, string>;
  references: number;
  retired: boolean;
}

export class AppearanceRuntime {
  private readonly compiler: AppearanceCompiler;
  private snapshot: ResolvedAppearance | null = null;
  private revision = 0;
  private listeners = new Set<() => void>();
  private applyQueue: Promise<ResolvedAppearance | null> = Promise.resolve(null);
  private readonly assetGenerations = new Map<number, AssetGeneration>();
  private activeAssetRevision: number | null = null;

  constructor(private readonly registry: AppearanceRegistry) {
    this.compiler = new AppearanceCompiler(registry);
  }

  initialize(
    pkg: AppearancePackage,
    assets: Readonly<Record<string, StoredAppearanceAsset>> = {},
  ): Promise<ResolvedAppearance> {
    if (this.snapshot) return Promise.resolve(this.snapshot);
    return this.applyPackage(pkg, assets);
  }

  applyPackage(
    pkg: AppearancePackage,
    assets: Readonly<Record<string, StoredAppearanceAsset>> = {},
  ): Promise<ResolvedAppearance> {
    const run = () => this.compileAndApply(pkg, assets);
    const result = this.applyQueue.then(run, run);
    this.applyQueue = result;
    return result;
  }

  preflight(
    pkg: AppearancePackage,
    assets: Readonly<Record<string, StoredAppearanceAsset>> = {},
  ): ResolvedAppearance {
    const compiled = this.compiler.compile(pkg, this.revision + 1);
    Object.entries(compiled.assets).forEach(([id, resolved]) => {
      const stored = assets[id];
      if (!stored) throw new Error(`Appearance asset bytes are missing: ${id}`);
      if (stored.mimeType !== resolved.definition.mimeType) {
        throw new Error(`Appearance asset MIME does not match the manifest: ${id}`);
      }
    });
    return compiled;
  }

  getSnapshot = (): ResolvedAppearance | null => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retainAssetRevision = (revision: number): (() => void) => {
    const generation = this.assetGenerations.get(revision);
    if (!generation) return () => undefined;
    generation.references += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      generation.references = Math.max(0, generation.references - 1);
      this.collectAssetGeneration(revision);
    };
  };

  async dispose(): Promise<void> {
    const previous = this.snapshot;
    if (previous) {
      const context: AppearanceRendererContext = {
        revision: previous.revision + 1,
        appearanceId: previous.id,
        mode: previous.mode,
        globals: previous.globals,
        assets: {},
      };
      for (const adapter of this.registry.getRendererAdapters()) {
        try {
          await this.applyRenderer(adapter, undefined, previous.renderers, context);
        } catch (error) {
          log.warn('Renderer adapter cleanup failed', { rendererId: adapter.id, error });
        }
      }
    }
    document.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`).forEach(node => node.remove());
    this.assetGenerations.forEach(generation => this.revokeAssetUrls(generation.urls));
    this.assetGenerations.clear();
    this.activeAssetRevision = null;
    const root = document.documentElement;
    root.removeAttribute('data-openbitfun-appearance');
    root.removeAttribute('data-openbitfun-appearance-mode');
    root.removeAttribute('data-openbitfun-appearance-revision');
    root.removeAttribute('data-openbitfun-appearance-root');
    this.snapshot = null;
    this.emit();
  }

  private async compileAndApply(
    pkg: AppearancePackage,
    storedAssets: Readonly<Record<string, StoredAppearanceAsset>>,
  ): Promise<ResolvedAppearance> {
    const nextRevision = this.revision + 1;
    const compiled = this.preflight(pkg, storedAssets);
    const preparedAssets = this.prepareAssets(compiled, storedAssets);
    const next: ResolvedAppearance = Object.freeze({
      ...compiled,
      assets: Object.freeze(preparedAssets.assets),
      backgroundMedia: compiled.backgroundMedia ? Object.freeze({
        ...compiled.backgroundMedia,
        url: preparedAssets.assets[compiled.backgroundMedia.assetId]?.url,
        posterUrl: preparedAssets.assets[compiled.backgroundMedia.posterAssetId]?.url,
      }) : undefined,
      cssText: `${compiled.cssText}${preparedAssets.cssText ? `\n${preparedAssets.cssText}` : ''}`,
    });
    const previous = this.snapshot;
    const nextStyle = document.createElement('style');
    nextStyle.setAttribute(STYLE_ATTRIBUTE, String(nextRevision));
    nextStyle.textContent = next.cssText;
    document.head.appendChild(nextStyle);

    const context: AppearanceRendererContext = {
      revision: next.revision,
      appearanceId: next.id,
      mode: next.mode,
      globals: next.globals,
      assets: next.assets,
    };
    const rendererTransactions = this.prepareRendererTransactions(next, previous, context);
    const startedTransactions: PreparedRendererTransaction[] = [];
    try {
      for (const transaction of rendererTransactions) {
        startedTransactions.push(transaction);
        await transaction.commit();
      }
    } catch (error) {
      nextStyle.remove();
      this.revokeAssetUrls(preparedAssets.urls);
      await this.rollbackRendererTransactions(startedTransactions);
      log.error('Appearance transaction failed', { appearanceId: next.id, revision: next.revision, error });
      throw error;
    }

    const root = document.documentElement;
    root.setAttribute('data-openbitfun-appearance-root', 'true');
    root.setAttribute('data-openbitfun-appearance', next.id);
    root.setAttribute('data-openbitfun-appearance-mode', next.mode);
    // Revision is the activation switch because every generated selector is revision-scoped.
    root.setAttribute('data-openbitfun-appearance-revision', String(next.revision));
    document.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`).forEach(node => {
      if (node !== nextStyle) node.remove();
    });
    const previousAssetRevision = this.activeAssetRevision;
    this.assetGenerations.set(nextRevision, {
      urls: preparedAssets.urls,
      references: 0,
      retired: false,
    });
    this.activeAssetRevision = nextRevision;
    if (previousAssetRevision !== null) {
      const previousGeneration = this.assetGenerations.get(previousAssetRevision);
      if (previousGeneration) previousGeneration.retired = true;
    }

    this.revision = nextRevision;
    this.snapshot = next;
    this.emit();
    if (previousAssetRevision !== null) this.collectAssetGeneration(previousAssetRevision);
    if (next.diagnostics.length > 0) {
      log.warn('Appearance applied with diagnostics', {
        appearanceId: next.id,
        revision: next.revision,
        diagnosticCount: next.diagnostics.length,
      });
    } else {
      log.info('Appearance applied', { appearanceId: next.id, revision: next.revision });
    }
    return next;
  }

  private prepareRendererTransactions(
    next: ResolvedAppearance,
    previous: ResolvedAppearance | null,
    context: AppearanceRendererContext,
  ): PreparedRendererTransaction[] {
    const previousContext: AppearanceRendererContext = {
      revision: previous?.revision ?? 0,
      appearanceId: previous?.id ?? next.id,
      mode: previous?.mode ?? next.mode,
      globals: previous?.globals ?? next.globals,
      assets: previous?.assets ?? {},
    };
    return this.registry.getRendererAdapters().map(adapter => ({
      id: adapter.id,
      commit: () => this.applyRenderer(adapter, next.renderers, previous?.renderers, context),
      rollback: () => this.applyRenderer(adapter, previous?.renderers, next.renderers, previousContext),
    }));
  }

  private async rollbackRendererTransactions(
    transactions: readonly PreparedRendererTransaction[],
  ): Promise<void> {
    for (const transaction of [...transactions].reverse()) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        log.error('Renderer adapter rollback failed', { rendererId: transaction.id, rollbackError });
      }
    }
  }

  private applyRenderer(
    adapter: RegisteredAppearanceRendererAdapter,
    next: ResolvedAppearance['renderers'] | undefined,
    previous: ResolvedAppearance['renderers'] | undefined,
    context: AppearanceRendererContext,
  ): void | Promise<void> {
    switch (adapter.id) {
      case 'theme-tokens':
        return adapter.apply(next?.['theme-tokens'], previous?.['theme-tokens'], context);
      case 'monaco':
        return adapter.apply(next?.monaco, previous?.monaco, context);
      case 'xterm':
        return adapter.apply(next?.xterm, previous?.xterm, context);
      case 'mermaid':
        return adapter.apply(next?.mermaid, previous?.mermaid, context);
      case 'generative-widget':
        return adapter.apply(next?.['generative-widget'], previous?.['generative-widget'], context);
    }
  }

  private prepareAssets(
    appearance: ResolvedAppearance,
    storedAssets: Readonly<Record<string, StoredAppearanceAsset>>,
  ): {
    assets: Record<string, ResolvedAppearanceAsset>;
    cssText: string;
    urls: Map<string, string>;
  } {
    const assets: Record<string, ResolvedAppearanceAsset> = {};
    const urls = new Map<string, string>();
    try {
      Object.entries(appearance.assets).forEach(([id, resolved]) => {
        const stored = storedAssets[id];
        if (!stored) throw new Error(`Appearance asset bytes are missing: ${id}`);
        const url = URL.createObjectURL(new Blob([stored.bytes], { type: stored.mimeType }));
        urls.set(id, url);
        assets[id] = Object.freeze({
          ...resolved,
          url,
          width: stored.width,
          height: stored.height,
          durationSeconds: stored.durationSeconds,
        });
      });
    } catch (error) {
      this.revokeAssetUrls(urls);
      throw error;
    }
    return {
      assets,
      cssText: this.compileAssetDeclarations(appearance.id, appearance.revision, assets),
      urls,
    };
  }

  private compileAssetDeclarations(
    appearanceId: string,
    revision: number,
    assets: Readonly<Record<string, ResolvedAppearanceAsset>>,
  ): string {
    const declarations = document.createElement('div').style;
    Object.entries(assets).forEach(([id, asset]) => {
      if (asset.definition.kind !== 'image' || !asset.url) return;
      declarations.setProperty(`--openbitfun-appearance-asset-${id.replace(/\./g, '-')}`, `url("${asset.url}")`);
    });
    if (!declarations.cssText) return '';
    return `:root[data-openbitfun-appearance="${appearanceId}"][data-openbitfun-appearance-revision="${revision}"]{${declarations.cssText}}`;
  }

  private revokeAssetUrls(urls: ReadonlyMap<string, string>): void {
    urls.forEach(url => URL.revokeObjectURL(url));
  }

  private collectAssetGeneration(revision: number): void {
    const generation = this.assetGenerations.get(revision);
    if (!generation || !generation.retired || generation.references > 0) return;
    this.revokeAssetUrls(generation.urls);
    this.assetGenerations.delete(revision);
  }

  private emit(): void {
    this.listeners.forEach(listener => listener());
  }
}
