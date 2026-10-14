// Presentation-owned structures. Protocol DTOs are mapped at the boundary and
// never imported by leaf rendering components.
import {
  ChatMessage,
  ChatMessageItemResponse,
  ImageAttachment,
  RemoteModelCatalog,
  RemoteModelConfig,
  RemoteReasoningCatalogProjection,
  RemoteQuestionAnswerPayload,
  SelectedImageAttachment,
  SessionSummary,
  RemoteToolStatusResponse
} from '../../model/RemoteModels';

export interface ConversationUiPlanTool {
  file_path: string;
  name: string;
  overview?: string;
}

export interface ConversationUiSession {
  sessionId: string;
  title: string;
  workspacePath: string;
  agentType: string;
  initialTurnId?: string;
}

export interface ConversationUiModel {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  model_name: string;
  context_window?: number;
  enabled: boolean;
  capabilities: string[];
  reasoning?: RemoteReasoningCatalogProjection;
}

export interface ConversationUiDefaultModels {
  primary?: string;
  fast?: string;
  search?: string;
  image_understanding?: string;
}

export interface ConversationUiModelCatalog {
  version: number;
  models: ConversationUiModel[];
  default_models: ConversationUiDefaultModels;
  session_model_id?: string;
}
export interface ConversationUiToolStatus {
  permission_request_id?: string;
  id?: string;
  name?: string;
  status?: string;
  duration_ms?: number;
  start_ms?: number;
  input_preview?: string;
  tool_input?: Object;
  stdout?: string;
  stderr?: string;
  tool_output?: Object;
  result_preview?: string;
  error_preview?: string;
  exit_code?: number;
  plan?: ConversationUiPlanTool;
}

export interface ConversationUiMessageItem {
  type?: string;
  steering_id?: string;
  round_index?: number;
  content?: string;
  tool?: ConversationUiToolStatus;
  is_subagent?: boolean;
  subItems?: ConversationUiMessageItem[];
  images?: ConversationUiImage[];
}

export interface ConversationUiImage {
  name: string;
  data_url: string;
}

export interface ConversationUiSelectedImage extends ConversationUiImage {
  id: string;
  uri: string;
  mime_type: string;
  size: number;
  original_size: number;
  compressed: boolean;
}

export interface ConversationUiMessage {
  id: string;
  role: string;
  text: string;
  status: string;
  renderVersion?: number;
  turnId?: string;
  detail?: string;
  error?: string;
  timestamp?: string;
  thinking?: string;
  tools?: ConversationUiToolStatus[];
  items?: ConversationUiMessageItem[];
  images?: ConversationUiImage[];
}

/** Stable observable projection consumed by retained/reused message rows. */
@ObservedV2
export class ObservableConversationUiMessage implements ConversationUiMessage {
  @Trace id: string = '';
  @Trace role: string = 'assistant';
  @Trace text: string = '';
  @Trace status: string = '';
  @Trace renderVersion: number | undefined = undefined;
  @Trace turnId: string | undefined = undefined;
  @Trace detail: string | undefined = undefined;
  @Trace error: string | undefined = undefined;
  @Trace timestamp: string | undefined = undefined;
  @Trace thinking: string | undefined = undefined;
  @Trace tools: ConversationUiToolStatus[] | undefined = undefined;
  @Trace items: ConversationUiMessageItem[] | undefined = undefined;
  @Trace images: ConversationUiImage[] | undefined = undefined;

  updateFrom(source: ConversationUiMessage): void {
    this.id = source.id;
    this.role = source.role;
    this.text = source.text;
    this.status = source.status;
    this.renderVersion = source.renderVersion;
    this.turnId = source.turnId;
    this.detail = source.detail;
    this.error = source.error;
    this.timestamp = source.timestamp;
    this.thinking = source.thinking;
    this.tools = source.tools;
    this.items = source.items;
    this.images = source.images;
  }
}

export interface ConversationUiQuestionAnswer {
  answer?: string;
  '0'?: string | string[];
  '1'?: string | string[];
  '2'?: string | string[];
  '3'?: string | string[];
}

export function toConversationUiSession(source: SessionSummary): ConversationUiSession {
  return {
    sessionId: source.sessionId,
    title: source.title,
    workspacePath: source.workspacePath,
    agentType: source.agentType,
    initialTurnId: source.initialTurnId
  };
}

