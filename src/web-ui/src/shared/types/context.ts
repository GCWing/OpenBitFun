 
/**
 * Context item types shared across features.
 *
 * A `ContextItem` is a discriminated union (via `type`) used to represent things
 * like files, snippets, diagrams, and URLs in a transportable form (e.g. drag-and-drop,
 * context menus, clipboard).
 */
export interface BaseContext {
  id: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * A discriminated union representing supported context payloads.
 */
export type ContextItem =
  | FileContext
  | DirectoryContext
  | SessionReferenceContext
  | ConversationExcerptContext
  | CodeSnippetContext
  | PullRequestContext
  | MermaidNodeContext
  | MermaidDiagramContext
  | ImageContext
  | TerminalCommandContext
  | GitRefContext
  | URLContext
  | WebElementContext;

export interface FileContext extends BaseContext {
  type: 'file';
  filePath: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  relativePath?: string; 
}

export interface DirectoryContext extends BaseContext {
  type: 'directory';
  directoryPath: string;
  directoryName: string;
  recursive: boolean;
  itemCount?: number;
}

/** A selected idle session whose transcript is materialized on turn dispatch. */
export interface SessionReferenceContext extends BaseContext {
  type: 'session-reference';
  sessionId: string;
  sessionName: string;
  /**
   * Owning workspace ID of the referenced session; the identity the host uses
   * to locate its storage. Optional only for references persisted before IDs
   * existed, which are upgraded from the legacy fields below.
   */
  workspaceId?: string;
  /** Legacy pre-ID storage selector; display/IO projection for new references. */
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  workspaceLabel: string;
}

export interface CodeSnippetContext extends BaseContext {
  type: 'code-snippet';
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  language?: string;
  
  beforeContext?: string; 
  afterContext?: string;  
}

/** Frozen transcript material. DOM ranges and viewport coordinates never cross this boundary. */
export interface ConversationExcerptContext extends BaseContext {
  type: 'conversation-excerpt';
  /** Display label preserved with the annotation; id remains its identity. */
  annotationNumber?: number;
  source: {
    surfaceId: string;
    sessionId: string;
    sessionName: string;
    workspaceId?: string;
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  };
  fragments: Array<{
    turnId: string;
    flowItemId?: string;
    text: string;
    start: number;
    end: number;
    prefix: string;
    suffix: string;
  }>;
  comment?: string;
}

export interface PullRequestContext extends BaseContext {
  type: 'pull-request';
  label: string;
  section: 'overview' | 'ci' | 'file-diff' | 'commits' | 'reviews' | 'summary';
  content: string;
  sourceUrl?: string;
  remoteId?: string;
  repository?: string;
  pullRequestNumber?: number;
  pullRequestTitle?: string;
}

export interface MermaidNodeContext extends BaseContext {
  type: 'mermaid-node';
  nodeId: string;
  nodeText: string;
  nodeType: 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gantt';
  sourceCode?: string; 
  diagramTitle?: string; 
}

export interface MermaidDiagramContext extends BaseContext {
  type: 'mermaid-diagram';
  diagramCode: string; 
  diagramTitle?: string; 
  diagramType?: 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gantt' | 'other';
}

export interface ImageContext extends BaseContext {
  type: 'image';
  imagePath: string;
  imageName: string;
  width?: number;
  height?: number;
  fileSize: number;          
  mimeType: string;          
  dataUrl?: string;          
  thumbnailUrl?: string;     
  source: 'file' | 'clipboard' | 'url';  
  isLocal: boolean;          
}

export interface TerminalCommandContext extends BaseContext {
  type: 'terminal-command';
  command: string;
  workingDirectory?: string;
  output?: string;
}

export interface GitRefContext extends BaseContext {
  type: 'git-ref';
  refType: 'commit' | 'branch' | 'tag';
  refValue: string;
  commitHash?: string;
  commitMessage?: string;
}

export interface URLContext extends BaseContext {
  type: 'url';
  url: string;
  title?: string;
  description?: string;
}

export interface WebElementContext extends BaseContext {
  type: 'web-element';
  /** HTML tag name, e.g. "div", "button" */
  tagName: string;
  /** Absolute CSS selector path to the element */
  path: string;
  /** All HTML attributes of the element */
  attributes: Record<string, string>;
  /** Inner text content (truncated) */
  textContent: string;
  /** Outer HTML (truncated) */
  outerHTML: string;
  /** URL of the page where the element was captured */
  sourceUrl?: string;
}

/**
 * Convenience alias for the discriminant used by `ContextItem`.
 */
export type ContextType = ContextItem['type'];

 
export type ContextByType<T extends ContextType> = Extract<
  ContextItem,
  { type: T }
>;



export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
  metadata?: Record<string, unknown>; 
}



export interface RenderOptions {
  compact?: boolean;      
  interactive?: boolean;  
  showPreview?: boolean;  
}



export function isFileContext(context: ContextItem): context is FileContext {
  return context.type === 'file';
}

export function isDirectoryContext(context: ContextItem): context is DirectoryContext {
  return context.type === 'directory';
}

export function isCodeSnippetContext(context: ContextItem): context is CodeSnippetContext {
  return context.type === 'code-snippet';
}

export function isPullRequestContext(context: ContextItem): context is PullRequestContext {
  return context.type === 'pull-request';
}

export function isMermaidNodeContext(context: ContextItem): context is MermaidNodeContext {
  return context.type === 'mermaid-node';
}

export function isMermaidDiagramContext(context: ContextItem): context is MermaidDiagramContext {
  return context.type === 'mermaid-diagram';
}

export function isImageContext(context: ContextItem): context is ImageContext {
  return context.type === 'image';
}

export function isTerminalCommandContext(context: ContextItem): context is TerminalCommandContext {
  return context.type === 'terminal-command';
}

export function isGitRefContext(context: ContextItem): context is GitRefContext {
  return context.type === 'git-ref';
}

export function isURLContext(context: ContextItem): context is URLContext {
  return context.type === 'url';
}

export function isWebElementContext(context: ContextItem): context is WebElementContext {
  return context.type === 'web-element';
}

 
export function isContextOfType<T extends ContextType>(
  context: ContextItem,
  type: T
): context is ContextByType<T> {
  return context.type === type;
}
