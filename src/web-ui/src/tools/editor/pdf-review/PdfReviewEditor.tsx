import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Download, Highlighter, MessageSquareText, MousePointer2, Pencil, Redo2, Save, Trash2, Undo2, X } from 'lucide-react';
import { Button, IconButton, Select, Textarea, Tooltip } from '@openbitfun/ui';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useI18n } from '@/infrastructure/i18n';
import { savePdfFile } from '@/infrastructure/file-export/savePdfFile';
import { globalEventBus } from '@/infrastructure/event-bus';
import { useEditorDocument, type EditorDocument } from '../services/EditorDocument';
import PdfViewer, { type PdfViewerProps } from '../components/PdfViewer';
import { getPdfReviewSession, PdfReviewConflictError, PdfReviewExportConflict } from './PdfReviewSession';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import { createLogger } from '@/shared/utils/logger';
import { encodePdfBytes, PdfReviewEncryptedError, readPdfReviewSource, type PdfReviewAnnotation, type PdfReviewColor, type PdfReviewTool } from './pdfReview';
import './PdfReviewEditor.scss';

const log = createLogger('PdfReviewEditor');
/** Overlay notes and the sidecar keep working; only annotated PDF copies are blocked. */
type AnnotatedCopyBlock = 'encrypted' | 'unreadable';

