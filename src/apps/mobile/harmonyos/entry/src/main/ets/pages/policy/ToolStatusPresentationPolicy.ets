import { ConversationUiToolStatus } from '../state/ConversationUiModels';

interface QuestionPreview {
  header?: string;
  question?: string;
}

interface QuestionPreviewPayload {
  question?: string;
  prompt?: string;
  questions?: QuestionPreview[];
}

interface TaskPreviewPayload {
  description?: string;
  task?: string;
  task_name?: string;
  taskName?: string;
  prompt?: string;
  message?: string;
  content?: string;
  title?: string;
  name?: string;
}

/** Pure tool classification and payload projection used by the ArkUI renderer. */
export class ToolStatusPresentationPolicy {
  static normalizedName(tool: ConversationUiToolStatus): string {
    const raw = (tool.name || '').trim();
    return (raw.length > 0 ? raw : 'Tool').replace(/[\s-]/g, '_').toLowerCase();
  }

  static isQuestionLike(tool: ConversationUiToolStatus): boolean {
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return ToolStatusPresentationPolicy.isQuestion(tool) ||
      normalized === 'askuserquestion' || normalized === 'ask_user_question';
  }

  static isTodo(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.normalizedName(tool).indexOf('todo') >= 0;
  }

  static isTask(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.normalizedName(tool) === 'task';
  }

  static isDirectoryList(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'LS' || normalized === 'ls' || normalized === 'list_directory';
  }

  static isFileRead(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'Read' || raw === 'LS' ||
      ToolStatusPresentationPolicy.matches(normalized, ['read', 'read_file', 'ls', 'list_directory']);
  }

  static isFileMutation(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return ToolStatusPresentationPolicy.matches(raw, [
      'Write', 'Create', 'Edit', 'MultiEdit', 'StrReplace', 'ApplyPatch', 'Patch', 'Delete', 'GetFileDiff'
    ]) || ToolStatusPresentationPolicy.matches(normalized, [
      'write', 'write_file', 'create_file', 'edit', 'edit_file', 'file_edit', 'multi_edit', 'multiedit',
      'strreplace', 'str_replace', 'str_replace_editor', 'replace', 'replace_file', 'update_file',
      'delete', 'delete_file', 'remove_file', 'get_file_diff', 'getfilediff', 'apply_patch', 'applypatch', 'patch'
    ]);
  }

  static isCommand(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return ToolStatusPresentationPolicy.matches(raw, ['Bash', 'Shell', 'Git', 'ExecCommand', 'WriteStdin', 'ExecControl']) ||
      ToolStatusPresentationPolicy.matches(normalized, [
        'bash', 'shell', 'git', 'exec_command', 'run_command', 'terminal', 'terminal_command',
        'powershell', 'sh', 'write_stdin', 'writestdin', 'exec_control', 'execcontrol'
      ]) || normalized.indexOf('exec_command') >= 0;
  }

  static isGit(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'Git' || normalized === 'git' || normalized.indexOf('git_') === 0;
  }

  static isWeb(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'WebFetch' || normalized === 'webfetch' || normalized === 'web_fetch';
  }

  static isDiff(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'GetFileDiff' || normalized === 'get_file_diff' || normalized === 'getfilediff';
  }

  static isDelete(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'Delete' ||
      ToolStatusPresentationPolicy.matches(normalized, ['delete', 'delete_file', 'remove_file']);
  }

  static isFileCreate(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'Write' || raw === 'Create' ||
      ToolStatusPresentationPolicy.matches(normalized, ['write', 'write_file', 'create', 'create_file']);
  }

  static isPatch(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return raw === 'ApplyPatch' || raw === 'Patch' ||
      ToolStatusPresentationPolicy.matches(normalized, ['apply_patch', 'applypatch', 'patch']);
  }

  static isSearch(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = ToolStatusPresentationPolicy.normalizedName(tool);
    return ToolStatusPresentationPolicy.matches(raw, ['Grep', 'Glob', 'SemanticSearch']) ||
      ToolStatusPresentationPolicy.matches(normalized, ['grep', 'glob', 'semanticsearch', 'semantic_search']) ||
      normalized.indexOf('search') >= 0;
  }

  static hasError(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    return status === 'failed' || status === 'error' || (tool.error_preview || '').length > 0 ||
      (tool.stderr || '').length > 0;
  }

  static isPendingConfirmation(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    return (status === 'pending_confirmation' || status === 'needs_confirmation') && (tool.id || '').length > 0;
  }

  static isRunning(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    return (status === 'running' || status === 'active') && (tool.id || '').length > 0;
  }

  static isCompleted(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    return status === 'completed' || status === 'done' || status === 'sent';
  }

  static isCancelled(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    return status === 'cancelled' || status === 'canceled' || status === 'rejected';
  }

  static isQuestion(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    const name = ToolStatusPresentationPolicy.normalizedName(tool);
    return (name === 'askuserquestion' || name === 'ask_user_question') &&
      !ToolStatusPresentationPolicy.matches(status, [
        'completed', 'done', 'failed', 'error', 'cancelled', 'canceled', 'rejected'
      ]) && (tool.id || '').length > 0;
  }

