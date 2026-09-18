import { downloadRuntimeFile } from '../services/RuntimeFileDownload';
import { newUploadId, uploadRuntimeFile, type UploadProgress } from '../services/RuntimeFileUpload';
import { sha256 } from '@noble/hashes/sha2.js';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownUp, ArrowUp, ChevronRight, Download, File, FilePlus2, Folder, FolderPlus, LoaderCircle, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { MobileBanner, MobileButton, MobileChoiceSheet, MobileFileButton, MobileSheet, MobileTextField } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import type { RemoteSessionManager, WorkspaceInfo } from '../services/RemoteSessionManager';
import './WorkspaceFiles.scss';
import { WorkspaceFileEditor } from './WorkspaceFileEditor';

interface Entry { path: string; name: string; isDirectory: boolean; lastModified?: string | null }
interface DirectoryPage { children: Entry[]; hasMore: boolean; offset: number; limit: number }
type SortOrder = 'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc';
type FileAction = { kind: 'file' } | { kind: 'folder' } | { kind: 'rename'; entry: Entry } | { kind: 'delete'; entry: Entry };
const basename = (path: string) => path.replace(/\/$/, '').split('/').slice(-1)[0] || '/';
const parentPath = (path: string) => path.replace(/\/$/, '').replace(/\/[^/]*$/, '') || '/';
const joinPath = (directory: string, name: string) => name.startsWith('/') ? name : `${directory.replace(/\/$/, '')}/${name}`;

/**
 * Paths and mutations belong to the selected runtime workspace. A runtime
 * workspace is addressed by `workspace_id`; a bare device location (no
 * workspace) is addressed by its captured SSH connection and directory.
 */