export function toConversationUiModel(source: RemoteModelConfig): ConversationUiModel {
  return {
    id: source.id,
    name: source.name,
    provider: source.provider,
    base_url: source.base_url,
    model_name: source.model_name,
    context_window: source.context_window,
    enabled: source.enabled,
    capabilities: source.capabilities.slice(),
    reasoning: source.reasoning
  };
}

export function toConversationUiModelCatalog(source: RemoteModelCatalog): ConversationUiModelCatalog {
  return {
    version: source.version,
    models: source.models.map((model: RemoteModelConfig) => toConversationUiModel(model)),
    default_models: {
      primary: projectedDefaultModelId(source.default_models.primary),
      fast: projectedDefaultModelId(source.default_models.fast),
      search: projectedDefaultModelId(source.default_models.search),
      image_understanding: projectedDefaultModelId(source.default_models.image_understanding)
    },
    session_model_id: source.session_model_id
  };
}

/**
 * The wire says `null` for a slot with no model; this projection says the same
 * by leaving the id absent. Both mean "nothing configured" to every reader.
 */
function projectedDefaultModelId(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value.length === 0 ? undefined : value;
}

export function toConversationUiSelectedImage(source: SelectedImageAttachment): ConversationUiSelectedImage {
  return {
    id: source.id,
    name: source.name,
    data_url: source.data_url,
    uri: source.uri,
    mime_type: source.mime_type,
    size: source.size,
    original_size: source.original_size,
    compressed: source.compressed
  };
}

export function toConversationUiToolStatus(source: RemoteToolStatusResponse): ConversationUiToolStatus {
  return {
    permission_request_id: source.permission_request_id,
    id: source.id,
    name: source.name,
    status: source.status,
    duration_ms: source.duration_ms,
    start_ms: source.start_ms,
    input_preview: source.input_preview,
    tool_input: source.tool_input,
    stdout: source.stdout,
    stderr: source.stderr,
    tool_output: source.tool_output,
    result_preview: source.result_preview,
    error_preview: source.error_preview,
    exit_code: source.exit_code,
    plan: source.plan ? {
      file_path: source.plan.file_path,
      name: source.plan.name,
      overview: source.plan.overview
    } : undefined
  };
}

export function toConversationUiMessageItem(source: ChatMessageItemResponse): ConversationUiMessageItem {
  return {
    type: source.type,
    steering_id: source.steering_id,
    round_index: source.round_index,
    content: source.content,
    tool: source.tool ? toConversationUiToolStatus(source.tool) : undefined,
    is_subagent: source.is_subagent,
    subItems: source.subItems ? source.subItems.map((item: ChatMessageItemResponse) => toConversationUiMessageItem(item)) : undefined,
    images: source.images ? source.images.map((image: ImageAttachment) => toConversationUiImage(image)) : undefined
  };
}

export function toConversationUiImage(source: ImageAttachment): ConversationUiImage {
  return { name: source.name, data_url: source.data_url };
}

export function toConversationUiMessage(source: ChatMessage): ConversationUiMessage {
  return {
    id: source.id,
    role: source.role,
    text: source.text,
    status: source.status,
    renderVersion: source.renderVersion,
    turnId: source.turnId,
    detail: source.detail,
    error: source.error,
    timestamp: source.timestamp,
    thinking: source.thinking,
    tools: source.tools ? source.tools.map((tool: RemoteToolStatusResponse) => toConversationUiToolStatus(tool)) : undefined,
    items: source.items ? source.items.map((item: ChatMessageItemResponse) => toConversationUiMessageItem(item)) : undefined,
    images: source.images ? source.images.map((image: ImageAttachment) => toConversationUiImage(image)) : undefined
  };
}

export function toRemoteQuestionAnswer(source: ConversationUiQuestionAnswer): RemoteQuestionAnswerPayload {
  const result: Record<string, Object> = {};
  const values = source as Record<string, Object>;
  if (source.answer !== undefined) {
    result['answer'] = source.answer as Object;
  }
  if (values['0'] !== undefined) {
    result['0'] = values['0'];
  }
  if (values['1'] !== undefined) {
    result['1'] = values['1'];
  }
  if (values['2'] !== undefined) {
    result['2'] = values['2'];
  }
  if (values['3'] !== undefined) {
    result['3'] = values['3'];
  }
  return result as RemoteQuestionAnswerPayload;
}
