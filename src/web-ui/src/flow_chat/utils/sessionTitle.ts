import legacyDefaultTitles from '../../../../shared/session-naming/legacy-default-titles.json';
import type { SessionMetadata } from '@/shared/types/session-history';
import type { Session } from '../types/flow-chat';

export interface SessionTitleDescriptor {
  source: 'text' | 'i18n';
  text: string;
  key?: string;
  params?: Record<string, unknown>;
  workspaceSessionNumber?: number;
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type TitleState = Pick<Session, 'title' | 'titleSource' | 'titleI18nKey' | 'titleI18nParams'>;
const DEFAULT_SESSION_TITLE_KEY = 'flow-chat:session.new';

function normalizeTitleText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeWorkspaceSessionNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function isDefaultSessionTitle(session: TitleState): boolean {
  return session.titleSource === 'i18n' && session.titleI18nKey === DEFAULT_SESSION_TITLE_KEY;
}

export function createTextSessionTitleDescriptor(text: string): SessionTitleDescriptor {
  return { source: 'text', text: normalizeTitleText(text) || '' };
}

export function createI18nSessionTitleDescriptor(
  key: string,
  translate: TranslateFn,
  params?: Record<string, unknown>,
): SessionTitleDescriptor {
  return { source: 'i18n', text: translate(key, params), key, params };
}

export function createDefaultSessionTitleDescriptor(translate: TranslateFn): SessionTitleDescriptor {
  const descriptor = createI18nSessionTitleDescriptor(DEFAULT_SESSION_TITLE_KEY, translate);
  return { ...descriptor, params: { defaultTitleText: descriptor.text } };
}

export function deriveSessionTitleState(descriptor?: SessionTitleDescriptor): TitleState & Pick<Session, 'workspaceSessionNumber'> {
  if (descriptor?.source === 'i18n' && descriptor.key === DEFAULT_SESSION_TITLE_KEY) {
    return {
      title: normalizeTitleText(descriptor.text),
      titleSource: 'i18n',
      titleI18nKey: descriptor.key,
      titleI18nParams: descriptor.params,
      workspaceSessionNumber: normalizeWorkspaceSessionNumber(descriptor.workspaceSessionNumber),
    };
  }
  return {
    ...freezeSessionTitleState(descriptor?.text ?? ''),
    workspaceSessionNumber: normalizeWorkspaceSessionNumber(descriptor?.workspaceSessionNumber),
  };
}

export function freezeSessionTitleState(title: string): TitleState {
  return {
    title: normalizeTitleText(title),
    titleSource: 'text',
    titleI18nKey: undefined,
    titleI18nParams: undefined,
  };
}

export function deriveSessionTitleStateFromMetadata(
  metadata?: Pick<SessionMetadata, 'sessionName' | 'customMetadata' | 'turnCount'> | null,
): TitleState & Pick<Session, 'workspaceSessionNumber'> {
  let custom = metadata?.customMetadata;
  const key = custom?.titleKey as keyof typeof legacyDefaultTitles;
  const count = normalizeWorkspaceSessionNumber(custom?.titleParams?.count);
  const provenLegacy = (metadata?.turnCount ?? 0) === 0 && custom?.titleSource === 'i18n'
    && custom?.titleUserEdited !== true && Object.prototype.hasOwnProperty.call(legacyDefaultTitles, key)
    && legacyDefaultTitles[key].some(template => (!template.includes('{{count}}') || count !== undefined)
      && template.replace('{{count}}', String(count)) === metadata?.sessionName);
  if (provenLegacy) {
    metadata = { ...metadata!, sessionName: 'New Session' };
    custom = { ...custom, titleKey: DEFAULT_SESSION_TITLE_KEY, titleParams: { defaultTitleText: 'New Session' }, workspaceSessionNumber: undefined };
  }
  const workspaceSessionNumber = normalizeWorkspaceSessionNumber(custom?.workspaceSessionNumber);
  // Only proven default descriptors are localized; all custom text stays verbatim.
  const useDynamicTitle = custom?.titleSource === 'i18n'
    && custom.titleUserEdited !== true
    && custom.titleKey === DEFAULT_SESSION_TITLE_KEY
    && custom.titleParams?.defaultTitleText === metadata?.sessionName
    && (metadata?.turnCount ?? 0) === 0;
  return {
    ...(useDynamicTitle ? {
      title: normalizeTitleText(metadata?.sessionName),
      titleSource: 'i18n' as const,
      titleI18nKey: DEFAULT_SESSION_TITLE_KEY,
      titleI18nParams: custom?.titleParams ?? undefined,
    } : freezeSessionTitleState(metadata?.sessionName ?? '')),
    workspaceSessionNumber,
  };
}

export function resolveSessionTitle(
  session: TitleState | null | undefined,
  translate: TranslateFn,
  fallbackKey: string = DEFAULT_SESSION_TITLE_KEY,
): string {
  if (session && isDefaultSessionTitle(session)) return translate(DEFAULT_SESSION_TITLE_KEY);
  return normalizeTitleText(session?.title) || translate(fallbackKey);
}

export function resolvePersistedSessionTitle(
  metadata: Pick<SessionMetadata, 'sessionName' | 'customMetadata' | 'turnCount'> | null | undefined,
  translate: TranslateFn,
  fallbackKey: string = DEFAULT_SESSION_TITLE_KEY,
): string {
  return resolveSessionTitle(deriveSessionTitleStateFromMetadata(metadata), translate, fallbackKey);
}
