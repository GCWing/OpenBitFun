/**
 * Mermaid rendering service.
 * Visual configuration is projected by MermaidAppearanceAdapter.
 */

import { getMermaidConfig } from '../appearance/mermaidAppearance';
import { createModuleLoader } from '@/shared/utils/moduleLoader';

type MermaidRuntime = typeof import('mermaid')['default'];

const loadMermaidRuntime = createModuleLoader(() => import('mermaid').then(module => module.default));

export class MermaidService {
  private static instance: MermaidService;
  public static getInstance(): MermaidService {
    if (!MermaidService.instance) {
      MermaidService.instance = new MermaidService();
    }
    return MermaidService.instance;
  }

  /** Load and initialize Mermaid before each render. */
  private async initializeMermaid(): Promise<MermaidRuntime> {
    const mermaid = await loadMermaidRuntime();
    const config = getMermaidConfig();
    
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      ...config,
    } as any);

    return mermaid;
  }

  /** Render a Mermaid diagram. */
  public async renderDiagram(sourceCode: string): Promise<string> {
    // Reinitialize per render so the active Appearance projection is used.
    const mermaid = await this.initializeMermaid();

    try {
      if (!sourceCode.trim()) {
        throw new Error('Source code is empty');
      }

      await mermaid.parse(sourceCode);

      const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const result = await mermaid.render(id, sourceCode);
      return result.svg;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Render failed: ${errorMessage}`);
    }
  }

  /** Validate Mermaid code (boolean result). */
  public async validateSourceCode(sourceCode: string): Promise<boolean> {
    try {
      if (!sourceCode.trim()) return false;
      const mermaid = await this.initializeMermaid();
      await mermaid.parse(sourceCode);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate Mermaid code with detailed error information.
   * Used by auto-fix to surface parsing errors.
   */
  public async validateMermaidCode(sourceCode: string): Promise<{ valid: boolean; error?: string }> {
    try {
      if (!sourceCode.trim()) {
        return { valid: false, error: 'Source code is empty' };
      }
      const mermaid = await this.initializeMermaid();
      await mermaid.parse(sourceCode);
      return { valid: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { valid: false, error: errorMessage };
    }
  }

  /** Get default template. */
  public getDefaultTemplate(): string {
    return `flowchart TD
    A[Start] --> B[Process Data]
    B --> C{Successful?}
    C -->|Yes| D[Save Result]
    C -->|No| E[Handle Error]
    D --> F[End]
    E --> F`;
  }

  /** Export as SVG. */
  public async exportAsSVG(sourceCode: string): Promise<string> {
    return this.renderDiagram(sourceCode);
  }

  /**
   * Export as PNG by loading the self-contained SVG markup into an Image
   * element, drawing it onto a canvas, and extracting the result as a Blob.
   *
   * This avoids html-to-image which re-serializes the DOM and often breaks
   * foreignObject content and inline styles.
   */
  public async exportAsPNG(
    sourceCode: string,
    scale: number = 2,
    svgMarkup?: string,
    dims?: { width: number; height: number }
  ): Promise<Blob> {
    let svgContent = svgMarkup;
    let width = dims?.width ?? 0;
    let height = dims?.height ?? 0;

    if (!svgContent) {
      svgContent = await this.exportAsSVG(sourceCode);
    }

    if (!width || !height) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgContent, 'image/svg+xml');
      const svg = doc.documentElement;
      const viewBox = svg.getAttribute('viewBox');
      if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length >= 4) {
          width = width || parts[2];
          height = height || parts[3];
        }
      }
      if (!width) width = parseFloat(svg.getAttribute('width') ?? '0') || 800;
      if (!height) height = parseFloat(svg.getAttribute('height') ?? '0') || 600;
    }

    const e2eDelayMs = Number((window as Window & {
      __OPENBITFUN_E2E_PNG_EXPORT_DELAY_MS__?: number;
    }).__OPENBITFUN_E2E_PNG_EXPORT_DELAY_MS__ ?? 0);

    if (e2eDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, e2eDelayMs));
    }

    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('PNG export timed out')),
        15000,
      );
      img.onload = () => { window.clearTimeout(timeout); resolve(); };
      img.onerror = () => { window.clearTimeout(timeout); reject(new Error('Unable to load SVG as image')); };
      img.src = dataUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create canvas');

    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => {
        if (result) resolve(result);
        else reject(new Error('Unable to generate PNG blob'));
      }, 'image/png');
    });

    return blob;
  }

}

export const mermaidService = MermaidService.getInstance();