  static canExpand(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.hasError(tool) ||
      ToolStatusPresentationPolicy.isPendingConfirmation(tool) ||
      ToolStatusPresentationPolicy.isQuestion(tool) ||
      ToolStatusPresentationPolicy.isRunning(tool) ||
      ToolStatusPresentationPolicy.isCompleted(tool) ||
      ToolStatusPresentationPolicy.isCancelled(tool);
  }

  static hasEditableInput(tool: ConversationUiToolStatus): boolean {
    return !!tool.tool_input;
  }

  static defaultInputText(tool: ConversationUiToolStatus): string {
    if (!tool.tool_input) {
      return '';
    }
    try {
      return JSON.stringify(tool.tool_input, null, 2);
    } catch (_err) {
      return '';
    }
  }

  static inputPreview(tool: ConversationUiToolStatus): string {
    if (tool.input_preview && tool.input_preview.length > 0) {
      return tool.input_preview;
    }
    if (tool.tool_input) {
      try {
        return JSON.stringify(tool.tool_input);
      } catch (_err) {
        return '';
      }
    }
    return '';
  }

  static taskTitle(tool: ConversationUiToolStatus): string {
    const payload = ToolStatusPresentationPolicy.taskPayload(tool);
    const title = payload.description || payload.task || payload.title || payload.prompt || payload.message ||
      payload.task_name || payload.taskName || payload.name || payload.content || '';
    if (title.trim().length > 0) return title.trim();
    const preview = ToolStatusPresentationPolicy.inputPreview(tool).trim();
    if (preview.length > 0 && !preview.startsWith('{') && !preview.startsWith('[')) return preview;
    return '';
  }

  static resultPreview(tool: ConversationUiToolStatus): string {
    const parts: string[] = [];
    if (tool.result_preview && tool.result_preview.length > 0) parts.push(tool.result_preview);
    if (tool.error_preview && tool.error_preview.length > 0) parts.push(tool.error_preview);
    if (tool.stdout && tool.stdout.length > 0) parts.push(tool.stdout);
    if (tool.stderr && tool.stderr.length > 0) parts.push(tool.stderr);
    if (tool.tool_output) {
      try {
        parts.push(JSON.stringify(tool.tool_output));
      } catch (_err) {
      }
    }
    const text = parts.join('\n').trim();
    return text.length <= 480 ? text : `${text.slice(0, 480)}...`;
  }

  static questionInputJson(tool: ConversationUiToolStatus): string {
    if (tool.tool_input) {
      try {
        return JSON.stringify(tool.tool_input);
      } catch (_err) {
      }
    }
    return ToolStatusPresentationPolicy.inputPreview(tool);
  }

  static questionPromptFromJson(preview: string): string {
    if (preview.trim().length === 0) {
      return '';
    }
    try {
      const payload = JSON.parse(preview) as QuestionPreviewPayload;
      if (payload.question && payload.question.trim().length > 0) return payload.question.trim();
      if (payload.prompt && payload.prompt.trim().length > 0) return payload.prompt.trim();
      if (payload.questions && payload.questions.length > 0) {
        return (payload.questions[0].question || payload.questions[0].header || '').trim();
      }
    } catch (_err) {
    }
    return '';
  }

  static key(tool: ConversationUiToolStatus, index: number): string {
    const signature = ToolStatusPresentationPolicy.signature(tool);
    return tool.id && tool.id.length > 0 ? `${index}-${tool.id}-${signature}` :
      `${index}-${tool.name || 'tool'}-${signature}`;
  }

  private static signature(tool: ConversationUiToolStatus): string {
    const parts: string[] = [
      tool.status || 'pending', `${tool.duration_ms || 0}`, `${tool.exit_code || 0}`,
      `${(tool.input_preview || '').length}`, `${(tool.result_preview || '').length}`,
      `${(tool.error_preview || '').length}`, `${(tool.stdout || '').length}`, `${(tool.stderr || '').length}`,
      ToolStatusPresentationPolicy.objectSignature(tool.tool_input),
      ToolStatusPresentationPolicy.objectSignature(tool.tool_output)
    ];
    return ToolStatusPresentationPolicy.stableTextHash(parts.join('|'));
  }

  private static taskPayload(tool: ConversationUiToolStatus): TaskPreviewPayload {
    const preview = ToolStatusPresentationPolicy.inputPreview(tool);
    if (preview.trim().length === 0) return {};
    try {
      return JSON.parse(preview) as TaskPreviewPayload;
    } catch (_err) {
      return {};
    }
  }

  private static objectSignature(value?: Object): string {
    if (!value) return '';
    try {
      return JSON.stringify(value).length.toString();
    } catch (_err) {
      return 'object';
    }
  }

  private static stableTextHash(text: string): string {
    let hash = 0;
    for (let index = 0; index < text.length; index++) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private static matches(value: string, candidates: string[]): boolean {
    return candidates.indexOf(value) >= 0;
  }
}
