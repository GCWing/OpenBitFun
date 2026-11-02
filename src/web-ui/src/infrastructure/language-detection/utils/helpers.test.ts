import { describe, expect, it } from 'vitest';

import { detectLanguage, getEditorType, getMonacoLanguage } from './helpers';

describe('getEditorType', () => {
  it('routes PDF files to the PDF viewer case-insensitively', () => {
    expect(getEditorType('report.PDF')).toBe('pdf-viewer');
  });

  it('routes HTML files to the embedded preview case-insensitively', () => {
    expect(getEditorType('index.HTML')).toBe('html-preview');
    expect(getEditorType('legacy.HTM')).toBe('html-preview');
  });
});

describe('Cangjie language detection', () => {
  it('maps .cj sources to the Cangjie editor language', () => {
    expect(getMonacoLanguage('main.cj')).toBe('cangjie');
    expect(detectLanguage('src/app.cj').language.id).toBe('cangjie');
    expect(getEditorType('main.cj')).toBe('code-editor');
  });
});
