/**
 * Mini App store — app catalog + worker and customization state.
 */
import { create } from 'zustand';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import type { InstalledMarketOrigin } from '@/infrastructure/api/service-api/MiniAppMarketAPI';

/**
 * Window event dispatched after the shared ChatInput routes a submission to a
 * MiniApp that registered the floating bubble (`app.chat.claimComposer`).
 * `useMiniAppBridge` forwards the normalized payload into the owning iframe as
 * a `chat:userMessage` event.
 */
export const MINIAPP_COMPOSER_MESSAGE_EVENT = 'miniapp-composer-message';

export interface MiniAppComposerMessageDetail {
  token: string;
  /** Correlates one host submission with the owning iframe's completion acknowledgement. */
  requestId?: string;
  /** Identifies the host surface that produced the otherwise identical message contract. */
  source?: 'composer' | 'realtime_voice';
  text: string;
  displayText?: string;
  contexts?: unknown[];
  composerPresentation?: unknown;
  sessionId?: string;
  workspacePath?: string;
}

/**
 * Window event asking the bubble to open and prefill its composer without
 * sending (`app.chat.setComposerDraft`). Detail: `{ token, text }`.
 */
export const MINIAPP_COMPOSER_DRAFT_EVENT = 'miniapp-composer-draft';
/** Explicit reveal request; rebinding the same session is still a navigation action. */
export const MINIAPP_COMPOSER_FOCUS_EVENT = 'miniapp-composer-focus';

export interface MiniAppFocusEventDetail {
  appId: string;
  token: string;
  sessionId: string;
  surfaceId: string;
}

export interface MiniAppDraftEventDetail {
  token: string;
  text: string;
  /** Session the draft belongs to when the claim is already topic-bound. */
  sessionId?: string;
}

export interface MiniAppBubbleSuggestion {
  label: string;
  prompt: string;
}

export interface MiniAppBubbleCustomization {
  /** Optional title override for the bubble header. */
  title?: string;
  composer?: {
    placeholder?: string;
  };
  welcome?: {
    title?: string;
    description?: string;
    workspaceLabel?: string;
    suggestionsLabel?: string;
    suggestions?: MiniAppBubbleSuggestion[];
  };
}

const MINIAPP_BUBBLE_MAX_SUGGESTIONS = 6;

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Converts untrusted iframe claim options into the declarative customization
 * contract the host bubble renders. React owns all markup; MiniApps only
 * contribute bounded text and prompt values. The standard bubble shell,
 * composer layout, controls, and behavior are never customizable.
 */
export function normalizeMiniAppBubbleCustomization(
  params: Record<string, unknown>,
): MiniAppBubbleCustomization | undefined {
  const composerInput = asRecord(params.composer);
  const welcomeInput = asRecord(params.welcome);
  const legacyPlaceholder = boundedText(params.placeholder, 600);
  const placeholder = boundedText(composerInput.placeholder, 600) ?? legacyPlaceholder;
  const composer = placeholder
    ? { placeholder }
    : undefined;

  const suggestions = Array.isArray(welcomeInput.suggestions)
    ? welcomeInput.suggestions
      .slice(0, MINIAPP_BUBBLE_MAX_SUGGESTIONS)
      .map((item): MiniAppBubbleSuggestion | null => {
        if (typeof item === 'string') {
          const prompt = boundedText(item, 2000);
          return prompt ? { label: prompt.slice(0, 100), prompt } : null;
        }
        const suggestion = asRecord(item);
        const prompt = boundedText(suggestion.prompt, 2000);
        const label = boundedText(suggestion.label, 100) ?? prompt?.slice(0, 100);
        return prompt && label ? { label, prompt } : null;
      })
      .filter((item): item is MiniAppBubbleSuggestion => item !== null)
    : undefined;
  const welcome = {
    title: boundedText(welcomeInput.title, 140),
    description: boundedText(welcomeInput.description, 800),
    workspaceLabel: boundedText(welcomeInput.workspaceLabel, 120),
    suggestionsLabel: boundedText(welcomeInput.suggestionsLabel, 120),
    suggestions: suggestions?.length ? suggestions : undefined,
  };
  const hasWelcome = Object.values(welcome).some((value) => value !== undefined);

  const customization: MiniAppBubbleCustomization = {
    title: boundedText(params.title, 120),
    composer,
    welcome: hasWelcome ? welcome : undefined,
  };

  return Object.values(customization).some((value) => value !== undefined)
    ? customization
    : undefined;
}

/**
 * A MiniApp registration for the shared floating bubble
 * (`app.chat.claimComposer`). The name preserves the public API; the claim
 * supplies content/routing and never owns a separate composer component.
 */
export interface MiniAppComposerClaim {
  /** Device that owns this runner; never inferred from the currently selected device on reopen. */
  surfaceId?: string;
  /**
   * Identifies the exact iframe holding the claim. One app ID can have several
   * live runners at once — the installed app and its draft preview are mounted
   * side by side during AI customization — so messages and releases are keyed
   * by token, not by app ID, or one bubble message would start a run in both.
   */
  token: string;
  /** Placeholder registered into the shared ChatInput while this MiniApp is active. */
  placeholder?: string;
  /** Declarative, host-rendered bubble presentation supplied by the MiniApp. */
  customization?: MiniAppBubbleCustomization;
  /** Hidden Agent session dedicated to the active MiniApp topic. */
  sessionId?: string;
}

