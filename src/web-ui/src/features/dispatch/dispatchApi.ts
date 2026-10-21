import { api } from '@/infrastructure/api/service-api/ApiClient';
import type {
  DispatchApprovalPolicy,
  DispatchCancelResponse,
  DispatchCliRelease,
  DispatchInstallPoll,
  DispatchInstallStart,
  DispatchProvisionTargetResult,
  DispatchContinueResponse,
  DispatchJobListEntry,
  DispatchSshProbe,
  DispatchStatusResponse,
  DispatchSubmitResponse,
  DispatchSyncResult,
  DispatchTargetOption,
  DispatchTargetRequest,
  DispatchTranscriptCache,
  OutboundDispatchRecord,
} from './types';

/** One inline image attachment forwarded to the target with the turn. */
export interface DispatchInlineAttachment {
  id: string;
  name?: string;
  mimeType: string;
  dataUrl: string;
}

export const dispatchApi = {
  async listTargets(): Promise<DispatchTargetOption[]> {
    return api.invoke<DispatchTargetOption[]>('dispatch_list_targets', {
      request: {},
    });
  },

  async probeTarget(target: DispatchTargetRequest): Promise<DispatchSshProbe> {
    return api.invoke<DispatchSshProbe>('dispatch_probe_target', {
      request: { target },
    });
  },

  async installCliStart(
    connectionId: string,
    release: DispatchCliRelease,
  ): Promise<DispatchInstallStart> {
    return api.invoke<DispatchInstallStart>('dispatch_install_cli_start', {
      request: { connectionId, release },
    });
  },

  async installCliPoll(connectionId: string, cursor: number): Promise<DispatchInstallPoll> {
    return api.invoke<DispatchInstallPoll>('dispatch_install_cli_poll', {
      request: { connectionId, cursor },
    });
  },

  async installCliCancel(connectionId: string): Promise<void> {
    return api.invoke<void>('dispatch_install_cli_cancel', {
      request: { connectionId },
    });
  },

  async provisionTarget(connectionId: string): Promise<DispatchProvisionTargetResult> {
    return api.invoke<DispatchProvisionTargetResult>('dispatch_provision_target', {
      request: { connectionId },
    });
  },

  /**
   * Bring a job's work back into this controller's baseline worktree.
   *
   * One call, both halves: the target commits and bundles its branch, then the
   * controller fast-forwards its baseline onto it. The user's own checkout is
   * never touched — the baseline worktree is a separate directory.
   */
  async syncResult(jobId: string, message?: string): Promise<DispatchSyncResult> {
    return api.invoke<DispatchSyncResult>('dispatch_sync_result', {
      request: { jobId, message },
    });
  },

  /**
   * Push this device's model configuration, API keys included, to an SSH
   * target.
   *
   * Submission does this on its own whenever the target cannot serve the
   * chosen model, so this is the explicit form of an otherwise automatic
   * step — kept for callers that want to re-push without starting a job.
   */
  async syncModelConfig(connectionId: string): Promise<void> {
    return api.invoke<void>('dispatch_sync_model_config', {
      request: { connectionId },
    });
  },

  async submit(request: {
    target: DispatchTargetRequest;
    baseRef?: string;
    includeUncommitted: boolean;
    jobId: string;
    sessionId: string;
    agentType: string;
    prompt: string;
    approvalPolicy: DispatchApprovalPolicy;
    model?: string;
    reasoningPreset?: string;
    title?: string;
    sourceWorkspacePath?: string;
    sourceWorkspaceId?: string;
    attachments?: DispatchInlineAttachment[];
  }): Promise<DispatchSubmitResponse> {
    return api.invoke<DispatchSubmitResponse>('dispatch_submit', {
      request,
    });
  },

  /**
   * Start the next turn of a dispatch session.
   *
   * Distinct from `append`, which steers a turn that is still running: this is
   * for a job whose previous turn has finished. The target keeps its session,
   * worktree, and event log, so the projection stays one continuous transcript.
   */
  async continueJob(
    jobId: string,
    turnId: string,
    prompt: string,
    displayContent?: string,
    options?: {
      /** Per-turn model override; carries forward as the job's model. */
      model?: string;
      /** Per-turn target-owned reasoning preset; `auto` clears the override. */
      reasoningPreset?: string;
      /** Per-turn approval-policy override with the same carry-forward rule. */
      approvalPolicy?: DispatchApprovalPolicy;
      /** Operation kind; defaults to an ordinary prompt turn. */
      kind?: 'prompt' | 'compact';
      force?: boolean;
      attachments?: DispatchInlineAttachment[];
    },
  ): Promise<DispatchContinueResponse> {
    return api.invoke<DispatchContinueResponse>('dispatch_continue', {
      request: {
        jobId,
        turnId,
        prompt,
        displayContent,
        model: options?.model,
        reasoningPreset: options?.reasoningPreset,
        approvalPolicy: options?.approvalPolicy,
        kind: options?.kind,
        ...(options?.force ? { force: true } : {}),
        attachments: options?.attachments,
      },
    });
  },

  /** Read-only persisted-state question answered without starting a turn. */
  async query(jobId: string, kind: 'usageReport'): Promise<{ kind: string; report: unknown }> {
    return api.invoke<{ kind: string; report: unknown }>('dispatch_query', {
      request: { jobId, kind },
    });
  },

  async readFile(jobId: string, filePath: string): Promise<{
    kind: 'readFile'; jobId: string; sessionId: string; filePath: string; content: string;
  }> {
    return api.invoke('dispatch_query', {
      request: { jobId, kind: 'readFile', filePath },
    });
  },

  async readFileChunk(jobId: string, filePath: string, fileChunk: {
    offset: number; limit: number; expectedRevision?: string;
  }): Promise<{
    kind: 'readFileChunk'; jobId: string; sessionId: string; filePath: string;
    name: string; mimeType: string; totalSize: number; offset: number;
    chunkSize: number; contentBase64: string; revision: string;
  }> {
    return api.invoke('dispatch_query', {
      request: { jobId, kind: 'readFileChunk', filePath, fileChunk },
    });
  },

  async status(jobId: string, cursor: number): Promise<DispatchStatusResponse> {
    return api.invoke<DispatchStatusResponse>('dispatch_status', {
      request: { jobId, cursor },
    });
  },

  async cancel(jobId: string): Promise<DispatchCancelResponse> {
    return api.invoke<DispatchCancelResponse>('dispatch_cancel', {
      request: { jobId },
    });
  },

  async answerPermission(
    jobId: string,
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    feedback?: string,
  ): Promise<{ resolved: boolean }> {
    return api.invoke<{ resolved: boolean }>('dispatch_answer', {
      request: {
        jobId,
        requestId,
        reply,
        ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
      },
    });
  },

  async append(
    jobId: string,
    content: string,
    displayContent?: string,
    messageId: string = globalThis.crypto?.randomUUID?.()
      ?? `dispatch-message-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    attachments?: DispatchInlineAttachment[],
  ): Promise<{ accepted: boolean; messageId: string }> {
    return api.invoke<{ accepted: boolean; messageId: string }>('dispatch_append', {
      request: {
        jobId,
        messageId,
        content,
        ...(displayContent?.trim() ? { displayContent } : {}),
        ...(attachments?.length ? { attachments } : {}),
      },
    });
  },

  async listJobs(): Promise<OutboundDispatchRecord[]> {
    return api.invoke<OutboundDispatchRecord[]>('dispatch_list_jobs', {
      request: {},
    });
  },

  async listTargetJobs(target: DispatchTargetRequest): Promise<DispatchJobListEntry[]> {
    return api.invoke<DispatchJobListEntry[]>('dispatch_list_jobs', {
      request: { target },
    });
  },

  /**
   * Read this controller's cached observer transcript for a job.
   *
   * Controller-local only. Returns `null` when nothing is cached, which sends
   * the observer back to replaying the target's event log from byte zero.
   */
  async loadTranscript(jobId: string): Promise<DispatchTranscriptCache | null> {
    return api.invoke<DispatchTranscriptCache | null>('dispatch_load_transcript', {
      request: { jobId },
    });
  },

  /**
   * Persist this controller's observer transcript for a job, or pass `null` to
   * erase it.
   *
   * Resolves `false` when the transcript is above the controller's cache
   * ceiling; the previous entry is kept and observing continues unchanged.
   */
  async saveTranscript(
    jobId: string,
    transcript: DispatchTranscriptCache | null,
  ): Promise<boolean> {
    return api.invoke<boolean>('dispatch_save_transcript', {
      request: { jobId, transcript },
    });
  },
};
