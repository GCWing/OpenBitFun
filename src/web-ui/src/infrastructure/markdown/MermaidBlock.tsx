import { BoundedResourceCache } from '@/shared/utils/BoundedResourceCache';
import { Icon as CatalogIcon } from '@openbitfun/ui';
/**
 * MermaidBlock component
 * Renders Mermaid diagrams in Markdown
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { MermaidService } from '@/tools/mermaid-editor/services/MermaidService';
import { mermaidAppearanceAdapter } from '@/infrastructure/appearance/adapters/MermaidAppearanceAdapter';
import { Loader2, AlertCircle, Code2 } from 'lucide-react';
import { createLogger } from '@/shared/utils/logger';
import './MermaidBlock.scss';

const log = createLogger('MermaidBlock');

const svgCache = new BoundedResourceCache<string, string>(8 * 1024 * 1024);

let appearanceRevision = 0;

const getCacheKey = (code: string): string => {
  return `${appearanceRevision}:${code.trim()}`;
};

const clearCache = () => {
  svgCache.clear();
  appearanceRevision = mermaidAppearanceAdapter.getRevision();
  log.debug('Cache cleared', { revision: appearanceRevision });
};

export interface MermaidBlockProps {
  code: string;
  isStreaming?: boolean;
  className?: string;
}

type RenderState = 'streaming' | 'incomplete' | 'loading' | 'rendered' | 'error';

const isCodeComplete = (code: string): boolean => {
  const trimmed = code.trim();
  if (!trimmed) return false;
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart)/m.test(trimmed);
};

export const MermaidBlock: React.FC<MermaidBlockProps> = ({
  code,
  isStreaming = false,
  className = ''
}) => {
  const { t } = useI18n('components');
  const cacheKey = getCacheKey(code.trim());
  const cachedSvg = svgCache.get(cacheKey);
  
  const [state, setState] = useState<RenderState>(() => {
    if (cachedSvg) return 'rendered';
    if (isStreaming) return 'streaming';
    if (!code.trim() || !isCodeComplete(code)) return 'incomplete';
    return 'loading';
  });
  const [svgContent, setSvgContent] = useState<string>(cachedSvg || '');
  const [error, setError] = useState<string>('');
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const [currentAppearanceRevision, setCurrentAppearanceRevision] = useState(
    mermaidAppearanceAdapter.getRevision(),
  );
  
  const mermaidService = useRef(MermaidService.getInstance());
  const renderTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentCodeRef = useRef<string>('');

  const renderDiagram = useCallback(async (codeToRender: string) => {
    const trimmedCode = codeToRender.trim();
    const key = getCacheKey(trimmedCode);
    
    if (!isCodeComplete(trimmedCode)) {
      setState('incomplete');
      return;
    }

    const cached = svgCache.get(key);
    if (cached) {
      setSvgContent(cached);
      setState('rendered');
      return;
    }

    setState('loading');
    setError('');

    try {
      const svg = await mermaidService.current.renderDiagram(trimmedCode);
      if (currentCodeRef.current === trimmedCode) {
        svgCache.set(key, svg, (key.length + svg.length) * 2);
        setSvgContent(svg);
        setState('rendered');
      }
    } catch (err) {
      if (currentCodeRef.current === trimmedCode) {
        setError(err instanceof Error ? err.message : t('mermaidBlock.renderFailed'));
        setState('error');
      }
    }
  }, [t]);

  useEffect(() => {
    const trimmedCode = code.trim();
    currentCodeRef.current = trimmedCode;

    if (renderTimeoutRef.current) {
      clearTimeout(renderTimeoutRef.current);
      renderTimeoutRef.current = null;
    }

    if (isStreaming) {
      setState('streaming');
      return;
    }

    if (!trimmedCode || !isCodeComplete(trimmedCode)) {
      setState('incomplete');
      return;
    }

    const key = getCacheKey(trimmedCode);
    const cached = svgCache.get(key);
    if (cached) {
      setSvgContent(cached);
      setState('rendered');
      return;
    }

    renderTimeoutRef.current = setTimeout(() => {
      renderDiagram(trimmedCode);
    }, 200);

    return () => {
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
      }
    };
  }, [code, isStreaming, renderDiagram, currentAppearanceRevision]);

  useEffect(() => {
    return mermaidAppearanceAdapter.subscribe(() => {
      clearCache();
      setCurrentAppearanceRevision(mermaidAppearanceAdapter.getRevision());
      setSvgContent('');
      setState('loading');
    });
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy code', err);
    }
  }, [code]);

  const renderContent = () => {
    switch (state) {
      case 'streaming':
        return (
          <div data-openbitfun-component="mermaid-block" data-openbitfun-part="streaming" className="mermaid-block__streaming">
            <div data-openbitfun-component="mermaid-block" data-openbitfun-part="codePreview" className="mermaid-block__code-preview">
              <pre data-openbitfun-component="mermaid-block" data-openbitfun-part="code" className="mermaid-code">
                <code>{code}</code>
                <span className="streaming-cursor">█</span>
              </pre>
            </div>
          </div>
        );

      case 'incomplete':
        return (
          <div className="mermaid-block__incomplete">
            <div data-openbitfun-component="mermaid-block" data-openbitfun-part="codePreview" className="mermaid-block__code-preview">
              <pre data-openbitfun-component="mermaid-block" data-openbitfun-part="code" className="mermaid-code">
                <code>{code}</code>
              </pre>
            </div>
            <div data-openbitfun-component="mermaid-block" data-openbitfun-part="hint" className="mermaid-block__hint">
              <AlertCircle size={14} />
              <span>{t('mermaidBlock.codeIncomplete')}</span>
            </div>
          </div>
        );

      case 'loading':
        return (
          <div data-openbitfun-component="mermaid-block" data-openbitfun-part="loading" className="mermaid-block__loading">
            <div className="mermaid-block__loading-indicator">
              <Loader2 size={20} className="spinning" />
              <span>{t('mermaidBlock.rendering')}</span>
            </div>
          </div>
        );

      case 'rendered':
        return (
          <div data-openbitfun-component="mermaid-block" data-openbitfun-part="rendered" className="mermaid-block__rendered">
            <div 
              className="mermaid-block__diagram"
              data-openbitfun-component="mermaid-block"
              data-openbitfun-part="diagram"
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
            
            <div data-openbitfun-component="mermaid-block" data-openbitfun-part="actions" className="mermaid-block__actions">
              <button
                data-openbitfun-component="mermaid-block"
                data-openbitfun-part="action"
                className="mermaid-icon-btn"
                onClick={() => setShowCode(!showCode)}
                title={showCode ? t('mermaidBlock.hideCode') : t('mermaidBlock.showCode')}
              >
                <Code2 size={14} />
              </button>
              <button
                data-openbitfun-component="mermaid-block"
                data-openbitfun-part="action"
                data-openbitfun-state={copied ? 'copied' : undefined}
                className={`mermaid-icon-btn ${copied ? 'copied' : ''}`}
                onClick={handleCopy}
                title={t('mermaidBlock.copyCode')}
              >
                {copied ? <CatalogIcon name="check-line" size="sm" /> : <CatalogIcon name="duplicate" size="sm" />}
              </button>
            </div>

            {showCode && (
              <div data-openbitfun-component="mermaid-block" data-openbitfun-part="source" className="mermaid-block__source">
                <pre data-openbitfun-component="mermaid-block" data-openbitfun-part="code" className="mermaid-code">
                  <code>{code}</code>
                </pre>
              </div>
            )}
          </div>
        );

      case 'error':
        return (
          <div data-openbitfun-component="mermaid-block" data-openbitfun-part="error" className="mermaid-block__error">
            <div className="mermaid-block__error-message">
              <AlertCircle size={16} />
              <span>{t('mermaidBlock.renderFailed')}: {error}</span>
            </div>
            <div data-openbitfun-component="mermaid-block" data-openbitfun-part="codePreview" className="mermaid-block__code-preview">
              <pre data-openbitfun-component="mermaid-block" data-openbitfun-part="code" className="mermaid-code">
                <code>{code}</code>
              </pre>
            </div>
            <div data-openbitfun-component="mermaid-block" data-openbitfun-part="actions" className="mermaid-block__actions">
              <button
                data-openbitfun-component="mermaid-block"
                data-openbitfun-part="action"
                data-openbitfun-state={copied ? 'copied' : undefined}
                className={`mermaid-icon-btn ${copied ? 'copied' : ''}`}
                onClick={handleCopy}
                title={t('mermaidBlock.copyCode')}
              >
                {copied ? <CatalogIcon name="check-line" size="sm" /> : <CatalogIcon name="duplicate" size="sm" />}
              </button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className={`mermaid-block mermaid-block--${state} ${className}`} data-openbitfun-component="mermaid-block" data-openbitfun-part="root" data-openbitfun-state={state === 'error' ? 'error' : state === 'streaming' ? 'streaming' : state === 'loading' ? 'loading' : undefined}>
      {renderContent()}
    </div>
  );
};

export default MermaidBlock;