interface MiniAppState {
  apps: MiniAppMeta[];
  loading: boolean;
  /** App IDs whose JS workers are currently running. */
  runningWorkerIds: string[];
  /** App IDs with an active customization surface in the MiniApp tab. */
  customizingAppIds: string[];
  /** Floating bubble registrations, keyed by app ID (`app.chat.claimComposer`). */
  composerClaims: Record<string, MiniAppComposerClaim>;
  /**
   * Marketplace origin of each installed app, keyed by app ID. Apps installed
   * from anywhere else are simply absent. The local `version` counter on a
   * MiniApp is independent from the marketplace release number, so this is what
   * the gallery reads to name the release a user actually installed.
   */
  marketOrigins: Record<string, InstalledMarketOrigin>;

  setApps: (apps: MiniAppMeta[]) => void;
  upsertApp: (app: MiniAppMeta) => void;
  setLoading: (loading: boolean) => void;
  setMarketOrigins: (origins: Record<string, InstalledMarketOrigin>) => void;
  /** Records the origin of a single app right after a market install/update. */
  setMarketOrigin: (appId: string, origin: InstalledMarketOrigin) => void;
  setRunningWorkerIds: (ids: string[]) => void;
  markWorkerRunning: (id: string) => void;
  markWorkerStopped: (id: string) => void;
  markCustomizationActive: (id: string) => void;
  markCustomizationIdle: (id: string) => void;
  claimComposer: (id: string, claim: MiniAppComposerClaim) => void;
  /** Binds the claim holder to one of its validated hidden Agent sessions. */
  setComposerSession: (id: string, token: string, sessionId: string) => void;
  /** Clears the topic binding while the same runner prepares another topic. */
  clearComposerSession: (id: string, token: string) => void;
  /** Releases only if `token` still holds the claim; omit to force-release. */
  releaseComposer: (id: string, token?: string) => void;
}

export const useMiniAppStore = create<MiniAppState>((set) => ({
  apps: [],
  loading: false,
  runningWorkerIds: [],
  customizingAppIds: [],
  composerClaims: {},
  marketOrigins: {},

  setApps: (apps) =>
    set((state) => {
      const validIds = new Set(apps.map((app) => app.id));
      return {
        apps,
        runningWorkerIds: state.runningWorkerIds.filter((id) => validIds.has(id)),
        customizingAppIds: state.customizingAppIds.filter((id) => validIds.has(id)),
        composerClaims: Object.fromEntries(
          Object.entries(state.composerClaims).filter(([id]) => validIds.has(id))
        ),
        marketOrigins: Object.fromEntries(
          Object.entries(state.marketOrigins).filter(([id]) => validIds.has(id))
        ),
      };
    }),
  upsertApp: (app) =>
    set((state) => {
      const existingIndex = state.apps.findIndex((current) => current.id === app.id);
      if (existingIndex < 0) {
        return { apps: [app, ...state.apps] };
      }
      const apps = [...state.apps];
      apps[existingIndex] = app;
      return { apps };
    }),
  setLoading: (loading) => set({ loading }),
  setMarketOrigins: (marketOrigins) => set({ marketOrigins }),
  setMarketOrigin: (appId, origin) =>
    set((state) => ({ marketOrigins: { ...state.marketOrigins, [appId]: origin } })),

  setRunningWorkerIds: (ids) => set({ runningWorkerIds: Array.from(new Set(ids)) }),
  markWorkerRunning: (id) =>
    set((state) =>
      state.runningWorkerIds.includes(id) ? state : { runningWorkerIds: [...state.runningWorkerIds, id] }
    ),
  markWorkerStopped: (id) =>
    set((state) => ({
      runningWorkerIds: state.runningWorkerIds.filter((value) => value !== id),
    })),
  markCustomizationActive: (id) =>
    set((state) =>
      state.customizingAppIds.includes(id) ? state : { customizingAppIds: [...state.customizingAppIds, id] }
    ),
  markCustomizationIdle: (id) =>
    set((state) => ({
      customizingAppIds: state.customizingAppIds.filter((value) => value !== id),
    })),
  claimComposer: (id, claim) =>
    set((state) => {
      const current = state.composerClaims[id];
      const nextClaim =
        current?.token === claim.token && claim.sessionId === undefined
          ? { ...claim, sessionId: current.sessionId }
          : claim;
      return {
        composerClaims: { ...state.composerClaims, [id]: { ...nextClaim, surfaceId: claim.surfaceId ?? getActiveSurfaceId() } },
      };
    }),
  setComposerSession: (id, token, sessionId) =>
    set((state) => {
      const current = state.composerClaims[id];
      if (!current || current.token !== token || !sessionId.trim()) return state;
      if (current.sessionId === sessionId) return state;
      return {
        composerClaims: {
          ...state.composerClaims,
          [id]: { ...current, sessionId },
        },
      };
    }),
  clearComposerSession: (id, token) =>
    set((state) => {
      const current = state.composerClaims[id];
      if (!current || current.token !== token || current.sessionId === undefined) return state;
      const { sessionId: _removed, ...claim } = current;
      return {
        composerClaims: {
          ...state.composerClaims,
          [id]: claim,
        },
      };
    }),
  releaseComposer: (id, token) =>
    set((state) => {
      const current = state.composerClaims[id];
      if (!current) return state;
      // A runner that lost the claim to another runner of the same app must not
      // release it on its way out.
      if (token !== undefined && current.token !== token) return state;
      const { [id]: _removed, ...composerClaims } = state.composerClaims;
      return { composerClaims };
    }),
}));
