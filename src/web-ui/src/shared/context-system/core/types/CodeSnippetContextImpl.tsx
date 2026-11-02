import { OverflowText } from '@openbitfun/ui';
 

import React from 'react';
import { Code } from 'lucide-react';
import type { CodeSnippetContext, ValidationResult, RenderOptions } from '../../../types/context';
import type { 
  ContextTransformer, 
  ContextValidator, 
  ContextCardRenderer 
} from '../../../services/ContextRegistry';
import { i18nService } from '@/infrastructure/i18n';
import { getCodeSnippetLanguageAccent } from '@/infrastructure/appearance/appearanceDomainTokens';



export class CodeSnippetContextTransformer implements ContextTransformer<'code-snippet'> {
  readonly type = 'code-snippet' as const;
  
  transform(context: CodeSnippetContext): unknown {
    return {
      type: 'code_snippet',
      file: context.filePath,
      lines: {
        start: context.startLine,
        end: context.endLine
      },
      content: context.selectedText,
      language: context.language,
      context: {
        before: context.beforeContext,
        after: context.afterContext
      }
    };
  }
  
  estimateSize(context: CodeSnippetContext): number {
    let size = context.selectedText.length;
    if (context.beforeContext) size += context.beforeContext.length;
    if (context.afterContext) size += context.afterContext.length;
    return size;
  }
}



export class CodeSnippetContextValidator implements ContextValidator<'code-snippet'> {
  readonly type = 'code-snippet' as const;
  
  async validate(context: CodeSnippetContext): Promise<ValidationResult> {
    const warnings: string[] = [];
    
    
    if (context.startLine < 1) {
      return { valid: false, error: 'Start line must be greater than 0.' };
    }
    
    if (context.endLine < context.startLine) {
      return { valid: false, error: 'End line must be greater than or equal to start line.' };
    }
    
    
    const lineCount = context.endLine - context.startLine + 1;
    if (lineCount > 500) {
      warnings.push(i18nService.t('components:contextSystem.validation.warnings.codeLinesLarge', { max: 500 }));
    }
    
    if (context.selectedText.length > 50000) {
      warnings.push(i18nService.t('components:contextSystem.validation.warnings.codeContentLarge', { maxChars: 50000 }));
    }
    
    
    if (!context.selectedText || context.selectedText.trim() === '') {
      return { valid: false, error: 'Selected code is empty.' };
    }
    
    return {
      valid: true,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }
  
  quickValidate(context: CodeSnippetContext): ValidationResult {
    if (!context.selectedText || context.selectedText.trim() === '') {
      return { valid: false, error: 'Code content is empty.' };
    }
    
    if (context.startLine < 1 || context.endLine < context.startLine) {
      return { valid: false, error: 'Invalid line range.' };
    }
    
    return { valid: true };
  }
}



export class CodeSnippetCardRenderer implements ContextCardRenderer<'code-snippet'> {
  readonly type = 'code-snippet' as const;
  
  render(context: CodeSnippetContext, options?: RenderOptions): React.ReactNode {
    const { compact = false, interactive = true, showPreview = true } = options || {};
    
    const lineCount = context.endLine - context.startLine + 1;
    const previewText = compact 
      ? context.selectedText.slice(0, 50) + (context.selectedText.length > 50 ? '...' : '')
      : context.selectedText.split('\n').slice(0, 3).join('\n');
    
    return (
      <div className={`openbitfun-context-card openbitfun-context-card--code-snippet ${compact ? 'openbitfun-context-card--compact' : ''}`}>
        <div className="openbitfun-context-card__icon">
          <Code size={compact ? 16 : 20} />
        </div>
        
        <div className="openbitfun-context-card__content">
          <div className="openbitfun-context-card__title">
            <OverflowText>{context.fileName}</OverflowText>
            <span className="openbitfun-context-card__badge">
              L{context.startLine}-{context.endLine}
            </span>
          </div>
          
          {!compact && (
            <>
              <div className="openbitfun-context-card__subtitle"><OverflowText behavior="marquee">
                {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                {context.language && (
                  <span className="openbitfun-context-card__meta">
                    {' • '}{context.language}
                  </span>
                )}
              </OverflowText></div>
              
              {showPreview && (
                <div className="openbitfun-context-card__preview">
                  <code className="openbitfun-context-card__code">
                    {previewText}
                  </code>
                </div>
              )}
            </>
          )}
        </div>
        
        {interactive && (
          <div className="openbitfun-context-card__actions">
            <button 
              className="openbitfun-context-card__action-btn"
              title={i18nService.t('components:contextSystem.contextCard.viewFullCode')}
            >
              <Code size={14} />
            </button>
          </div>
        )}
      </div>
    );
  }
}



export function getLanguageDisplayName(language?: string): string {
  const langMap: Record<string, string> = {
    'javascript': 'JavaScript',
    'typescript': 'TypeScript',
    'python': 'Python',
    'rust': 'Rust',
    'go': 'Go',
    'java': 'Java',
    'cpp': 'C++',
    'c': 'C',
    'csharp': 'C#',
    'cangjie': 'Cangjie',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'json': 'JSON',
    'yaml': 'YAML',
    'markdown': 'Markdown'
  };
  
  return language ? (langMap[language] || language) : 'Text';
}

export function getLanguageColor(language?: string): string {
  return getCodeSnippetLanguageAccent(language);
}
