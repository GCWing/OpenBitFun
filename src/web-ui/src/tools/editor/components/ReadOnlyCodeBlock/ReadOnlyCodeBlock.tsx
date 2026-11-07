/**
 * Read-only Code Block Component
 * 
 * Used for chat code blocks, documentation preview, code display.
 * Based on MonacoEditorCore with readonly preset.
 * @module components/ReadOnlyCodeBlock
 */

import React, { useMemo, useRef, useCallback } from 'react';
import { MonacoEditorCore, type MonacoEditorCoreRef } from '../../core/MonacoEditorCore';
import type { EditorConfigPartial } from '../../config/types';
import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_LINE_HEIGHT,
} from '../../config/defaults';
import { getMonacoLanguage } from '@/infrastructure/language-detection';
import './ReadOnlyCodeBlock.scss';

export interface ReadOnlyCodeBlockProps {
  /** Code content */
  content: string;
  /** Language (auto-detect if not specified) */
  language?: string;
  /** File name (for language detection) */
  fileName?: string;
  /** Show line numbers */
  showLineNumbers?: boolean;
  /** Max height (scrolls when exceeded) */
  maxHeight?: number | string;
  /** Min height */
  minHeight?: number | string;
  /** Auto-adjust height based on content */
  autoHeight?: boolean;
  /** CSS class name */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Config overrides */
  config?: EditorConfigPartial;
  /** Whether to defer loading Monaco until visible in viewport (defaults to true) */
  lazy?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Editor ready callback */
  onReady?: (ref: MonacoEditorCoreRef) => void;
}

export const ReadOnlyCodeBlock: React.FC<ReadOnlyCodeBlockProps> = ({
  content,
  language,
  fileName,
  showLineNumbers = true,
  maxHeight = 400,
  minHeight = 50,
  autoHeight = true,
  className = '',
  style,
  config,
  lazy = true,
  onClick,
  onReady,
}) => {
  const editorRef = useRef<MonacoEditorCoreRef>(null);
  
  const detectedLanguage = useMemo(() => {
    if (language) return language;
    if (fileName) {
      const detected = getMonacoLanguage(fileName);
      if (detected !== 'plaintext') return detected;
    }
    return 'plaintext';
  }, [language, fileName]);
  
  const filePath = useMemo(() => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = fileName ? fileName.split('.').pop() : 'txt';
    return `inmemory://readonly/${timestamp}/${random}/code.${ext}`;
  }, [fileName]);
  
  const computedHeight = useMemo(() => {
    if (!autoHeight) {
      return typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight;
    }
    
    const lineCount = content.split('\n').length;
    const lineHeight = config?.lineHeight || DEFAULT_EDITOR_LINE_HEIGHT;
    const fontSize = config?.fontSize || DEFAULT_EDITOR_FONT_SIZE;
    const calculatedHeight = lineCount * fontSize * lineHeight + 16; // +16 for padding
    
    const minH = typeof minHeight === 'number' ? minHeight : parseInt(String(minHeight), 10) || 50;
    const maxH = typeof maxHeight === 'number' ? maxHeight : parseInt(String(maxHeight), 10) || 400;
    
    const finalHeight = Math.min(Math.max(calculatedHeight, minH), maxH);
    return `${finalHeight}px`;
  }, [content, autoHeight, minHeight, maxHeight, config]);
  
  const handleEditorReady = useCallback(() => {
    if (onReady && editorRef.current) {
      onReady(editorRef.current);
    }
  }, [onReady]);
  
  const mergedConfig: EditorConfigPartial = useMemo(() => ({
    ...config,
    minimap: { enabled: false, side: 'right', size: 'proportional' },
    scrollBeyondLastLine: false,
  }), [config]);
  
  return (
    <div
      className={`readonly-code-block ${className}`}
      data-openbitfun-component="editor-tool"
      data-openbitfun-part="readOnlyCodeBlock"
      style={{
        height: computedHeight,
        ...style,
      }}
      onClick={onClick}
    >
      <MonacoEditorCore
        ref={editorRef}
        filePath={filePath}
        language={detectedLanguage}
        initialContent={content}
        preset="readonly"
        config={mergedConfig}
        readOnly={true}
        showLineNumbers={showLineNumbers}
        showMinimap={false}
        lazy={lazy}
        onEditorReady={handleEditorReady}
      />
    </div>
  );
};

export default ReadOnlyCodeBlock;