export function WorkspaceFiles({ manager, workspace }: { manager: RemoteSessionManager; workspace: Pick<WorkspaceInfo, 'workspace_id' | 'path' | 'remote_connection_id'> }) {
  const { t, formatDate } = useI18n();
  const [directory, setDirectory] = useState(workspace.path ?? '');
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState(workspace.path ?? '');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  const [sort, setSort] = useState<SortOrder>('name-asc');
  const [sortOpen, setSortOpen] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [action, setAction] = useState<FileAction | null>(null);
  const [name, setName] = useState('');
  const [upload, setUpload] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const transfer = useRef<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const originalHash = useRef<string>();
  const dirty = file !== null && content !== savedContent;
  const args = {
    ...(workspace.workspace_id ? { workspaceId: workspace.workspace_id } : {}),
    remoteConnectionId: workspace.remote_connection_id ?? '',
    workspacePath: directory,
  };
  const digest = (text: string) => Array.from(sha256(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, '0')).join('');
  async function perform(operation: (ticket: number) => Promise<void>) {
    const ticket = ++generation.current;
    setBusy(true); setError(null);
    try { await operation(ticket); }
    catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  async function list(path: string, append = false, ordering: SortOrder = sort) {
    const ticket = generation.current;
    const page = await manager.invokeHost<DirectoryPage>('get_directory_children_paginated', { ...args, path, offset: append ? entries.length : 0, limit: 100, sortBy: ordering.startsWith('name') ? 'name' : 'modified', sortOrder: ordering.endsWith('asc') ? 'asc' : 'desc' });
    if (ticket !== generation.current) return;
    setDirectory(path); setPathInput(path); setSort(ordering);
    setEntries(previous => append ? [...previous, ...page.children] : page.children); setMore(page.hasMore);
  }
  function browse(path: string) { if (path !== directory) { setUpload(null); transfer.current = undefined; setAction(null); } void perform(() => list(path)); }
  function beginAction(next: FileAction) { setAction(next); setName('entry' in next ? next.entry.name : ''); }
  async function applyAction(ticket: number) {
    if (!action) return;
    const nextPath = joinPath(directory, name.trim());
    if (action.kind === 'file') {
      await manager.invokeHost('write_file_content', { ...args, filePath: nextPath, workspacePath: directory, content: '', expectedHash: '' });
    } else if (action.kind === 'folder') {
      await manager.invokeHost('create_directory', { ...args, path: nextPath });
    } else if (action.kind === 'rename') {
      const destination = joinPath(parentPath(action.entry.path), name.trim());
      await manager.invokeHost('rename_file', { ...args, oldPath: action.entry.path, newPath: destination });
      if (ticket === generation.current && file && (file === action.entry.path || file.startsWith(`${action.entry.path}/`))) setFile(destination + file.slice(action.entry.path.length));
    } else {
      await manager.invokeHost(action.entry.isDirectory ? 'delete_directory' : 'delete_file', { ...args, path: action.entry.path, ...(action.entry.isDirectory ? { recursive: true } : {}) });
      if (ticket === generation.current && (file === action.entry.path || file?.startsWith(`${action.entry.path}/`))) setFile(null);
    }
    if (ticket !== generation.current) return;
    setAction(null); await list(directory);
  }
  useEffect(() => {
    setUpload(null); setAction(null); setFile(null); transfer.current = undefined; setUploaded(0);
    void perform(() => list(workspace.path ?? ''));
    return () => { generation.current++; };
  }, [manager, workspace.workspace_id, workspace.path, workspace.remote_connection_id]);
  const crumbs = directory.split('/').filter(Boolean).map((label, index, all) => ({ label, path: `${directory.startsWith('/') ? '/' : ''}${all.slice(0, index + 1).join('/')}` }));
  const actionLabel = action?.kind === 'file' ? t('workspace.createFile') : action?.kind === 'folder' ? t('workspace.createFolder') : action?.kind === 'rename' ? t('workspace.renameEntry') : t('workspace.deleteEntry');
  const sortOptions: { value: SortOrder; label: string }[] = [
    { value: 'name-asc', label: t('workspace.sortNameAsc') }, { value: 'name-desc', label: t('workspace.sortNameDesc') },
    { value: 'modified-desc', label: t('workspace.sortModifiedDesc') }, { value: 'modified-asc', label: t('workspace.sortModifiedAsc') },
  ];
  const modifiedLabel = (value?: string | null) => {
    if (!value) return '';
    const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
    return Number.isFinite(date.getTime()) ? formatDate(date, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  };
  return <section className="runtime-files" aria-label={t('workspace.files')}>
    <div className="runtime-files__navigation">
      <MobileButton className="runtime-files__icon" size="sm" appearance="plain" disabled={busy || directory === '/'} aria-label={t('workspace.parentFolder')} onClick={() => browse(parentPath(directory))}><ArrowUp size={17} /></MobileButton>
      {!editingPath && <nav className="runtime-files__breadcrumbs" aria-label={t('workspace.targetPath')}>
        {directory.startsWith('/') && <MobileButton size="sm" appearance="plain" disabled={busy} onClick={() => browse('/')}>/</MobileButton>}
        {crumbs.map(crumb => <React.Fragment key={crumb.path}><ChevronRight size={13} aria-hidden /><MobileButton size="sm" appearance="plain" disabled={busy} title={crumb.path} onClick={() => browse(crumb.path)}>{crumb.label}</MobileButton></React.Fragment>)}
      </nav>}
      {!editingPath && <MobileButton className="runtime-files__icon" size="sm" appearance="plain" aria-label={t('workspace.targetPath')} onClick={() => { setPathInput(directory); setEditingPath(true); }}><Pencil size={16}/></MobileButton>}
    {editingPath && <form className="runtime-files__path" onSubmit={event => { event.preventDefault(); browse(pathInput); setEditingPath(false); }}>
      <MobileTextField autoFocus value={pathInput} aria-label={t('workspace.targetPath')} placeholder={t('workspace.pathPlaceholder')} onChange={event => setPathInput(event.target.value)} disabled={busy} />
      <MobileButton size="sm" type="submit" disabled={busy || !pathInput.trim()}>{t('workspace.browse')}</MobileButton>
      <MobileButton size="sm" appearance="plain" aria-label={t('common.cancel')} onClick={() => setEditingPath(false)}><X size={16}/></MobileButton>
    </form>}
    </div>
    <div className="runtime-files__toolbar">
      <div className="runtime-files__tools">
        <MobileButton size="sm" leading={<FilePlus2 size={16} />} disabled={busy} onClick={() => beginAction({ kind: 'file' })}>{t('workspace.createFile')}</MobileButton>
        <MobileButton size="sm" leading={<FolderPlus size={16} />} disabled={busy} onClick={() => beginAction({ kind: 'folder' })}>{t('workspace.createFolder')}</MobileButton>
        <MobileFileButton leading={<Upload size={16} />} disabled={busy} onChange={event => { setUpload(event.target.files?.[0] ?? null); transfer.current = newUploadId(); setUploaded(0); event.target.value = ''; }}>{t('workspace.uploadFile')}</MobileFileButton>
      </div>
    </div>
      <div className="runtime-files__title"><MobileButton className="runtime-files__sort" size="sm" appearance="plain" leading={<ArrowDownUp size={16} />} disabled={busy} onClick={() => setSortOpen(true)}>{sortOptions.find(option => option.value === sort)?.label}</MobileButton>        <MobileButton className="runtime-files__icon" size="sm" appearance="plain" aria-label={t('devices.refresh')} disabled={busy} onClick={() => browse(directory)}><RefreshCw size={17} /></MobileButton></div>
    {error && <MobileBanner tone="danger">{error}</MobileBanner>}
    {action && action.kind !== 'delete' && <form className="runtime-files__action" onSubmit={event => { event.preventDefault(); void perform(applyAction); }}>
      <div><strong>{actionLabel}</strong>{'entry' in action && <p>{action.entry.path}</p>}</div>
      <MobileTextField autoFocus value={name} onChange={event => setName(event.target.value)} aria-label={t('workspace.fileName')} placeholder={t('workspace.fileName')} disabled={busy} />
      <div className="runtime-files__action-buttons"><MobileButton size="sm" appearance="plain" disabled={busy} onClick={() => setAction(null)}>{t('common.cancel')}</MobileButton><MobileButton type="submit" size="sm" appearance="primary" disabled={busy || !name.trim()}>{actionLabel}</MobileButton></div>
    </form>}
    {action?.kind === 'delete' && <MobileSheet open className="runtime-files-delete-sheet" title={actionLabel}
      onOpenChange={open => { if (!open && !busy) setAction(null); }}
      footer={<div className="runtime-files__action-buttons">
        <MobileButton appearance="plain" disabled={busy} onClick={() => setAction(null)}>{t('common.cancel')}</MobileButton>
        <MobileButton appearance="danger" disabled={busy} onClick={() => void perform(applyAction)}>{actionLabel}</MobileButton>
      </div>}>
      <p className="runtime-files-delete-sheet__path">{action.entry.path}</p>
      {action.entry.isDirectory && <p>{t('workspace.deleteDirectoryHint')}</p>}
      {error && <MobileBanner tone="danger">{error}</MobileBanner>}
    </MobileSheet>}
    {upload && <div className="runtime-files__upload">
      <Upload size={18} aria-hidden /><div><strong>{upload.name}</strong><progress max={upload.size || 1} value={uploaded} aria-label={t('workspace.uploadFile')} /></div>
      <MobileButton size="sm" appearance="primary" disabled={busy} onClick={() => void perform(async ticket => {
        if (!workspace.path) throw new Error("Upload workspace path is unavailable");
        await uploadRuntimeFile(upload, { path: joinPath(directory, upload.name), ...args }, transfer.current ?? (transfer.current = newUploadId()), request => manager.invokeHost<UploadProgress>('workspace_file_upload', request), () => ticket === generation.current, setUploaded);
        if (ticket === generation.current) { await list(directory); setUpload(null); transfer.current = undefined; }
      })}>{t('workspace.uploadFile')}</MobileButton>
      <MobileButton className="runtime-files__icon" size="sm" appearance="plain" aria-label={t('common.cancel')} disabled={busy} onClick={() => setUpload(null)}><X size={16} /></MobileButton>
    </div>}
    <div className="runtime-files__panes">
      <div className="runtime-files__listing" aria-busy={busy}>
        {!entries.length && <div className="runtime-files__empty">{busy ? <LoaderCircle size={24} className="runtime-files__spinner" /> : <Folder size={28} />}<span>{busy ? t('common.loading') : t('workspace.emptyDirectory')}</span></div>}
        {entries.map(entry => <div className={`runtime-files__row${file === entry.path ? ' is-selected' : ''}`} key={entry.path}>
          <MobileButton appearance="plain" className="runtime-files__entry" leading={entry.isDirectory ? <Folder size={19} /> : <File size={19} />} trailing={entry.isDirectory ? <ChevronRight size={15} /> : undefined} disabled={busy} title={entry.path} onClick={() => {
            if (entry.isDirectory) { browse(entry.path); return; }
            if (file === entry.path) return;
            if (dirty) { setError(t('workspace.unsavedChanges')); return; }
            void perform(async ticket => {
              const text = await manager.invokeHost<string>('read_file_content', { ...args, filePath: entry.path });
              if (ticket === generation.current) { originalHash.current = digest(text); setFile(entry.path); setContent(text); setSavedContent(text); }
            });
          }}><span className="runtime-files__name">{entry.name}</span>{entry.lastModified && <span className="runtime-files__modified">{modifiedLabel(entry.lastModified)}</span>}</MobileButton>
          <div className="runtime-files__row-actions">
            {!entry.isDirectory && <MobileButton className="runtime-files__icon" size="sm" appearance="plain" aria-label={`${t('chat.clickToDownload')} ${entry.name}`} disabled={busy} onClick={() => void perform(ticket => downloadRuntimeFile(manager, entry.path, { isCurrent: () => ticket === generation.current, workspace: { workspaceId: workspace.workspace_id, path: directory, remoteConnectionId: workspace.remote_connection_id } }))}><Download size={16} /></MobileButton>}
            <MobileButton className="runtime-files__icon" size="sm" appearance="plain" aria-label={`${t('workspace.renameEntry')} ${entry.name}`} disabled={busy} onClick={() => beginAction({ kind: 'rename', entry })}><Pencil size={15} /></MobileButton>
            <MobileButton className="runtime-files__icon" size="sm" appearance="plain" aria-label={`${t('workspace.deleteEntry')} ${entry.name}`} disabled={busy} onClick={() => beginAction({ kind: 'delete', entry })}><Trash2 size={15} /></MobileButton>
          </div>
        </div>)}
        {more && <MobileButton block size="sm" appearance="plain" disabled={busy} onClick={() => void perform(() => list(directory, true))}>{t('common.more')}</MobileButton>}
      </div>
    </div>
    <MobileChoiceSheet open={sortOpen} title={t('workspace.sortFiles')} options={sortOptions} selectedValue={sort} cancelLabel={t('common.cancel')} onOpenChange={() => setSortOpen(false)} onSelect={value => { setSortOpen(false); void perform(() => list(directory, false, value as SortOrder)); }} />
    {file && <WorkspaceFileEditor key={file} path={file} content={content} dirty={dirty} busy={busy} error={error} onChange={setContent} onBack={() => setFile(null)} onSave={() => void perform(async ticket => {
      await manager.invokeHost('write_file_content', { ...args, filePath: file, content, workspacePath: directory, expectedHash: originalHash.current });
      if (ticket === generation.current) { originalHash.current = digest(content); setSavedContent(content); }
    })} />}
  </section>;
}
