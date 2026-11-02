 
/**
 * Chat and conversation model types.
 */
export type MessageRole = 'user' | 'assistant' | 'system';


export type MessageStatus = 'pending' | 'sending' | 'sent' | 'error';


export type ConversationStatus = 'pending' | 'completed' | 'failed' | 'cancelled';


export type ApiFormat = 'openai' | 'responses' | 'anthropic' | 'gemini';


export interface ToolExecution {
  id: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input?: any;
  output?: any;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}


export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: any;
  status: 'pending' | 'running' | 'completed' | 'error';
  timestamp: number;
}


export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  modelName: string;
  format: ApiFormat;
  description?: string;
  isBuiltIn?: boolean;
  contextWindow?: number; 
  maxTokens?: number; 
  maxImagesPerRequest?: number;
  category?: 'general_chat' | 'multimodal' | 'speech_recognition';
  capabilities?: Array<'text_chat' | 'function_calling' | 'image_understanding' | 'speech_recognition'>;
}


export interface ProviderBaseUrlOption {
  url: string;
  format: ApiFormat;
  note: string;
}

/**
 * Home market of a preset provider. `any` marks region-neutral first-party
 * entries; the preset picker ranks the group matching the UI language first and
 * keeps every other provider listed below it.
 */
export type ProviderRegion = 'any' | 'cn' | 'global';

export interface ProviderTemplate {
  id: string;
  displayOrder?: number;
  region?: ProviderRegion;
  name: string;
  baseUrl: string;
  format: ApiFormat;
  models: string[];
  requiresApiKey: boolean;
  description: string;
  helpUrl?: string;
  baseUrlOptions?: ProviderBaseUrlOption[];
}


export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date | number;
  conversationId?: string;
  toolExecutions?: ToolExecution[];
  status?: ConversationStatus | MessageStatus;
  isStreaming?: boolean;
  isContextMessage?: boolean;
  isProcessing?: boolean;
  metadata?: {
    model?: string;
    tokens?: number;
    executionTime?: number;
    toolCalls?: ToolCall[];
    error?: string;
    requestId?: string;
    sessionId?: string;
    isWorkspaceConfig?: boolean;
    toolExecutionBatches?: any[];
    [key: string]: any;
  };
}


export interface ChatSettings {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  enableTools?: boolean;
}


export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  workspaceId?: string;
  model?: string;
  settings?: ChatSettings;
}


export interface Conversation {
  id: string;
  title?: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  status: ConversationStatus;
  metadata?: Record<string, any>;
}


export interface ChatState {
  currentSessionId: string | null;
  currentSession: ChatSession | null;
  currentConversation: Conversation | null;
  sessions: ChatSession[];
  messages: ChatMessage[];
  input: string;
  isProcessing: boolean;
  isStreaming: boolean;
  isTyping: boolean;
  currentRequestId: string | null;
  suggestions: string[];
  loading: boolean;
  error: string | null;
}


export interface ChatActions {
  setInput: (input: string) => void;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  retryMessage: (conversationId: string) => Promise<void>;
  cancelProcessing: () => void;
}


export interface ChatInputState {
  value: string;
  isComposing: boolean;
  suggestions: string[];
  showSuggestions: boolean;
}


export interface MessageHistory {
  currentIndex: number;
  isViewingHistory: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}


export interface ToolExecutionEvent {
  conversationId: string;
  toolExecution: ToolExecution;
  type: 'start' | 'update' | 'complete' | 'error';
}


export type ChatEventType = 
  | 'message_sent'
  | 'message_received' 
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_complete'
  | 'conversation_complete'
  | 'error';


export interface ChatEvent {
  type: ChatEventType;
  payload: any;
  timestamp: Date;
}
