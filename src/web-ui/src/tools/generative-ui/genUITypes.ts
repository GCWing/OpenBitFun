export type GenUIAppState = Record<string, unknown>;
export interface GenUIAppEnvelope {
  schemaVersion: number;
  id: string;
  title: string;
}
export interface GenUIDesignSpecIdentity {
  id: string;
  revision: number;
}
export interface GenUIHtmlDocumentSource {
  kind: 'html-document';
  html: string;
  css?: string;
  script?: string;
}
export interface GenUIHtmlRuntimeIdentity {
  runtimeRevision: number;
  sanitizerRevision: number;
  inspectorRevision: number;
  bridgeRevision: number;
}
export interface GenUIOpenUIDocumentSource {
  kind: 'openui-lang';
  content: string;
}
export interface GenUIAppDefinition extends GenUIAppEnvelope {
  schemaVersion: 2;
  description?: string;
  template: string;
  /** Immutable adapter identity selected when the app was generated. */
  libraryId: string;
  /** Adapter revision is pinned with the app and never follows global settings. */
  libraryRevision: number;
  designSpec: GenUIDesignSpecIdentity;
  /** Owner-stamped HTML host capability identity; absent only before owner admission. */
  htmlRuntime?: GenUIHtmlRuntimeIdentity;
  source: GenUIHtmlDocumentSource | GenUIOpenUIDocumentSource;
  state: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    default: unknown;
  }>;
}
/** Recognize the envelope, including unsupported versions, to preserve and diagnose old data. */
export function isGenUIAppEnvelope(value: unknown): value is GenUIAppEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false;
  const app = value as Record<string, unknown>;
  return typeof app.schemaVersion === 'number' && typeof app.id === 'string' && typeof app.title === 'string';
}

export interface GenUIRenderNode {
  key: string;
  node: { id: string; component: string; props: Record<string, unknown>; slots: Record<string, unknown>; events: Record<string, unknown> };
  props: Record<string, unknown>;
  slots: Record<string, GenUIRenderNode[]>;
  item?: unknown;
}
