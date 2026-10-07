import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { OverflowText, Button, IconButton } from '@openbitfun/ui';
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { AlertCircle, Keyboard, Loader2 } from 'lucide-react';
import { Checkbox, Textarea, Tooltip, Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { agentAPI } from '@/infrastructure/api';
import type {
  BackgroundCommandOutputMetadata,
  BackgroundCommandOutputStatus,
} from '@/infrastructure/api/service-api/AgentAPI';
import type { TerminalProjection } from './backgroundTerminalReplay';
import { notificationService } from '@/shared/notification-system';
import {
  isPeerDeviceModeActive,
  PEER_MODE_BACKGROUND_COMMAND_POLL_MS,
} from '@/infrastructure/peer-device/peerModeFlag';
import './BackgroundCommandOutputPanel.scss';

const BackgroundTerminalProjection = lazyWithRecovery(() => import('./BackgroundTerminalProjection'));
const BACKGROUND_COMMAND_OUTPUT_POLL_INTERVAL_MS = 1000;

export interface BackgroundCommandOutputPanelData {
  execSessionKey: string;
  execSessionId: number;
  remote: boolean;
  title?: string;
  command?: string;
  mockKind?: string;
}

interface BackgroundCommandOutputPanelProps {
  data: BackgroundCommandOutputPanelData;
}

function mockOutputForKind(mockKind: string | undefined): {
  metadata: BackgroundCommandOutputMetadata;
  output: string;
} {
  const kind = mockKind || 'test';
  const command = kind === 'build'
    ? 'pnpm run desktop:dev -- --profile heavy-ui-check'
    : kind === 'interactive-input'
      ? 'node interactive-test.js'
      : kind === 'finished'
        ? 'node scripts/i18n-audit.mjs'
        : 'cargo test -p terminal-core lifecycle_reports_running_and_natural_exit';
  const status: BackgroundCommandOutputStatus = kind === 'finished' ? 'exited' : 'running';
  const now = Math.floor(Date.now() / 1000);
  const execSessionId = kind === 'interactive-input'
    ? 4216
    : kind === 'build'
      ? 4218
      : kind === 'finished'
        ? undefined
        : 4217;
  const output = kind === 'interactive-input'
    ? '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HEnter your name:\x1b[1C\x1b]0;PowerShell\x07\x1b[?25h'
    : [
        `$ ${command}`,
        'Compiling terminal-core v0.1.0',
        'running 1 test',
        'test exec::tests::lifecycle_reports_running_and_natural_exit ... ok',
        '',
        kind === 'build'
          ? '... earlier output was truncated from the beginning ...'
          : 'test result: ok. 1 passed; 0 failed; 0 ignored',
      ].join('\n');

  return {
    metadata: {
      execSessionId,
      command,
      remote: kind === 'build',
      tty: kind !== 'finished',
      status,
      exitCode: status === 'exited' ? 0 : undefined,
      startedAt: now - 42,
      endedAt: status === 'exited' ? now - 1 : undefined,
      retainedBytes: 734,
      retainedLimitBytes: 1024 * 1024,
      truncatedFromStart: kind === 'build',
    },
    output,
  };
}

function statusLabelKey(status: BackgroundCommandOutputStatus): string {
  return `backgroundCommandOutput.status.${status}`;
}

export const BackgroundCommandOutputPanel: React.FC<BackgroundCommandOutputPanelProps> = ({ data }) => {
  const { t } = useTranslation('flow-chat');
  const [metadata, setMetadata] = useState<BackgroundCommandOutputMetadata | null>(null);
  const [output, setOutput] = useState('');
  const [projection, setProjection] = useState<TerminalProjection | null>(null);
  const [isInputEditorOpen, setIsInputEditorOpen] = useState(false);
  const [inputChars, setInputChars] = useState('');
  const [inputAppendEnter, setInputAppendEnter] = useState(true);
  const [maskInput, setMaskInput] = useState(false);
  const [isSendingInput, setIsSendingInput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const autoOpenedInputForSessionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: number | undefined;
    let sawCompleted = false;
    let replay: import('./backgroundTerminalReplay').BackgroundTerminalReplay | undefined;
    setMetadata(null);
    setOutput('');
    setProjection(null);
    setLoading(true);
    setError(null);

    const readOutput = async () => {
      reading = true;
      let running = true;
      try {
        if (!replay) {
          const module = await import('./backgroundTerminalReplay');
          if (cancelled) return;
          replay = new module.BackgroundTerminalReplay();
        }
        const mock = data.mockKind ? mockOutputForKind(data.mockKind) : null;
        const response = mock ? {
          metadata: mock.metadata, cursor: 1, reset: false,
          snapshot: mock.output, chunks: [],
        } : await agentAPI.readBackgroundCommandOutput({
          execSessionId: data.execSessionId, remote: data.remote, cursor,
        });
        if (cancelled) return;
        const nextProjection = await replay.accept(response);
        if (cancelled) return;
        const previousCursor = cursor;
        cursor = response.cursor;
        setMetadata(response.metadata);
        setProjection(nextProjection);
        setOutput(replay.rawOutput);
        setError(null);
        // Lifecycle completion and output capture arrive on separate queues.
        // Drain until a completed command returns an unchanged cursor.
        const completed = response.metadata.status !== 'running';
        running = !mock && (!completed || !sawCompleted || previousCursor !== cursor);
        sawCompleted = completed;
      } catch (readError) {
        if (!cancelled) setError(readError instanceof Error ? readError.message : String(readError));
      } finally {
        reading = false;
        if (cancelled) replay?.dispose();
        else {
          setLoading(false);
          if (running) timer = setTimeout(() => { void readOutput(); }, isPeerDeviceModeActive()
            ? PEER_MODE_BACKGROUND_COMMAND_POLL_MS : BACKGROUND_COMMAND_OUTPUT_POLL_INTERVAL_MS);
        }
      }
    };
    void readOutput();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Dispose only after the queued parser write completes.
      // If idle, no write is in flight and disposal is immediate below.
      if (!reading) replay?.dispose();
    };
  }, [data.execSessionId, data.execSessionKey, data.mockKind, data.remote]);

  const command = metadata?.command || data.command || data.title || data.execSessionKey;
  const copyOutput = () => {
    void navigator.clipboard.writeText(projection?.text ?? '');
  };
  const copyRawOutput = () => { void navigator.clipboard.writeText(output); };

  const copyCommand = () => {
    void navigator.clipboard.writeText(command);
  };

  const canSendInput =
    metadata?.status === 'running' &&
    metadata.execSessionId != null &&
    metadata.tty === true;

  useEffect(() => {
    autoOpenedInputForSessionRef.current = null;
    setIsInputEditorOpen(false);
  }, [data.execSessionKey]);

  useEffect(() => {
    if (!canSendInput) {
      return;
    }
    if (autoOpenedInputForSessionRef.current === data.execSessionKey) {
      return;
    }
    autoOpenedInputForSessionRef.current = data.execSessionKey;
    setIsInputEditorOpen(true);
  }, [canSendInput, data.execSessionKey]);

  const handleToggleInputEditor = () => {
    if (!canSendInput) {
      return;
    }
    setIsInputEditorOpen((open) => !open);
  };

  const handleCloseInputEditor = () => {
    if (isSendingInput) {
      return;
    }
    setIsInputEditorOpen(false);
  };

  const canSubmitInput = canSendInput && (inputChars.length > 0 || inputAppendEnter);

  const handleSendInput = async () => {
    if (!canSendInput || metadata?.execSessionId == null) {
      return;
    }

    setIsSendingInput(true);
    try {
      if (data.mockKind) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
      } else {
        await agentAPI.sendBackgroundCommandInput({
          execSessionId: metadata.execSessionId,
          remote: metadata.remote === true,
          chars: inputChars,
          appendEnter: inputAppendEnter,
        });
      }
      setInputChars('');
    } catch {
      notificationService.error(
        t('backgroundCommandInput.sendFailed'),
        { duration: 5000 },
      );
    } finally {
      setIsSendingInput(false);
    }
  };

  useEffect(() => {
    if (!canSendInput) {
      setIsInputEditorOpen(false);
    }
  }, [canSendInput]);

  useEffect(() => {
    if (!isInputEditorOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      inputEditorRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isInputEditorOpen]);

  return (
    <>
      <section data-openbitfun-component="background-command-output-panel" data-openbitfun-part="root" data-openbitfun-state={[loading && 'loading', error && 'error'].filter(Boolean).join(' ') || undefined} className="background-command-output-panel">
        <header data-openbitfun-component="background-command-output-panel" data-openbitfun-part="header" className="background-command-output-panel__header">
          <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="title" className="background-command-output-panel__title-group">
            <span className="background-command-output-panel__icon">
              <Icon name="terminal" size="md" aria-hidden="true" />
            </span>
            <div>
              <h2>{t('backgroundCommandOutput.title')}</h2>
              <p title={command}><OverflowText>{command}</OverflowText></p>
            </div>
          </div>
          <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="headerActions" className="background-command-output-panel__header-actions">
            <Tooltip content={canSendInput
                ? t('backgroundCommandOutput.sendInput')
                : t('backgroundCommandOutput.sendInputUnavailable')}>
              <IconButton
                size="sm"
                onClick={handleToggleInputEditor}
                aria-label={t('backgroundCommandOutput.sendInput')}
                disabled={!canSendInput}
                icon={<Keyboard size={14} aria-hidden="true" />}
              />
            </Tooltip>
            <Tooltip content={t('backgroundCommandOutput.copyCommand')}>
              <IconButton
                size="sm"
                onClick={copyCommand}
                aria-label={t('backgroundCommandOutput.copyCommand')}
                disabled={!command}
                icon={<Icon name="duplicate" size="sm" aria-hidden="true" />}
              />
            </Tooltip>
            <Tooltip content={t('backgroundCommandOutput.copyRaw')}>
            <IconButton size="sm" onClick={copyRawOutput}
              aria-label={t('backgroundCommandOutput.copyRaw')} disabled={!output}
              icon={<Icon name="terminal" size="sm" aria-hidden="true" />} />
          </Tooltip>
          <Tooltip content={t('backgroundCommandOutput.copy')}>
              <IconButton
                size="sm"
                onClick={copyOutput}
                aria-label={t('backgroundCommandOutput.copy')}
                disabled={!projection?.text}
                icon={<Icon name="duplicate" size="sm" aria-hidden="true" />}
              />
            </Tooltip>
          </div>
        </header>

        <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="meta" className="background-command-output-panel__meta">
          <div className="background-command-output-panel__meta-status">
            {metadata ? (
              <>
                <span>{t(statusLabelKey(metadata.status))}</span>
                {metadata.remote ? <span>{t('backgroundCommandOutput.remote')}</span> : null}
                {metadata.execSessionId != null ? (
                  <span>{t('backgroundCommandOutput.session', { id: metadata.execSessionId })}</span>
                ) : null}
                {metadata.exitCode != null ? (
                  <span>{t('backgroundCommandOutput.exitCode', { code: metadata.exitCode })}</span>
                ) : null}
              </>
            ) : loading ? (
              <span className="background-command-output-panel__loading">
                <Icon glyph={Loader2} size="sm" aria-hidden="true" />
                {t('backgroundCommandOutput.loading')}
              </span>
            ) : null}
          </div>
        </div>

        {metadata?.truncatedFromStart || projection?.incomplete ? (
          <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="notice" className="background-command-output-panel__notice">
            <Icon glyph={AlertCircle} size="sm" aria-hidden="true" />
            <span>{t(projection?.incomplete ? 'backgroundCommandOutput.replayIncomplete' : 'backgroundCommandOutput.truncatedFromStart')}</span>
          </div>
        ) : null}

        {error ? (
          <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="error" className="background-command-output-panel__error">
            <Icon glyph={AlertCircle} size="sm" aria-hidden="true" />
            <span>{t('backgroundCommandOutput.error', { message: error })}</span>
          </div>
        ) : null}

        <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="output" className="background-command-output-panel__output">
          {projection?.unknownGeometry ? (
            <div className="background-command-output-panel__empty">
              {t('backgroundCommandOutput.unknownGeometry')}
            </div>
          ) : projection?.text ? (
            <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="terminal" className="background-command-output-panel__terminal-container">
              <Suspense fallback={<pre className="background-command-output-panel__projection-fallback">{projection.text}</pre>}>
                <BackgroundTerminalProjection projection={projection} />
              </Suspense>
            </div>
          ) : (
            <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="empty" className="background-command-output-panel__empty">
              {loading ? t('backgroundCommandOutput.loading') : t('backgroundCommandOutput.empty')}
            </div>
          )}
        </div>
        {isInputEditorOpen ? (
          <form
            data-openbitfun-component="background-command-output-panel"
            data-openbitfun-part="inputEditor"
            className="background-command-output-panel__input-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmitInput && !isSendingInput) {
                void handleSendInput();
              }
            }}
          >
            <Textarea
              ref={inputEditorRef}
              className={maskInput ? 'background-command-output-panel__input-textarea background-command-output-panel__input-textarea--masked' : 'background-command-output-panel__input-textarea'}
              value={inputChars}
              onChange={(event) => setInputChars(event.target.value)}
              placeholder={t('backgroundCommandInput.inputPlaceholder')}
              rows={3}
              disabled={!canSendInput || isSendingInput}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="background-command-output-panel__input-editor-footer">
              <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="inputOptions" className="background-command-output-panel__input-options">
                <Checkbox
                  className="background-command-output-panel__input-option"
                  size="sm"
                  checked={inputAppendEnter}
                  onChange={(event) => setInputAppendEnter(event.target.checked)}
                  disabled={!canSendInput || isSendingInput}
                  label={t('backgroundCommandInput.appendEnter')}
                />
                <Checkbox
                  className="background-command-output-panel__input-option"
                  size="sm"
                  checked={maskInput}
                  onChange={(event) => setMaskInput(event.target.checked)}
                  disabled={!canSendInput || isSendingInput}
                  label={t('backgroundCommandInput.maskInput')}
                />
              </div>
              <div data-openbitfun-component="background-command-output-panel" data-openbitfun-part="inputActions" className="background-command-output-panel__input-editor-actions">
                <Button
                  type="button"
                  variant="fill"
                  size="sm"
                  onClick={handleCloseInputEditor}
                  disabled={isSendingInput}
                >
                  {t('backgroundCommandInput.cancel')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={isSendingInput}
                  disabled={!canSubmitInput}
                >
                  {t('backgroundCommandInput.send')}
                </Button>
              </div>
            </div>
          </form>
        ) : null}
      </section>
    </>
  );
};

export default BackgroundCommandOutputPanel;