export interface PdfReviewEditorProps extends PdfViewerProps { onDirtyStateChange?: (dirty: boolean) => void }
export default function PdfReviewEditor(props: PdfReviewEditorProps) {
  const document = useEditorDocument();
  return document ? <DocumentPdfReviewEditor {...props} document={document} /> : <PdfViewer {...props} />;
}
function DocumentPdfReviewEditor({ document, onDirtyStateChange, ...props }: PdfReviewEditorProps & { document: EditorDocument }) {
  const { t, formatNumber } = useI18n('tools');
  const session = useMemo(() => getPdfReviewSession(document, props.filePath), [document, props.filePath]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [tool, setTool] = useState<PdfReviewTool>('select');
  const [color, setColor] = useState<PdfReviewColor>('yellow');
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [editingComment, setEditingComment] = useState<string>();
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [requestedPage, setRequestedPage] = useState<number>();
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [fingerprint, setFingerprint] = useState('');
  const [preparedPdf, setPreparedPdf] = useState<{ input: string; base64: string }>();
  const [copyBlock, setCopyBlock] = useState<AnnotatedCopyBlock>();
  const activePdfRef = useRef<PDFDocumentProxy>();
  const [operation, setOperation] = useState<'save' | 'export'>();
  const [resolving, setResolving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const onDirtyRef = useRef(onDirtyStateChange);
  onDirtyRef.current = onDirtyStateChange;
  useEffect(() => { void session.load(); }, [session]);
  useEffect(() => { onDirtyRef.current?.(snapshot.dirty || !!draft.trim()); }, [snapshot.dirty, draft]);
  const commitDraft = () => {
    if (!selectedId || !draft.trim()) return;
    session.replace(session.getSnapshot().data.annotations.map(item => item.id === selectedId
      ? { ...item, comments: editingComment ? item.comments.map(comment => comment.id === editingComment ? { ...comment, body: draft.trim() } : comment)
        : [...item.comments, { id: crypto.randomUUID(), body: draft.trim(), createdAt: new Date().toISOString() }] } : item));
    draftRef.current = '';
    setDraft(''); setEditingComment(undefined);
  };
  const commitDraftRef = useRef(commitDraft);
  commitDraftRef.current = commitDraft;
  useEffect(() => document.registerSaveParticipant(`pdf-review-draft:${props.filePath}`, async () => {
    commitDraftRef.current();
    // An unreadable review with nothing to write must not fail the source's Save All.
    const { dirty, saving } = session.getSnapshot();
    if (dirty || saving) await session.save();
    onDirtyRef.current?.(session.getSnapshot().dirty || !!draftRef.current.trim());
  }), [document, props.filePath, session]);
  const onLoaded = useCallback((pdf: PDFDocumentProxy) => {
    setPdf(pdf); activePdfRef.current = pdf; setCopyBlock(undefined);
    void (async () => {
      try {
        await session.load();
        const sourceBytes = await pdf.getData();
        await session.observePdfBytes(sourceBytes);
        const source = await readPdfReviewSource(sourceBytes);
        if (activePdfRef.current !== pdf) return;
        if (source.encrypted) { setCopyBlock('encrypted'); return; }
        if (!source.embedded) return;
        session.importEmbedded(source.embedded.data);
        setPreparedPdf({ input: props.pdfBase64 ?? props.filePath, base64: encodePdfBytes(source.embedded.bytes) });
      } catch (failure) {
        // The viewer already rendered this file; only annotated copies need pdf-lib to parse it.
        log.warn('PDF could not be prepared for annotated copies', { error: failure });
        if (activePdfRef.current === pdf) setCopyBlock('unreadable');
      }
    })();
    const value = pdf.fingerprints[0] ?? '';
    setFingerprint(value);
    session.setFingerprint(value);
  }, [session, props.pdfBase64, props.filePath]);
  const select = useCallback((id: string) => {
    if (selectedId !== id) {
      commitDraftRef.current();
      draftRef.current = '';
      setDraft(''); setEditingComment(undefined);
    }
    setSelectedId(id); setTool('select');
    setCommentsOpen(true);
  }, [selectedId]);
  const add = useCallback((annotation: PdfReviewAnnotation) => {
    session.replace([...session.getSnapshot().data.annotations, annotation]);
    if (annotation.kind === 'note') select(annotation.id);
  }, [select, session]);
  const stale = Boolean(snapshot.data.annotations.length && snapshot.data.fingerprint && fingerprint
    && snapshot.data.fingerprint !== fingerprint);
  const run = async (kind: 'save' | 'export') => {
    if (!pdf || operation) return;
    commitDraft();
    setOperation(kind);
    setError('');
    setMessage('');
    try {
      const bytes = await pdf.getData();
      if (kind === 'save') {
        let path: string;
        try { path = await session.savePdf(bytes); }
        catch (failure) {
          if (!(failure instanceof PdfReviewExportConflict)) throw failure;
          const approved = await confirmDialog({ title: t('editor.pdfReview.replaceTitle'),
            message: t('editor.pdfReview.replaceMessage', { path: failure.path }), type: 'warning',
            confirmText: t('editor.pdfReview.replace'), cancelText: t('editor.pdfReview.cancel'), confirmDanger: true });
          if (!approved) return;
          path = await session.savePdf(bytes, failure.expectedHash);
        }
        setMessage(t('editor.pdfReview.savedFile', { path }));
        globalEventBus.emit('file-tree:refresh');
      } else {
        const result = await session.exportPdf(bytes);
        if (await savePdfFile(result.path.split(/[/\\]/).pop()!, result.bytes, t('editor.pdfReview.export'))) {
          setMessage(t('editor.pdfReview.exported'));
        }
      }
    } catch (failure) {
      if (failure instanceof PdfReviewEncryptedError) setCopyBlock('encrypted');
      // The conflict notice already explains the paused write and offers both choices.
      else if (!(failure instanceof PdfReviewConflictError)) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setOperation(undefined); }
  };
  const resolveConflict = async (choice: 'local' | 'host') => {
    setResolving(true);
    setError('');
    try { await (choice === 'local' ? session.keepLocalChanges() : session.reloadFromHost()); }
    catch (failure) {
      if (!(failure instanceof PdfReviewConflictError)) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setResolving(false); }
  };
  const enabled = snapshot.loaded && !snapshot.readOnly && document.isCurrent() && props.isActiveTab !== false;
  const copyEnabled = !!pdf && !operation && enabled && !copyBlock;
  const tools: Array<[PdfReviewTool, typeof MousePointer2]> = [
    ['select', MousePointer2], ['highlight', Highlighter], ['note', MessageSquareText], ['ink', Pencil],
  ];
  return <section className="pdf-review-editor">
    <div className="pdf-review-editor__toolbar" data-openbitfun-component="pdf-viewer" data-openbitfun-part="reviewToolbar">
      <div className="pdf-review-editor__tools" role="group" aria-label={t('editor.pdfReview.tools')}>
        {tools.map(([name, Glyph]) => <Tooltip key={name} content={t(`editor.pdfReview.${name}`)} placement="bottom">
          <IconButton size="sm" variant="quiet" icon={<Glyph size={15} />} disabled={!enabled}
            aria-label={t(`editor.pdfReview.${name}`)} aria-pressed={tool === name} onClick={() => { commitDraft(); setSelectedId(undefined); setTool(name); }} />
        </Tooltip>)}
        <Select size="sm" aria-label={t('editor.pdfReview.color')} value={color} disabled={!enabled}
          className="pdf-review-editor__color" onValueChange={value => {
            setColor(value as PdfReviewColor);
            if (selectedId) session.replace(snapshot.data.annotations.map(item => item.id === selectedId ? { ...item, color: value as PdfReviewColor } : item));
          }}
          options={(['yellow', 'green', 'blue', 'pink'] as const).map(value => ({ value, label: t(`editor.pdfReview.colors.${value}`) }))} />
        <IconButton size="sm" icon={<Undo2 size={14} />} aria-label={t('editor.pdfReview.undo')}
          disabled={!enabled || !snapshot.canUndo} onClick={() => session.undo()} />
        <IconButton size="sm" icon={<Redo2 size={14} />} aria-label={t('editor.pdfReview.redo')}
          disabled={!enabled || !snapshot.canRedo} onClick={() => session.redo()} />
      </div>
      <div className="pdf-review-editor__tools">
        <Tooltip content={t('editor.pdfReview.comments')} placement="bottom">
          <IconButton size="sm" icon={<MessageSquareText size={15} />} aria-label={t('editor.pdfReview.comments')}
            aria-pressed={commentsOpen} onClick={() => setCommentsOpen(value => !value)} />
        </Tooltip>
        <Button size="sm" variant="outline" leadingIcon={<Save size={14} />} disabled={!copyEnabled}
          onClick={() => void run('save')}>{t(operation === 'save' ? 'editor.pdfReview.saving' : 'editor.pdfReview.savePdf')}</Button>
        <Tooltip content={t('editor.pdfReview.export')} placement="bottom">
          <IconButton size="sm" icon={<Download size={15} />} aria-label={t('editor.pdfReview.export')}
            disabled={!copyEnabled} onClick={() => void run('export')} />
        </Tooltip>
      </div>
    </div>
    {copyBlock && <div className="pdf-review-editor__notice" role="status">
      {t(copyBlock === 'encrypted' ? 'editor.pdfReview.encrypted' : 'editor.pdfReview.exportUnavailable')}
    </div>}
    {stale && <div className="pdf-review-editor__notice" role="status">
      {t('editor.pdfReview.recompiled')}
      <Button size="sm" disabled={!enabled} onClick={() => session.confirmCurrentLayout()}>{t('editor.pdfReview.confirmLayout')}</Button>
    </div>}
    {snapshot.conflict ? <div className="pdf-review-editor__notice" role="alert">
      {t('editor.pdfReview.conflict')} {error && <span>{error}</span>}
      <Button size="sm" disabled={!enabled || resolving} onClick={() => void resolveConflict('local')}>{t('editor.pdfReview.keepMine')}</Button>
      <Button size="sm" disabled={!enabled || resolving} onClick={() => void resolveConflict('host')}>{t('editor.pdfReview.reloadFile')}</Button>
    </div> : (snapshot.error || error) && <div className="pdf-review-editor__notice" role="alert">
      {t('editor.pdfReview.saveFailed')} <span>{snapshot.error || error}</span>
      <Button size="sm" onClick={() => { void session.retry().catch(() => undefined); }}>{t('editor.common.retry')}</Button>
    </div>}
    {message && <div className="pdf-review-editor__notice" role="status">{message}</div>}
    <div className="pdf-review-editor__body">
      <div className="pdf-review-editor__viewer"><PdfViewer {...props} pdfBase64={preparedPdf?.input === (props.pdfBase64 ?? props.filePath) ? preparedPdf.base64 : props.pdfBase64} onDocumentLoaded={onLoaded} requestedPage={requestedPage}
        review={{ annotations: snapshot.data.annotations, tool, color, enabled, selectedId,
          noteLabel: t('editor.pdfReview.note'), onAdd: add, onSelect: select }} /></div>
      {commentsOpen && <aside className="pdf-review-editor__comments" aria-label={t('editor.pdfReview.comments')}
        data-openbitfun-component="pdf-viewer" data-openbitfun-part="comments">
        <header><strong>{t('editor.pdfReview.comments')}</strong>
          <IconButton size="sm" aria-label={t('editor.pdfReview.closeComments')} icon={<X size={14} />} onClick={() => setCommentsOpen(false)} /></header>
        <div className="pdf-review-editor__thread-list">
          {!snapshot.data.annotations.length && <p className="pdf-review-editor__hint">{t('editor.pdfReview.empty')}</p>}
          {snapshot.data.annotations.map(annotation => <article key={annotation.id} className="pdf-review-editor__thread"
            data-selected={selectedId === annotation.id} data-resolved={annotation.resolved || undefined}>
            <button className="pdf-review-editor__thread-title" onClick={() => {
              select(annotation.id); setRequestedPage(annotation.page);
            }}><span>{t('editor.pdfReview.page', { page: formatNumber(annotation.page) })}</span>
              <span>{t(`editor.pdfReview.${annotation.kind}`)}</span></button>
            {annotation.quote && <blockquote>{annotation.quote}</blockquote>}
            {annotation.comments.map(comment => <div className="pdf-review-editor__comment" key={comment.id}>
              <p>{comment.body}</p><IconButton size="sm" icon={<Pencil size={12} />} aria-label={t('editor.pdfReview.editComment')}
                disabled={!enabled} onClick={() => {
                  if (selectedId === annotation.id && editingComment === comment.id) {
                    select(annotation.id);
                    return;
                  }
                  if (selectedId === annotation.id) commitDraft();
                  select(annotation.id);
                  setEditingComment(comment.id); setDraft(comment.body); draftRef.current = comment.body;
                }} />
            </div>)}
            {selectedId === annotation.id && <>
              <Textarea aria-label={t('editor.pdfReview.commentPlaceholder')} value={draft} rows={3}
                placeholder={t('editor.pdfReview.commentPlaceholder')} onChange={event => setDraft(event.target.value)} />
              <div className="pdf-review-editor__thread-actions">
                <Button size="sm" disabled={!draft.trim() || !enabled} onClick={() => {
                  commitDraft();
                }}>{t(editingComment ? 'editor.pdfReview.saveComment' : 'editor.pdfReview.addComment')}</Button>
                <IconButton size="sm" aria-label={t(annotation.resolved ? 'editor.pdfReview.reopen' : 'editor.pdfReview.resolve')}
                  icon={<Check size={14} />} aria-pressed={!!annotation.resolved} disabled={!enabled}
                  onClick={() => session.replace(snapshot.data.annotations.map(item => item.id === annotation.id ? { ...item, resolved: !item.resolved } : item))} />
                <IconButton size="sm" icon={<Trash2 size={14} />} aria-label={t('editor.pdfReview.remove')} disabled={!enabled}
                  onClick={() => { session.replace(snapshot.data.annotations.filter(item => item.id !== annotation.id)); setSelectedId(undefined); }} />
              </div>
            </>}
          </article>)}
        </div>
        <footer role="status">{t(snapshot.saving ? 'editor.pdfReview.saving' : snapshot.dirty ? 'editor.pdfReview.unsaved' : 'editor.pdfReview.saved')}</footer>
      </aside>}
    </div>
    {tool !== 'select' && <div className="pdf-review-editor__hint-bar" role="status">{t(`editor.pdfReview.hints.${tool}`)}</div>}
  </section>;
}
