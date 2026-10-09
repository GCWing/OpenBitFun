import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_SPEECH_SAMPLE_RATE,
  LOCAL_SENSEVOICE_SMALL_INT8_MODEL_ID,
  speechAPI,
  type SpeechInputSession,
  type SpeechModelStatus,
} from '@/infrastructure/api';
import { useAIExperienceSettings } from '@/infrastructure/config/hooks';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  createVoiceInputRecorder,
  type VoiceInputRecorder,
} from '@/infrastructure/speech/voiceInputAudio';

const log = createLogger('ComposerVoiceInput');

type VoiceInputPhase = 'idle' | 'setup' | 'downloading' | 'preparing' | 'recording' | 'transcribing';
export type VoiceInputCompletionMode = 'transcribe' | 'send';
interface SelectedModelCapability {
  modelId: string;
  status: SpeechModelStatus | null;
}
const STARTUP_AUDIO_BUFFER_LIMIT_SECONDS = 5;
const RECORDING_CHUNK_DURATION_MS = 1000;
const LOW_VOLUME_LEVEL_THRESHOLD = 0.002;
const LOW_VOLUME_WARNING_DELAY_MS = 3000;
const DEFAULT_LOCAL_VOICE_MODEL_ID = LOCAL_SENSEVOICE_SMALL_INT8_MODEL_ID;

export interface ComposerVoiceInputController {
  enabled: boolean;
  disabled: boolean;
  phase: VoiceInputPhase;
  completionMode: VoiceInputCompletionMode | null;
  audioLevel: number;
  lowVolumeWarning: boolean;
  downloadProgress: number | null;
  setupMessage: string;
  setupActionLabel: string;
  setupCancelTooltip: string;
  lowVolumeTooltip: string;
  tooltip: string;
  cancelTooltip: string;
  transcribeTooltip: string;
  sendTooltip: string;
  toggle: () => void;
  installAndStart: () => void;
  dismissSetup: () => void;
  cancel: () => void;
  transcribe: () => void;
  transcribeAndSend: () => void;
}

export interface UseComposerVoiceInputOptions {
  focusInputSoon: () => void;
  insertText: (text: string) => string | null;
  submitText: (text: string) => Promise<void>;
}

function isMediaCaptureSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

function resolveErrorMessage(error: unknown, permissionDenied: string, fallback: string): string {
  if (error instanceof DOMException && (
    error.name === 'NotAllowedError' ||
    error.name === 'PermissionDeniedError'
  )) {
    return permissionDenied;
  }
  return fallback;
}

function isModelMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('speech model is not installed');
}

function formatModelSize(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  const mebibytes = bytes / (1024 * 1024);
  return `${mebibytes >= 10 ? mebibytes.toFixed(0) : mebibytes.toFixed(1)} MiB`;
}

function estimatePcm16Base64Seconds(pcm16Base64: string, sampleRate: number): number {
  const padding = pcm16Base64.endsWith('==') ? 2 : pcm16Base64.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((pcm16Base64.length * 3) / 4) - padding);
  return bytes / (sampleRate * 2);
}

