import { create } from 'zustand';

import {
  getActiveSurfaceId,
  surfaceScopedKey,
  type DeviceSurfaceId,
} from '@/infrastructure/peer-device/deviceSurface';

export type AskUserQuestionAnswer = string | string[];
export type AskUserQuestionSubmissionPhase = 'idle' | 'submitting' | 'submitted';

export interface AskUserQuestionDraft {
  answers: Record<number, AskUserQuestionAnswer>;
  otherInputs: Record<number, string>;
  submissionPhase: AskUserQuestionSubmissionPhase;
  updatedAt: number;
}

interface AskUserQuestionDraftState {
  drafts: Record<string, AskUserQuestionDraft>;
  setSingleAnswer: (key: string, questionIndex: number, value: string) => void;
  setMultiAnswer: (
    key: string,
    questionIndex: number,
    value: string,
    checked: boolean,
  ) => void;
  setOtherInput: (
    key: string,
    questionIndex: number,
    value: string,
  ) => void;
  setSubmissionPhase: (key: string, phase: AskUserQuestionSubmissionPhase) => void;
  clearDraft: (key: string) => void;
  removeSessionDrafts: (sessionIds: Iterable<string>) => void;
  removeSurfaceDrafts: (surfaceId: DeviceSurfaceId) => void;
  reconcilePendingTools: (
    surfaceId: DeviceSurfaceId,
    sessionId: string,
    pendingToolIds: Iterable<string>,
  ) => void;
}

export function createEmptyAskUserQuestionDraft(): AskUserQuestionDraft {
  return {
    answers: {},
    otherInputs: {},
    submissionPhase: 'idle',
    updatedAt: 0,
  };
}

export function askUserQuestionDraftKey(
  sessionId: string,
  toolId: string,
  surfaceId = getActiveSurfaceId(),
): string {
  return surfaceScopedKey(surfaceId, sessionId, toolId);
}

/** Follow-up answers outlive the original pending-question mailbox entry. */
export function askUserQuestionFollowUpDraftKey(
  sessionId: string,
  toolId: string,
  surfaceId = getActiveSurfaceId(),
): string {
  return surfaceScopedKey(surfaceId, sessionId, toolId, 'follow-up');
}

function parseDraftKey(key: string): [DeviceSurfaceId, string, string, 'follow-up'?] | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      !Array.isArray(parsed)
      || !(parsed.length === 3 || parsed.length === 4 && parsed[3] === 'follow-up')
      || typeof parsed[0] !== 'string'
      || typeof parsed[1] !== 'string'
      || typeof parsed[2] !== 'string'
    ) {
      return null;
    }
    return [parsed[0], parsed[1], parsed[2], parsed[3]];
  } catch {
    return null;
  }
}

function updateDraft(
  state: AskUserQuestionDraftState,
  key: string,
  update: (draft: AskUserQuestionDraft) => AskUserQuestionDraft,
): Pick<AskUserQuestionDraftState, 'drafts'> {
  const current = state.drafts[key] ?? createEmptyAskUserQuestionDraft();
  return {
    drafts: {
      ...state.drafts,
      [key]: {
        ...update(current),
        updatedAt: Date.now(),
      },
    },
  };
}

function removeMatchingDrafts(
  state: AskUserQuestionDraftState,
  shouldRemove: (key: string) => boolean,
): Pick<AskUserQuestionDraftState, 'drafts'> | AskUserQuestionDraftState {
  const drafts = { ...state.drafts };
  let changed = false;
  for (const key of Object.keys(drafts)) {
    if (shouldRemove(key)) {
      delete drafts[key];
      changed = true;
    }
  }
  return changed ? { drafts } : state;
}

export const useAskUserQuestionDraftStore = create<AskUserQuestionDraftState>((set) => ({
  drafts: {},

  setSingleAnswer: (key, questionIndex, value) => {
    set(state => updateDraft(state, key, draft => ({
      ...draft,
      answers: {
        ...draft.answers,
        [questionIndex]: value,
      },
    })));
  },

  setMultiAnswer: (key, questionIndex, value, checked) => {
    set(state => updateDraft(state, key, draft => {
      const current = draft.answers[questionIndex];
      const currentValues = Array.isArray(current) ? current : [];
      const nextValues = checked
        ? (currentValues.includes(value) ? currentValues : [...currentValues, value])
        : currentValues.filter(candidate => candidate !== value);
      return {
        ...draft,
        answers: {
          ...draft.answers,
          [questionIndex]: nextValues,
        },
      };
    }));
  },

  setOtherInput: (key, questionIndex, value) => {
    set(state => updateDraft(state, key, draft => {
      const isEmpty = value.trim().length === 0;
      return {
        ...draft,
        otherInputs: {
          ...draft.otherInputs,
          [questionIndex]: isEmpty ? '' : value,
        },
      };
    }));
  },

  setSubmissionPhase: (key, submissionPhase) => {
    set(state => {
      if (!(key in state.drafts)) {
        return state;
      }
      return updateDraft(state, key, draft => ({
        ...draft,
        submissionPhase,
      }));
    });
  },

  clearDraft: (key) => {
    set(state => {
      if (!(key in state.drafts)) {
        return state;
      }
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
  },

  removeSessionDrafts: (sessionIds) => {
    const activeSurfaceId = getActiveSurfaceId();
    const removedSessionIds = new Set(sessionIds);
    if (removedSessionIds.size === 0) {
      return;
    }
    set(state => removeMatchingDrafts(state, key => {
      const parsed = parseDraftKey(key);
      return parsed !== null
        && parsed[0] === activeSurfaceId
        && removedSessionIds.has(parsed[1]);
    }));
  },

  removeSurfaceDrafts: (surfaceId) => {
    set(state => removeMatchingDrafts(state, key => parseDraftKey(key)?.[0] === surfaceId));
  },

  reconcilePendingTools: (surfaceId, sessionId, pendingToolIds) => {
    const retainedToolIds = new Set(pendingToolIds);
    set(state => removeMatchingDrafts(state, key => {
      const parsed = parseDraftKey(key);
      return parsed !== null
        && parsed[0] === surfaceId
        && parsed[1] === sessionId
        && parsed[3] !== 'follow-up'
        && !retainedToolIds.has(parsed[2]);
    }));
  },
}));

export const askUserQuestionDraftStore = useAskUserQuestionDraftStore;
