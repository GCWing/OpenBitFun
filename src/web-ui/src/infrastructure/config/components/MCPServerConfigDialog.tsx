import React, { useEffect, useId, useRef, useState } from 'react';
import {
  Button, Checkbox, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader,
  DialogHeading, DialogTitle, Disclosure, Icon, IconButton, Input, Select, Textarea,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { requestSettingsDraftExit, useSettingsDraft } from '../settingsDraftRegistry';
import {
  createMcpServerDraft, importMcpServers, McpConfigFormError, parseMcpConfigDocument,
  mcpServerDraftToConfig, parseMcpImport, suggestMcpServerId, updateMcpServerConfig, writeMcpServerEntry,
  type McpConfigObject, type McpFormErrorCode, type McpImportCandidate,
  type McpKeyValueRow, type McpServerDraft,
} from './mcpConfigForm';
import './MCPServerConfigDialog.scss';

export interface McpEditorSession {
  mode: 'new' | 'edit' | 'import';
  serverId?: string;
  jsonConfig: string;
  fingerprint: string;
}

interface Props {
  session: McpEditorSession;
  saving: boolean;
  onSave: (jsonConfig: string, fingerprint: string) => Promise<boolean>;
  onClose: () => void;
}

const DRAFT_ID = 'mcp-server-config';

export function MCPServerConfigDialog({ session, saving, onSave, onClose }: Props) {
  const { t, formatNumber } = useI18n('settings/mcp');
  const controlId = useId();
  const [initial] = useState(() => {
    const document = parseMcpConfigDocument(session.jsonConfig);
    const entry = session.serverId === undefined ? undefined : document.mcpServers[session.serverId];
    try { return { document, entry, draft: createMcpServerDraft(session.serverId, entry), advanced: false }; }
    catch { return { document, entry, draft: createMcpServerDraft(session.serverId), advanced: true }; }
  });
  const [draft, setDraft] = useState(initial.draft);
  const [entryBase, setEntryBase] = useState(initial.entry);
  const [jsonMode, setJsonMode] = useState(initial.advanced);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [serverJson, setServerJson] = useState(() => JSON.stringify(initial.entry ?? {}, null, 2));
  const [jsonTouched, setJsonTouched] = useState(false);
  const [idEdited, setIdEdited] = useState(false);
  const [importText, setImportText] = useState('');
  const [candidates, setCandidates] = useState<McpImportCandidate[] | null>(null);
  const [error, setError] = useState<McpConfigFormError | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [fileReadFailed, setFileReadFailed] = useState(false);
  const [reading, setReading] = useState(false);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const readSequence = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  const isImport = session.mode === 'import';
  const isNew = session.mode === 'new';
  const dirty = isImport ? importText.length > 0 : jsonTouched || JSON.stringify(draft) !== JSON.stringify(initial.draft);
  const busy = saving || reading;

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; readSequence.current += 1; };
  }, []);

  const errorMessages: Record<McpFormErrorCode, string> = {
    invalidJson: t('visual.errors.invalidJson'), invalidConfig: t('visual.errors.invalidConfig'),
    advancedRequired: t('visual.errors.advancedRequired'), nameRequired: t('visual.errors.nameRequired'),
    idRequired: t('visual.errors.idRequired'), invalidId: t('visual.errors.invalidId'),
    idConflict: t('visual.errors.idConflict'), commandRequired: t('visual.errors.commandRequired'),
    urlInvalid: t('visual.errors.urlInvalid'), duplicateKey: t('visual.errors.duplicateKey'),
    invalidKey: t('visual.errors.invalidKey'), invalidValue: t('visual.errors.invalidValue'),
    tokenRequired: t('visual.errors.tokenRequired'), timeoutInvalid: t('visual.errors.timeoutInvalid'),
    selectServers: t('visual.errors.selectServers'),
  };
  const title = isImport ? t('visual.importTitle') : isNew ? t('visual.addTitle') : t('visual.editTitle');

  function reportError(cause: unknown) {
    const next = cause instanceof McpConfigFormError ? cause : new McpConfigFormError('invalidJson');
    setError(next);
    const field = formRef.current?.querySelector<HTMLElement>(`[data-mcp-field="${next.field}"]`);
    if (field && advancedRef.current?.contains(field)) setAdvancedOpen(true);
    requestAnimationFrame(() => {
      if (!aliveRef.current) return;
      formRef.current?.querySelector<HTMLElement>(`[data-mcp-field="${next.field}"]`)?.focus();
    });
  }

  function clearErrors() {
    setError(null);
    setSaveFailed(false);
    setFileReadFailed(false);
  }

  function update<K extends keyof McpServerDraft>(field: K, value: McpServerDraft[K]) {
    setDraft(current => ({ ...current, [field]: value }));
    clearErrors();
  }

  function updateCandidate(index: number, change: Partial<McpImportCandidate>) {
    setCandidates(current => current?.map((item, i) => i === index ? { ...item, ...change } : item) ?? null);
    clearErrors();
  }

  function parseServerJson(): McpConfigObject {
    let entry: unknown;
    try { entry = JSON.parse(serverJson); } catch { throw new McpConfigFormError('invalidJson'); }
    const result = parseMcpConfigDocument(JSON.stringify({ mcpServers: { server: entry } }));
    return result.mcpServers.server;
  }

  function serialize(): string {
    if (isImport) return JSON.stringify(importMcpServers(initial.document, candidates ?? []), null, 2);
    if (jsonMode) {
      return JSON.stringify(writeMcpServerEntry(initial.document, draft.id, parseServerJson(), session.serverId), null, 2);
    }
    return JSON.stringify(updateMcpServerConfig(initial.document, draft, session.serverId, entryBase), null, 2);
  }

  async function save(): Promise<boolean> {
    if (busy || busyRef.current) return false;
    setSaveFailed(false);
    let next: string;
    try { next = serialize(); } catch (cause) { reportError(cause); return false; }
    busyRef.current = true;
    try {
      const saved = await onSave(next, session.fingerprint);
      if (aliveRef.current && !saved) setSaveFailed(true);
      return saved;
    } finally { busyRef.current = false; }
  }

  useSettingsDraft({
    id: DRAFT_ID, pageId: 'tools.mcp', label: title, dirty,
    saving: busy, save, discard: onClose,
  });

  function close() {
    if (busy || busyRef.current) return;
    requestSettingsDraftExit([DRAFT_ID], onClose);
  }

  function switchEditor() {
    try {
      if (jsonMode) {
        const entry = parseServerJson();
        const next = createMcpServerDraft(session.serverId ?? draft.id, entry);
        setEntryBase(entry);
        setDraft(isNew ? { ...next, enabled: false } : next);
      } else {
        // JSON is also an escape hatch for an unfinished form. Required-field
        // validation belongs to saving, not switching the editor.
        const entry = mcpServerDraftToConfig(draft, entryBase, { validate: false });
        setServerJson(JSON.stringify(entry, null, 2));
        if (isNew && !draft.id && !idEdited) {
          setDraft(current => ({ ...current, id: suggestMcpServerId(current.name, Object.keys(initial.document.mcpServers)) }));
        }
      }
      clearErrors();
      setJsonMode(!jsonMode);
    } catch (cause) { reportError(cause); }
  }

  function parseImport() {
    try { setCandidates(parseMcpImport(importText, Object.keys(initial.document.mcpServers))); clearErrors(); }
    catch (cause) { setCandidates(null); reportError(cause); }
  }

  async function readImportFile(file?: File) {
    if (!file) return;
    const sequence = ++readSequence.current;
    setReading(true);
    clearErrors();
    try {
      const text = await file.text();
      if (!aliveRef.current || sequence !== readSequence.current) return;
      setImportText(text);
      setCandidates(null);
    } catch {
      if (aliveRef.current && sequence === readSequence.current) setFileReadFailed(true);
    }
    finally { if (aliveRef.current && sequence === readSequence.current) setReading(false); }
  }

  function field(label: string, key: keyof McpServerDraft, children: React.ReactNode, hint?: string) {
    return <div className="mcp-config-editor__field" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="field">
      <label htmlFor={`${controlId}-${key}`}>{label}</label>
      {children}
      {hint && <p className="mcp-config-editor__hint" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="hint">{hint}</p>}
    </div>;
  }

  function inputProps(key: keyof McpServerDraft) {
    return { id: `${controlId}-${key}`, 'data-mcp-field': key, disabled: busy,
      invalid: error?.field === key, 'aria-describedby': error?.field === key ? `${controlId}-error` : undefined };
  }

  function keyValues(key: 'env' | 'headers', label: string) {
    const rows = draft[key];
    const changeRow = (index: number, change: Partial<McpKeyValueRow>) => update(key, rows.map((row, i) => i === index ? { ...row, ...change } : row));
    return <section className="mcp-config-editor__section" aria-label={label} data-openbitfun-component="mcp-config-editor" data-openbitfun-part="section">
      <span>{label}</span>
      {rows.map((row, index) => <div className="mcp-config-editor__key-value" key={index} data-openbitfun-component="mcp-config-editor" data-openbitfun-part="keyValue">
        <Input size="sm" data-mcp-field={key} aria-describedby={error?.field === key ? `${controlId}-error` : undefined} aria-label={t('visual.keyLabel', { field: label, index: formatNumber(index + 1) })} value={row.key} disabled={busy} invalid={error?.field === key} placeholder={t('visual.key')} onChange={event => changeRow(index, { key: event.target.value })} />
        <Input size="sm" type="password" autoComplete="new-password" aria-label={t('visual.valueLabel', { field: label, index: formatNumber(index + 1) })} value={row.value ?? ''} disabled={busy} placeholder={row.value === undefined && row.savedValue !== undefined ? t('visual.savedValue') : t('visual.value')} onChange={event => changeRow(index, { value: event.target.value })} />
        <IconButton type="button" size="sm" aria-label={t('visual.removeRow', { index: formatNumber(index + 1) })} disabled={busy} icon={<Icon name="delete" size="sm" />} onClick={() => update(key, rows.filter((_, i) => i !== index))} />
      </div>)}
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => update(key, [...rows, { key: '', value: '' }])}>{t('visual.addRow')}</Button>
    </section>;
  }

  return <Dialog open onOpenChange={open => { if (!open) close(); }} size="lg" closeOnEscape={!busy} closeOnPointerOutside={false}>
    <DialogHeader><DialogHeading><DialogTitle>{title}</DialogTitle></DialogHeading>{!busy && <DialogClose />}</DialogHeader>
    <DialogBody>
      <div ref={formRef} className="mcp-config-editor" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="root">
        <p className="mcp-config-editor__hint" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="hint">{t('visual.scopeHint')}</p>
        {isImport ? <>
          <label htmlFor={`${controlId}-import`}>{t('visual.pasteConfig')}</label>
          <Textarea id={`${controlId}-import`} data-mcp-field="config" data-testid="mcp-import-input" rows={10} value={importText} disabled={busy} spellCheck={false} onChange={event => { setImportText(event.target.value); setCandidates(null); clearErrors(); }} />
          <div className="mcp-config-editor__actions" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="actions">
            <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label={t('visual.chooseFile')} onChange={event => { void readImportFile(event.target.files?.[0]); event.target.value = ''; }} />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>{t('visual.chooseFile')}</Button>
            <Button size="sm" variant="outline" data-testid="mcp-import-preview" disabled={busy || !importText.trim()} onClick={parseImport}>{t('visual.previewImport')}</Button>
          </div>
          <p className="mcp-config-editor__hint" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="hint">{t('visual.importHint')}</p>
          {candidates?.map((candidate, index) => <div key={candidate.sourceId} className="mcp-config-editor__import-row" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="importRow">
            <Checkbox checked={candidate.selected} disabled={busy} label={candidate.sourceId} onChange={event => updateCandidate(index, { selected: event.target.checked })} />
            <Input data-mcp-field="id" aria-label={t('visual.importId', { name: candidate.sourceId })} value={candidate.targetId} disabled={busy} invalid={candidate.selected && Object.prototype.hasOwnProperty.call(initial.document.mcpServers, candidate.targetId.trim())} onChange={event => updateCandidate(index, { targetId: event.target.value })} />
            {Object.prototype.hasOwnProperty.call(initial.document.mcpServers, candidate.targetId.trim()) && <span className="mcp-config-editor__hint" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="hint">{t('visual.conflictingId')}</span>}
          </div>)}
        </> : <>
          <div className="mcp-config-editor__actions" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="actions">
            <Button size="sm" variant="outline" data-testid="mcp-switch-editor" disabled={busy} onClick={switchEditor}>{jsonMode ? t('visual.backToForm') : t('visual.editJson')}</Button>
          </div>
          {jsonMode ? <>
            {field(t('server.id'), 'id', <Input {...inputProps('id')} value={draft.id} readOnly={!isNew} onChange={event => { setIdEdited(true); update('id', event.target.value); }} />, t('visual.idHint'))}
            <Textarea data-mcp-field="config" data-testid="mcp-server-json" aria-label={t('visual.editJson')} rows={16} value={serverJson} disabled={busy} spellCheck={false} onChange={event => { setServerJson(event.target.value); setJsonTouched(true); clearErrors(); }} />
            <p className="mcp-config-editor__hint" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="hint">{t('jsonEditor.secretWarning')}</p>
          </> : <>
            {field(t('server.name'), 'name', <Input {...inputProps('name')} value={draft.name} onChange={event => {
              const name = event.target.value;
              setDraft(current => ({ ...current, name, id: isNew && !idEdited ? suggestMcpServerId(name, Object.keys(initial.document.mcpServers)) : current.id })); clearErrors();
            }} />)}
            {field(t('visual.connectionType'), 'transport', <Select {...inputProps('transport')} size="sm" value={draft.transport} options={[
              { value: 'streamable-http', label: t('visual.http') }, { value: 'stdio', label: t('visual.stdio') },
              ...(initial.draft.transport === 'sse' ? [{ value: 'sse', label: t('visual.legacySse') }] : []),
            ]} onValueChange={value => update('transport', value as McpServerDraft['transport'])} />)}
            {draft.transport === 'stdio' ? <>
              {field(t('visual.command'), 'command', <Input {...inputProps('command')} value={draft.command} placeholder={t('visual.commandPlaceholder')} onChange={event => update('command', event.target.value)} />, t('visual.commandHint'))}
              <section className="mcp-config-editor__section" aria-label={t('visual.arguments')} data-openbitfun-component="mcp-config-editor" data-openbitfun-part="section">
                <span>{t('visual.arguments')}</span>
                {draft.args.map((argument, index) => <div key={index} className="mcp-config-editor__argument" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="argument">
                  <Input aria-label={t('visual.argumentIndex', { index: formatNumber(index + 1) })} value={argument} disabled={busy} onChange={event => update('args', draft.args.map((item, i) => i === index ? event.target.value : item))} />
                  <IconButton size="sm" aria-label={t('visual.removeRow', { index: formatNumber(index + 1) })} disabled={busy} icon={<Icon name="delete" size="sm" />} onClick={() => update('args', draft.args.filter((_, i) => i !== index))} />
                </div>)}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => update('args', [...draft.args, ''])}>{t('visual.addArgument')}</Button>
              </section>
              {keyValues('env', t('visual.environment'))}
            </> : <>
              {field(t('visual.url'), 'url', <Input {...inputProps('url')} type="url" value={draft.url} placeholder="https://example.com/mcp" onChange={event => update('url', event.target.value)} />)}
              {field(t('visual.authentication'), 'auth', <Select {...inputProps('auth')} size="sm" value={draft.auth} options={[
                ...(!isNew || entryBase ? [{ value: 'preserve', label: t('visual.authPreserve') }] : []),
                { value: 'auto', label: t('visual.authAuto') }, { value: 'oauth', label: t('visual.authOAuth') },
                { value: 'token', label: t('visual.authToken') }, { value: 'headers', label: t('visual.authHeaders') },
              ]} onValueChange={value => update('auth', value as McpServerDraft['auth'])} />, draft.auth === 'preserve' ? t('visual.authPreserveHint') : t('visual.authHint'))}
              {draft.auth === 'token' && field(t('visual.token'), 'token', <Input {...inputProps('token')} type="password" autoComplete="new-password" value={draft.token} onChange={event => update('token', event.target.value)} />)}
              {(draft.auth === 'headers' || (draft.auth === 'preserve' && draft.headers.length > 0)) && keyValues('headers', t('visual.headers'))}
            </>}
            <div
              ref={advancedRef}
              className="mcp-config-editor__advanced"
              data-openbitfun-component="mcp-config-editor"
              data-openbitfun-part="advanced"
            >
              <Disclosure
                summary={t('visual.advanced')}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                disabled={busy}
              >
                <div
                  className="mcp-config-editor__advanced-fields"
                  data-openbitfun-component="mcp-config-editor"
                  data-openbitfun-part="advancedFields"
                >
                  {field(t('server.id'), 'id', (
                    <Input
                      {...inputProps('id')}
                      value={draft.id}
                      readOnly={!isNew}
                      onChange={event => { setIdEdited(true); update('id', event.target.value); }}
                    />
                  ), t('visual.idHint'))}
                  {draft.transport === 'stdio' && field(t('visual.workingDirectory'), 'workingDirectory', (
                    <Input
                      {...inputProps('workingDirectory')}
                      value={draft.workingDirectory}
                      onChange={event => update('workingDirectory', event.target.value)}
                    />
                  ))}
                  {field(t('visual.startupTimeout'), 'startupSeconds', (
                    <Input
                      {...inputProps('startupSeconds')}
                      inputMode="decimal"
                      value={draft.startupSeconds}
                      placeholder={t('visual.defaultTimeout')}
                      onChange={event => update('startupSeconds', event.target.value)}
                    />
                  ))}
                  <Checkbox
                    checked={draft.autoStart}
                    disabled={busy}
                    label={t('visual.autoStart')}
                    onChange={event => update('autoStart', event.target.checked)}
                  />
                  {!isNew && (
                    <Checkbox
                      checked={draft.enabled}
                      disabled={busy}
                      label={t('visual.enabled')}
                      onChange={event => update('enabled', event.target.checked)}
                    />
                  )}
                </div>
              </Disclosure>
            </div>
            <p className="mcp-config-editor__hint" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="hint">{t('visual.credentialHint')}</p>
          </>}
          <p className="mcp-config-editor__hint" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="hint">{isNew ? t('visual.newServerHint') : t('visual.applyHint')}</p>
        </>}
        {error && <p id={`${controlId}-error`} className="mcp-config-editor__error" role="alert" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="error">{errorMessages[error.code]}</p>}
        {saveFailed && <p className="mcp-config-editor__error" role="alert" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="error">{t('visual.saveFailed')}</p>}
        {fileReadFailed && <p className="mcp-config-editor__error" role="alert" data-openbitfun-component="mcp-config-editor" data-openbitfun-part="error">{t('visual.fileReadFailed')}</p>}
      </div>
    </DialogBody>
    <DialogFooter separator>
      <Button variant="fill" disabled={busy} onClick={close}>{t('actions.cancel')}</Button>
      <Button variant="primary" data-testid="mcp-form-save" disabled={busy || (!dirty && !isNew) || (isImport && !candidates?.some(item => item.selected))} loading={saving} onClick={() => void save()}>{isImport ? t('visual.importSelected') : isNew ? t('visual.saveNew') : t('visual.saveApply')}</Button>
    </DialogFooter>
  </Dialog>;
}
