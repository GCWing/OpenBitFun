import { InteractionMailboxAction } from '../../model/InteractionMailbox';
import { ConversationUiQuestionAnswer } from '../state/ConversationUiModels';
import { FilePreviewRequest } from '../../model/FilePreviewTarget';

export enum ConversationIntentType {
  Mailbox = 'mailbox',
  OpenSidebar = 'open_sidebar',
  Back = 'back',
  NewSession = 'new_session',
  TogglePin = 'toggle_pin',
  Archive = 'archive',
  Delete = 'delete',
  ShowUploadedFiles = 'show_uploaded_files',
  Stop = 'stop',
  LoadOlder = 'load_older',
  ApproveTool = 'approve_tool',
  RejectTool = 'reject_tool',
  CancelTool = 'cancel_tool',
  AnswerQuestion = 'answer_question',
  RenameSession = 'rename_session',
  CopyMessage = 'copy_message',
  RetryMessage = 'retry_message',
  SelectModel = 'select_model',
  PickImages = 'pick_images',
  RemoveImage = 'remove_image',
  OpenFilePreview = 'open_file_preview',
  DownloadFile = 'download_file',
  BuildPlan = 'build_plan',
  CommandPalette = 'command_palette',
  Send = 'send',
  VoiceInput = 'voice_input',
  ChatInputChanged = 'chat_input_changed'
}

/**
 * What one tap in the composer command row asks for.
 *
 * The row is a single funnel by construction: the two verbs keep their wire ids,
 * and everything else is a local decision about the draft or a sheet. None of
 * these carry a session — the active conversation is resolved once, where the
 * command is sent.
 */
export enum CommandPaletteAction {
  Compact = 'compact',
  InitAgentsMd = 'init_agents_md',
  ToggleGoal = 'toggle_goal',
  OpenUsage = 'open_usage',
  RetryUsage = 'retry_usage',
  OpenSkills = 'open_skills',
  RefreshCatalog = 'refresh_catalog',
  SelectSkill = 'select_skill',
  ClearSkill = 'clear_skill',
  RetryCommand = 'retry_command'
}

export class CommandPaletteRequest {
  readonly action: CommandPaletteAction;
  /** The picked skill, for `SelectSkill`; empty otherwise. */
  readonly skillId: string;
  /** The verb a `RetryCommand` repeats, empty otherwise. */
  readonly wireAction: string;

  constructor(action: CommandPaletteAction, skillId: string = '', wireAction: string = '') {
    this.action = action;
    this.skillId = skillId;
    this.wireAction = wireAction;
  }
}

export class PlanBuildRequest {
  readonly path: string;
  readonly name: string;

  constructor(path: string, name: string) {
    this.path = path;
    this.name = name;
  }
}

/**
 * What a `CopyMessage` intent asks the clipboard owner to write.
 *
 * `Plain` is the default so every caller that existed before the assistant copy
 * menu — the code-block copy button and the user message's "full text" copy —
 * keeps its single-flavor plain write. Only `Rich` changes the payload shape.
 */
export enum MessageCopyScope {
  /** Markdown source as the plain flavor plus its rendered html. */
  Rich = 'rich',
  /** The Markdown source alone, one plain flavor. */
  Markdown = 'markdown',
  /** A plain-text rendering of the message, one plain flavor. */
  Plain = 'plain'
}

export class ConversationIntent {
  readonly type: ConversationIntentType;
  readonly value: string;
  readonly toolId: string;
  readonly updatedInput?: Object;
  readonly answers?: ConversationUiQuestionAnswer;
  readonly filePreviewRequest?: FilePreviewRequest;
  readonly planBuildRequest?: PlanBuildRequest;
  readonly copyScope: MessageCopyScope;
  readonly commandPaletteRequest?: CommandPaletteRequest;
  mailboxAction?: InteractionMailboxAction;

  constructor(
    type: ConversationIntentType,
    value: string = '',
    toolId: string = '',
    updatedInput?: Object,
    answers?: ConversationUiQuestionAnswer,
    filePreviewRequest?: FilePreviewRequest,
    planBuildRequest?: PlanBuildRequest,
    copyScope: MessageCopyScope = MessageCopyScope.Plain,
    commandPaletteRequest?: CommandPaletteRequest
  ) {
    this.type = type;
    this.value = value;
    this.toolId = toolId;
    this.updatedInput = updatedInput;
    this.answers = answers;
    this.filePreviewRequest = filePreviewRequest;
    this.planBuildRequest = planBuildRequest;
    this.copyScope = copyScope;
    this.commandPaletteRequest = commandPaletteRequest;
  }
}

export class ConversationIntents {
  static mailbox(action: InteractionMailboxAction): ConversationIntent {
    const intent = new ConversationIntent(ConversationIntentType.Mailbox);
    intent.mailboxAction = action;
    return intent;
  }
  static simple(type: ConversationIntentType): ConversationIntent {
    return new ConversationIntent(type);
  }

  static value(type: ConversationIntentType, value: string): ConversationIntent {
    return new ConversationIntent(type, value);
  }

  /**
   * The scoped copy intent. The value is already the text for that scope: the
   * Markdown source for `rich`/`markdown`, the plain rendering for `plain`.
   */
  static copyMessage(text: string, scope: MessageCopyScope): ConversationIntent {
    return new ConversationIntent(
      ConversationIntentType.CopyMessage,
      text,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      scope
    );
  }

  static approveTool(toolId: string, updatedInput?: Object): ConversationIntent {
    return new ConversationIntent(ConversationIntentType.ApproveTool, '', toolId, updatedInput);
  }

  static tool(type: ConversationIntentType, toolId: string): ConversationIntent {
    return new ConversationIntent(type, '', toolId);
  }

  static answerQuestion(toolId: string, answers: ConversationUiQuestionAnswer): ConversationIntent {
    return new ConversationIntent(ConversationIntentType.AnswerQuestion, '', toolId, undefined, answers);
  }

  static openFilePreview(reference: string, label: string): ConversationIntent {
    return new ConversationIntent(
      ConversationIntentType.OpenFilePreview,
      '',
      '',
      undefined,
      undefined,
      new FilePreviewRequest(reference, label)
    );
  }

  static buildPlan(path: string, name: string): ConversationIntent {
    return new ConversationIntent(
      ConversationIntentType.BuildPlan,
      '',
      '',
      undefined,
      undefined,
      undefined,
      new PlanBuildRequest(path, name)
    );
  }

  /** One tap in the composer command row, as a typed request rather than a parameter list. */
  static commandPalette(request: CommandPaletteRequest): ConversationIntent {
    return new ConversationIntent(
      ConversationIntentType.CommandPalette,
      '',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      MessageCopyScope.Plain,
      request
    );
  }
}
