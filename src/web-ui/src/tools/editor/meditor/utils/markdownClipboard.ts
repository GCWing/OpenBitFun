import { DOMParser, DOMSerializer, Slice, type ResolvedPos } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { createLogger } from '@/shared/utils/logger';
import { markdownToEditableTiptapDoc } from './tiptapMarkdown';

const log = createLogger('MarkdownClipboard');

function parsePlainClipboardText(text: string, context: ResolvedPos, view: EditorView): Slice {
  const { schema } = view.state;
  const serializer = DOMSerializer.fromSchema(schema);
  const container = document.createElement('div');
  // Match ProseMirror's ordinary text-paste semantics, including active marks.
  for (const line of text.split(/(?:\r\n?|\n)+/)) {
    const paragraph = container.appendChild(document.createElement('p'));
    if (line) paragraph.appendChild(serializer.serializeNode(schema.text(line, context.marks())));
  }
  return DOMParser.fromSchema(schema).parseSlice(container, { preserveWhitespace: true, context });
}

/** Native clipboard parsing keeps rich HTML and code-block pastes on their existing paths. */
export function parseMarkdownClipboardText(text: string, context: ResolvedPos, plain: boolean, view: EditorView): Slice {
  if (plain) return parsePlainClipboardText(text, context, view);
  try {
    const parsedDocument = view.state.schema.nodeFromJSON(markdownToEditableTiptapDoc(text));
    const paragraph = parsedDocument.childCount === 1 ? parsedDocument.firstChild : null;
    if (paragraph?.type.name === 'paragraph' && paragraph.textContent === text
      && paragraph.content.content.every(node => node.isText && node.marks.length === 0)) {
      return parsePlainClipboardText(text, context, view);
    }
    return Slice.maxOpen(parsedDocument.content);
  } catch (error) {
    log.warn('Failed to parse pasted Markdown, preserving clipboard text', { error });
    return parsePlainClipboardText(text, context, view);
  }
}

const SOURCE_HTML_WRAPPERS = new Set(['DIV', 'SPAN', 'P', 'BR']);

function isSourceTextHtml(html: string, text: string): boolean {
  const template = document.createElement('template');
  template.innerHTML = html;
  if (template.content.querySelector('[data-pm-slice]')) return false;
  for (const metadata of template.content.querySelectorAll('meta, style, title')) metadata.remove();
  // Code editors wrap source lines/tokens in styled elements. Actual rich-text
  // headings, lists, links, images and code blocks keep the native HTML path.
  if (!Array.from(template.content.querySelectorAll('*')).every(element => SOURCE_HTML_WRAPPERS.has(element.tagName))) return false;
  const normalize = (value: string) => value.replace(/\s/g, '');
  return normalize(template.content.textContent ?? '') === normalize(text);
}

function editorClipboardLanguage(data: DataTransfer): string | undefined {
  const raw = data.getData('vscode-editor-data');
  if (!raw) return undefined;
  try {
    const metadata: unknown = JSON.parse(raw);
    if (metadata && typeof metadata === 'object' && 'mode' in metadata && typeof metadata.mode === 'string') return metadata.mode;
  } catch {
    // Clipboard metadata is optional; content can still identify source HTML.
  }
  return undefined;
}

/** Handles source Markdown even when the clipboard also contains HTML or editor metadata. */
export function handleMarkdownSourcePaste(view: EditorView, event: ClipboardEvent, plain: boolean): boolean {
  const data = event.clipboardData;
  if (plain || !data || !view.editable || view.state.selection.$from.parent.type.spec.code || data.files.length > 0) return false;
  const markdown = data.getData('text/markdown');
  const text = markdown || data.getData('text/plain');
  if (!text) return false;
  const language = editorClipboardLanguage(data);
  if (!markdown && language && language !== 'markdown') return false;
  const html = data.getData('text/html');
  if (!markdown && language !== 'markdown' && (!html || !isSourceTextHtml(html, text))) return false;

  // Handle this before the built-in code-block plugin consumes editor metadata.
  const slice = parseMarkdownClipboardText(text, view.state.selection.$from, false, view);
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
  return true;
}
