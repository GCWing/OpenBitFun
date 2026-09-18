// Test-only reference rendering. The product editor has no preview mode; this
// stays as the oracle the browser E2E compares the rich-text view against, so a
// Tiptap change that drifts from the standard MarkdownRenderer typography fails.
import React from 'react';
import { MarkdownRenderer } from '../../src/infrastructure/markdown';
import { useI18n } from '../../src/infrastructure/i18n';
import { splitMarkdownFrontmatter } from '../../src/tools/editor/meditor/utils/markdownFrontmatter';
import './preview-reference.scss';

interface PreviewProps {
  value: string;
  basePath?: string;
}

export const Preview: React.FC<PreviewProps> = ({ value, basePath }) => {
  const { t } = useI18n('tools');
  const frontmatter = splitMarkdownFrontmatter(value);

  return (
    <div className="m-editor-preview">
      <div className="m-editor-preview-content">
        {frontmatter && (
          <section className="m-editor-preview-frontmatter">
            <header className="m-editor-preview-frontmatter__header">
              <span className="m-editor-preview-frontmatter__label">
                {t('editor.meditor.frontmatter.label')}
              </span>
            </header>
            <pre className="m-editor-preview-frontmatter__source">
              <code>{frontmatter.yaml}</code>
            </pre>
          </section>
        )}
        <MarkdownRenderer content={frontmatter?.body ?? value} basePath={basePath} />
      </div>
    </div>
  );
};