export function useComposerVoiceInput({
  focusInputSoon,
  insertText,
  submitText,
}: UseComposerVoiceInputOptions): ComposerVoiceInputController {
  const { t } = useTranslation('flow-chat');
  const { settings: aiExperienceSettings } = useAIExperienceSettings();
  const settings = aiExperienceSettings?.voice_input ?? null;
  const selectedProvider = settings?.provider === 'cloud' ? 'cloud' : 'local';
  const selectedModelId = settings?.model_id || DEFAULT_LOCAL_VOICE_MODEL_ID;
  const [modelCapability, setModelCapability] = useState<SelectedModelCapability | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<VoiceInputPhase>('idle');
  const [completionMode, setCompletionMode] = useState<VoiceInputCompletionMode | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [lowVolumeWarning, setLowVolumeWarning] = useState(false);
  const sessionRef = useRef<SpeechInputSession | null>(null);
  const sessionPromiseRef = useRef<Promise<SpeechInputSession> | null>(null);
  const recorderRef = useRef<VoiceInputRecorder | null>(null);
  const pendingAppendRef = useRef<Promise<void>>(Promise.resolve());
  const appendErrorRef = useRef<unknown>(null);
  const latestAudioLevelRef = useRef(0);
  const audioLevelFrameRef = useRef<number | null>(null);
  const activeRecordingIdRef = useRef(0);
  const activeInstallIdRef = useRef(0);
  const capabilityRequestIdRef = useRef(0);
  const bufferedChunksRef = useRef<Array<{ pcm16Base64: string; seconds: number }>>([]);
  const bufferedSecondsRef = useRef(0);
  const cancelRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const recordingLimitTimerRef = useRef<number | null>(null);
  const lowVolumeStartedAtRef = useRef<number | null>(null);
  const speechRuntimeSupported = isTauriRuntime();
  const selectedModelCapability = selectedProvider === 'local'
    && modelCapability?.modelId === selectedModelId
    ? modelCapability
    : null;
  const selectedModelStatus = selectedModelCapability?.status ?? null;
  const modelInstalled = selectedProvider !== 'local'
    ? false
    : selectedModelCapability === null
      ? null
      : selectedModelCapability.status?.state === 'installed';

  const clearRecordingLimitTimer = useCallback(() => {
    if (recordingLimitTimerRef.current !== null) {
      window.clearTimeout(recordingLimitTimerRef.current);
      recordingLimitTimerRef.current = null;
    }
  }, []);

  const openVoiceInputSettings = useCallback(() => {
    useSettingsStore.getState().openDestination({
      pageId: 'application.input', sectionId: 'voice',
    });
    useSceneStore.getState().openScene('settings');
  }, []);

  const refreshCapability = useCallback(async (): Promise<boolean | null> => {
    const requestId = capabilityRequestIdRef.current + 1;
    capabilityRequestIdRef.current = requestId;
    if (!speechRuntimeSupported) {
      setModelCapability(null);
      return null;
    }
    if (selectedProvider !== 'local') {
      setModelCapability(null);
      return false;
    }
    try {
      const modelResponse = await speechAPI.listModels();
      const status = modelResponse.models.find(model => model.modelId === selectedModelId) ?? null;
      const installed = status?.state === 'installed';
      if (capabilityRequestIdRef.current !== requestId) {
        return null;
      }
      setModelCapability({ modelId: selectedModelId, status });
      return installed;
    } catch (error) {
      log.warn('Failed to refresh voice input capability', { error });
      if (capabilityRequestIdRef.current === requestId) {
        setModelCapability(null);
      }
      return null;
    }
  }, [selectedModelId, selectedProvider, speechRuntimeSupported]);

  useEffect(() => {
    if (!speechRuntimeSupported) {
      return undefined;
    }
    if (selectedProvider !== 'local') {
      capabilityRequestIdRef.current += 1;
      setModelCapability(null);
      return undefined;
    }
    void refreshCapability();
    const removeModelListener = speechAPI.onModelStatusChanged(status => {
      if (status.modelId === selectedModelId) {
        capabilityRequestIdRef.current += 1;
        setModelCapability({ modelId: selectedModelId, status });
      }
    });
    const removeProgressListener = speechAPI.onModelProgress(event => {
      if (event.status.modelId === selectedModelId) {
        capabilityRequestIdRef.current += 1;
        setModelCapability({ modelId: selectedModelId, status: event.status });
        setDownloadProgress(Math.min(100, Math.max(0, event.status.progress?.percent ?? 0)));
      }
    });

    return () => {
      capabilityRequestIdRef.current += 1;
      removeModelListener();
      removeProgressListener();
    };
  }, [refreshCapability, selectedModelId, selectedProvider, speechRuntimeSupported]);

  useEffect(() => {
    if (phase !== 'setup' || modelInstalled !== true) return;
    setDownloadProgress(null);
    setPhase('idle');
  }, [modelInstalled, phase]);

  const markSelectedModelMissing = useCallback(() => {
    capabilityRequestIdRef.current += 1;
    setModelCapability(current => ({
      modelId: selectedModelId,
      status: current?.modelId === selectedModelId && current.status
        ? {
            ...current.status,
            state: 'not_installed',
            installedBytes: 0,
            progress: null,
          }
        : null,
    }));
  }, [selectedModelId]);

  useEffect(() => () => {
    activeRecordingIdRef.current += 1;
    activeInstallIdRef.current += 1;
    const session = sessionRef.current;
    const sessionPromise = sessionPromiseRef.current;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    sessionRef.current = null;
    sessionPromiseRef.current = null;
    bufferedChunksRef.current = [];
    bufferedSecondsRef.current = 0;
    lowVolumeStartedAtRef.current = null;
    clearRecordingLimitTimer();
    if (audioLevelFrameRef.current !== null) {
      window.cancelAnimationFrame(audioLevelFrameRef.current);
      audioLevelFrameRef.current = null;
    }
    if (recorder) {
      void recorder.stop().catch(error => {
        log.warn('Failed to stop voice recorder during cleanup', { error });
      });
    }
    if (session) {
      void speechAPI.cancelInputSession(session.sessionId).catch(error => {
        log.warn('Failed to cancel voice input session during cleanup', { error });
      });
    }
    if (sessionPromise) {
      sessionPromise.then(lateSession => {
        if (lateSession.sessionId === session?.sessionId) {
          return;
        }
        return speechAPI.cancelInputSession(lateSession.sessionId).catch(error => {
          log.warn('Failed to cancel late voice input session during cleanup', {
            sessionId: lateSession.sessionId,
            error,
          });
        });
      }).catch(error => {
        log.warn('Voice input session creation failed during cleanup', { error });
      });
    }
  }, [clearRecordingLimitTimer]);

  const updateAudioLevel = useCallback((level: number) => {
    latestAudioLevelRef.current = Math.max(0, Math.min(1, level));
    if (level < LOW_VOLUME_LEVEL_THRESHOLD) {
      const now = performance.now();
      lowVolumeStartedAtRef.current ??= now;
      if (now - lowVolumeStartedAtRef.current >= LOW_VOLUME_WARNING_DELAY_MS) {
        setLowVolumeWarning(true);
      }
    } else {
      lowVolumeStartedAtRef.current = null;
      setLowVolumeWarning(false);
    }
    if (audioLevelFrameRef.current !== null) {
      return;
    }

    audioLevelFrameRef.current = window.requestAnimationFrame(() => {
      audioLevelFrameRef.current = null;
      setAudioLevel(previous =>
        Math.max(0, Math.min(1, previous * 0.35 + latestAudioLevelRef.current * 0.65))
      );
    });
  }, []);

  const appendChunkToSession = useCallback(async (
    session: SpeechInputSession,
    pcm16Base64: string,
  ) => {
    if (sessionRef.current?.sessionId !== session.sessionId) {
      return;
    }
    try {
      await speechAPI.appendAudioChunk(session.sessionId, pcm16Base64);
    } catch (error) {
      appendErrorRef.current = error;
      log.warn('Failed to append voice input chunk', { sessionId: session.sessionId, error });
    }
  }, []);

  const flushBufferedChunks = useCallback((session: SpeechInputSession) => {
    const bufferedChunks = bufferedChunksRef.current;
    bufferedChunksRef.current = [];
    bufferedSecondsRef.current = 0;
    lowVolumeStartedAtRef.current = null;
    setLowVolumeWarning(false);

    for (const chunk of bufferedChunks) {
      pendingAppendRef.current = pendingAppendRef.current
        .catch(() => undefined)
        .then(() => appendChunkToSession(session, chunk.pcm16Base64));
    }
  }, [appendChunkToSession]);

  const attachSession = useCallback((session: SpeechInputSession, recordingId: number) => {
    if (activeRecordingIdRef.current !== recordingId) {
      void speechAPI.cancelInputSession(session.sessionId).catch(error => {
        log.warn('Failed to cancel stale voice input session', { sessionId: session.sessionId, error });
      });
      return;
    }

    sessionRef.current = session;
    appendErrorRef.current = null;
    flushBufferedChunks(session);
  }, [flushBufferedChunks]);

  const enqueueChunk = useCallback((pcm16Base64: string) => {
    const session = sessionRef.current;
    if (!session) {
      const seconds = estimatePcm16Base64Seconds(pcm16Base64, DEFAULT_SPEECH_SAMPLE_RATE);
      if (bufferedSecondsRef.current + seconds > STARTUP_AUDIO_BUFFER_LIMIT_SECONDS) {
        appendErrorRef.current = new Error('Voice input session took too long to start');
        log.warn('Voice input startup buffer limit exceeded', {
          limitSeconds: STARTUP_AUDIO_BUFFER_LIMIT_SECONDS,
          bufferedSeconds: bufferedSecondsRef.current,
        });
        void cancelRecordingRef.current?.();
        return;
      }
      bufferedChunksRef.current.push({ pcm16Base64, seconds });
      bufferedSecondsRef.current += seconds;
      return;
    }

    pendingAppendRef.current = pendingAppendRef.current
      .catch(() => undefined)
      .then(() => appendChunkToSession(session, pcm16Base64));
  }, [appendChunkToSession]);

  const cancelRecording = useCallback(async () => {
    clearRecordingLimitTimer();
    activeRecordingIdRef.current += 1;
    const session = sessionRef.current;
    const sessionPromise = sessionPromiseRef.current;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    sessionRef.current = null;
    sessionPromiseRef.current = null;
    appendErrorRef.current = null;
    pendingAppendRef.current = Promise.resolve();
    bufferedChunksRef.current = [];
    bufferedSecondsRef.current = 0;
    latestAudioLevelRef.current = 0;
    setAudioLevel(0);
    setCompletionMode(null);
    setPhase('idle');

    if (recorder) {
      await recorder.stop().catch(error => {
        log.warn('Failed to stop voice recorder during cancellation', { error });
      });
    }
    if (session) {
      await speechAPI.cancelInputSession(session.sessionId).catch(error => {
        log.warn('Failed to cancel voice input session', { sessionId: session.sessionId, error });
      });
    }
    if (sessionPromise) {
      sessionPromise.then(lateSession => {
        if (lateSession.sessionId === session?.sessionId) {
          return;
        }
        return speechAPI.cancelInputSession(lateSession.sessionId).catch(error => {
          log.warn('Failed to cancel late voice input session', {
            sessionId: lateSession.sessionId,
            error,
          });
        });
      }).catch(error => {
        log.warn('Voice input session creation failed after cancellation', { error });
      });
    }
  }, [clearRecordingLimitTimer]);

  useEffect(() => {
    cancelRecordingRef.current = cancelRecording;
    return () => {
      if (cancelRecordingRef.current === cancelRecording) {
        cancelRecordingRef.current = null;
      }
    };
  }, [cancelRecording]);

  const stopAndTranscribe = useCallback(async (mode: VoiceInputCompletionMode) => {
    clearRecordingLimitTimer();
    let session = sessionRef.current;
    const sessionPromise = sessionPromiseRef.current;
    const recorder = recorderRef.current;
    if (!recorder || (!session && !sessionPromise)) {
      setPhase('idle');
      return;
    }

    setCompletionMode(mode);
    setPhase('transcribing');
    lowVolumeStartedAtRef.current = null;
    setLowVolumeWarning(false);
    latestAudioLevelRef.current = 0;
    setAudioLevel(0);
    try {
      recorderRef.current = null;
      await recorder.stop();
      if (!session && sessionPromise) {
        session = await sessionPromise;
        attachSession(session, activeRecordingIdRef.current);
      }
      if (!sessionRef.current || !session) {
        throw new Error('Voice input session was not ready');
      }
      await pendingAppendRef.current;
      if (appendErrorRef.current) {
        throw appendErrorRef.current;
      }

      const result = await speechAPI.finishInputSession(session.sessionId);
      const text = result.text.trim();
      if (text) {
        const mergedText = insertText(text);
        if (mode === 'send' && mergedText) {
          await submitText(mergedText);
        } else {
          focusInputSoon();
        }
      } else {
        notificationService.info(t('input.voiceInput.empty'));
      }
    } catch (error) {
      log.error('Voice input transcription failed', { sessionId: session?.sessionId, error });
      notificationService.error(resolveErrorMessage(
        error,
        t('input.voiceInput.permissionDenied'),
        t('input.voiceInput.failed'),
      ));
      if (session) {
        const sessionId = session.sessionId;
        await speechAPI.cancelInputSession(session.sessionId).catch(cancelError => {
          log.warn('Failed to cancel voice input session after error', {
            sessionId,
            error: cancelError,
          });
        });
      }
    } finally {
      activeRecordingIdRef.current += 1;
      sessionRef.current = null;
      sessionPromiseRef.current = null;
      appendErrorRef.current = null;
      pendingAppendRef.current = Promise.resolve();
      bufferedChunksRef.current = [];
      bufferedSecondsRef.current = 0;
      setCompletionMode(null);
      setPhase('idle');
    }
  }, [attachSession, clearRecordingLimitTimer, focusInputSoon, insertText, submitText, t]);

  const startRecording = useCallback(async (skipModelCheck = false) => {
    if (!settings?.enabled) {
      notificationService.info(t('input.voiceInput.disabled'));
      return;
    }
    if (!speechRuntimeSupported || !isMediaCaptureSupported()) {
      notificationService.error(t('input.voiceInput.unsupported'));
      return;
    }
    if (settings.provider === 'cloud') {
      notificationService.info(t('input.voiceInput.cloudPending'));
      openVoiceInputSettings();
      return;
    }

    if (!skipModelCheck) {
      let installed = modelInstalled;
      if (installed === null) {
        setPhase('preparing');
        installed = await refreshCapability();
      }
      if (installed === false) {
        setDownloadProgress(null);
        setPhase('setup');
        return;
      }
    }

    setPhase('preparing');
    setCompletionMode(null);
    latestAudioLevelRef.current = 0;
    setAudioLevel(0);
    const recordingId = activeRecordingIdRef.current + 1;
    activeRecordingIdRef.current = recordingId;
    sessionRef.current = null;
    sessionPromiseRef.current = null;
    appendErrorRef.current = null;
    pendingAppendRef.current = Promise.resolve();
    bufferedChunksRef.current = [];
    bufferedSecondsRef.current = 0;
    lowVolumeStartedAtRef.current = null;
    setLowVolumeWarning(false);
    let sessionPromise: Promise<SpeechInputSession> | null = null;
    const startupStartedAt = performance.now();

    try {
      const voiceSettings = settings;
      log.debug('Voice input startup requested', { modelInstalled });
      const recorder = await createVoiceInputRecorder({
        targetSampleRate: DEFAULT_SPEECH_SAMPLE_RATE,
        chunkDurationMs: RECORDING_CHUNK_DURATION_MS,
        microphoneDeviceId: voiceSettings.microphone_device_id || undefined,
        onChunk: enqueueChunk,
        onLevel: updateAudioLevel,
        onDeviceEnded: () => {
          if (activeRecordingIdRef.current !== recordingId) return;
          log.warn('Voice input microphone disconnected during recording');
          notificationService.error(t('input.voiceInput.deviceDisconnected'));
          void cancelRecordingRef.current?.();
        },
        onStartupTiming: timing => {
          log.debug('Voice input recorder startup stage completed', timing);
        },
      });
      if (activeRecordingIdRef.current !== recordingId) {
        await recorder.stop().catch(error => {
          log.warn('Failed to stop stale voice recorder', { error });
        });
        return;
      }
      recorderRef.current = recorder;
      setPhase('recording');
      recordingLimitTimerRef.current = window.setTimeout(() => {
        if (activeRecordingIdRef.current === recordingId && recorderRef.current) {
          void stopAndTranscribe('transcribe');
        }
      }, voiceSettings.max_recording_seconds * 1000);
      log.debug('Voice input recorder ready', {
        startupMs: Math.round(performance.now() - startupStartedAt),
      });

      const sessionStartedAt = performance.now();
      sessionPromise = speechAPI.startInputSession({
        modelId: voiceSettings.model_id || DEFAULT_LOCAL_VOICE_MODEL_ID,
        language: voiceSettings.default_language,
        sampleRate: DEFAULT_SPEECH_SAMPLE_RATE,
        maxRecordingSeconds: voiceSettings.max_recording_seconds,
      });
      sessionPromiseRef.current = sessionPromise;
      sessionPromise
        .then(session => {
          log.debug('Voice input session ready', {
            sessionMs: Math.round(performance.now() - sessionStartedAt),
            startupMs: Math.round(performance.now() - startupStartedAt),
          });
          attachSession(session, recordingId);
        })
        .catch(async error => {
          if (activeRecordingIdRef.current !== recordingId) {
            return;
          }
          log.error('Failed to create voice input session', { error });
          activeRecordingIdRef.current += 1;
          const activeRecorder = recorderRef.current;
          recorderRef.current = null;
          sessionRef.current = null;
          sessionPromiseRef.current = null;
          bufferedChunksRef.current = [];
          bufferedSecondsRef.current = 0;
          latestAudioLevelRef.current = 0;
          setAudioLevel(0);
          setPhase('idle');
          if (activeRecorder) {
            await activeRecorder.stop().catch(stopError => {
              log.warn('Failed to stop recorder after session creation failure', { error: stopError });
            });
          }
          if (isModelMissingError(error)) {
            markSelectedModelMissing();
            setDownloadProgress(null);
            setPhase('setup');
            return;
          }
          notificationService.error(t('input.voiceInput.failed'));
        });
    } catch (error) {
      log.error('Failed to start voice input', { error });
      activeRecordingIdRef.current += 1;
      const session = sessionRef.current as SpeechInputSession | null;
      sessionRef.current = null;
      sessionPromiseRef.current = null;
      bufferedChunksRef.current = [];
      bufferedSecondsRef.current = 0;
      if (session) {
        const sessionId = session.sessionId;
        await speechAPI.cancelInputSession(sessionId).catch(cancelError => {
          log.warn('Failed to cancel voice input session after start failure', {
            sessionId,
            error: cancelError,
          });
        });
      }
      const pendingSessionPromise: Promise<SpeechInputSession> | null = sessionPromise;
      if (pendingSessionPromise) {
        pendingSessionPromise
          .then((lateSession: SpeechInputSession) => speechAPI.cancelInputSession(lateSession.sessionId))
          .catch(sessionError => {
            log.warn('Voice input session creation failed after recorder start failure', {
              error: sessionError,
            });
          });
      }
      if (isModelMissingError(error)) {
        markSelectedModelMissing();
        setDownloadProgress(null);
        setPhase('setup');
        return;
      }
      notificationService.error(resolveErrorMessage(
        error,
        t('input.voiceInput.permissionDenied'),
        t('input.voiceInput.failed'),
      ));
      latestAudioLevelRef.current = 0;
      setAudioLevel(0);
      setPhase('idle');
    }
  }, [attachSession, enqueueChunk, markSelectedModelMissing, modelInstalled, openVoiceInputSettings, refreshCapability, settings, speechRuntimeSupported, stopAndTranscribe, t, updateAudioLevel]);

  const installAndStart = useCallback(async () => {
    if (selectedProvider !== 'local' || phase !== 'setup') return;
    const installId = activeInstallIdRef.current + 1;
    activeInstallIdRef.current = installId;
    setDownloadProgress(0);
    setPhase('downloading');
    try {
      const status = await speechAPI.downloadModel(selectedModelId);
      if (activeInstallIdRef.current !== installId) return;
      capabilityRequestIdRef.current += 1;
      setModelCapability({ modelId: selectedModelId, status });
      setDownloadProgress(status.state === 'installed' ? 100 : null);
      if (status.state !== 'installed') {
        setPhase('setup');
        notificationService.error(t('input.voiceInput.downloadFailed'));
        return;
      }
      await startRecording(true);
    } catch (error) {
      if (activeInstallIdRef.current !== installId) return;
      log.error('Failed to install local speech model from the composer', {
        modelId: selectedModelId,
        error,
      });
      setDownloadProgress(null);
      setPhase('setup');
      notificationService.error(t('input.voiceInput.downloadFailed'));
    }
  }, [phase, selectedModelId, selectedProvider, startRecording, t]);

  const dismissSetup = useCallback(() => {
    const wasDownloading = phase === 'downloading';
    activeInstallIdRef.current += 1;
    setDownloadProgress(null);
    setPhase('idle');
    if (wasDownloading) {
      void speechAPI.cancelModelDownload(selectedModelId).catch(error => {
        log.warn('Failed to cancel local speech model download from the composer', {
          modelId: selectedModelId,
          error,
        });
      });
    }
  }, [phase, selectedModelId]);

  const toggle = useCallback(() => {
    if (phase === 'recording') {
      void stopAndTranscribe('transcribe');
      return;
    }
    if (phase !== 'idle') {
      return;
    }
    void startRecording();
  }, [phase, startRecording, stopAndTranscribe]);

  const cancel = useCallback(() => {
    void cancelRecording();
  }, [cancelRecording]);

  const transcribe = useCallback(() => {
    void stopAndTranscribe('transcribe');
  }, [stopAndTranscribe]);

  const transcribeAndSend = useCallback(() => {
    void stopAndTranscribe('send');
  }, [stopAndTranscribe]);

  useEffect(() => {
    if (phase !== 'recording') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      void cancelRecording();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [cancelRecording, phase]);

  // Keep the idle control clickable when capture is unavailable so the
  // start handler can explain the unsupported state instead of silently
  // presenting a disabled button.
  const disabled = phase === 'preparing' || phase === 'transcribing';
  const tooltip = useMemo(() => {
    if (!settings?.enabled) return t('input.voiceInput.disabled');
    if (!speechRuntimeSupported || !isMediaCaptureSupported()) return t('input.voiceInput.unsupported');
    if (settings.provider === 'cloud') return t('input.voiceInput.cloudPending');
    if (phase === 'setup') return t('input.voiceInput.setupTooltip');
    if (phase === 'downloading') return t('input.voiceInput.downloadingTooltip');
    if (modelInstalled === false) return t('input.voiceInput.modelMissing');
    if (phase === 'preparing') return t('input.voiceInput.preparing');
    if (phase === 'recording') return t('input.voiceInput.stop');
    if (phase === 'transcribing') return t('input.voiceInput.transcribing');
    return t('input.voiceInput.start');
  }, [modelInstalled, phase, settings?.enabled, settings?.provider, speechRuntimeSupported, t]);

  const selectedModelSize = formatModelSize(selectedModelStatus?.expectedBytes);
  const setupMessage = phase === 'downloading'
    ? t('input.voiceInput.downloadingModel', {
        percent: Math.round(downloadProgress ?? selectedModelStatus?.progress?.percent ?? 0),
      })
    : selectedModelSize
      ? t('input.voiceInput.setupRequired', { size: selectedModelSize })
      : t('input.voiceInput.setupRequiredUnknownSize');

  return {
    enabled: settings?.enabled === true && speechRuntimeSupported,
    disabled,
    phase,
    completionMode,
    audioLevel,
    lowVolumeWarning,
    downloadProgress,
    setupMessage,
    setupActionLabel: t('input.voiceInput.downloadAndStart'),
    setupCancelTooltip: t('input.voiceInput.cancelSetup'),
    lowVolumeTooltip: t('input.voiceInput.lowVolume'),
    tooltip,
    cancelTooltip: t('input.cancelShortcut'),
    transcribeTooltip: t('input.voiceInput.transcribeOnly'),
    sendTooltip: t('input.voiceInput.transcribeAndSend'),
    toggle,
    installAndStart,
    dismissSetup,
    cancel,
    transcribe,
    transcribeAndSend,
  };
}
