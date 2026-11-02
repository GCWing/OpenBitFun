import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';

export const DESKTOP_CARD_CHANGED_EVENT = 'desktop-card://changed';
export const DESKTOP_CARD_STATE_EVENT = 'desktop-card://state';

export type DesktopCardTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';
export type DesktopCardMetricFormat = 'text' | 'number' | 'percent' | 'currency' | 'datetime' | 'relativeTime';

export interface DesktopCardChecklistItem {
  id: string;
  text: string;
  done?: boolean;
}

export interface DesktopCardMetricItem {
  label: string;
  value?: unknown;
  path?: string;
  format?: DesktopCardMetricFormat | string;
  digits?: number;
  currency?: string;
  prefix?: string;
  suffix?: string;
  tone?: DesktopCardTone | string;
  toneMap?: Record<string, string>;
  signTone?: boolean;
  hint?: string;
  hintPath?: string;
  emphasis?: boolean;
}

export type DesktopCardChartStyle = 'bar' | 'column' | 'line' | 'donut' | 'stacked';
export type DesktopCardChartLabelFormat = 'text' | 'date' | 'time' | 'weekday' | 'datetime';

export interface DesktopCardChartItem {
  label: string;
  value: number;
  tone?: DesktopCardTone | string;
  hint?: string;
}

export interface DesktopCardChartTemplate {
  kind: 'chart';
  /** Records written by a newer build may carry a style this build does not draw. */
  chart: DesktopCardChartStyle | string;
  items?: DesktopCardChartItem[];
  itemsPath?: string;
  labelsPath?: string;
  labelKey?: string;
  valueKey?: string;
  hintKey?: string;
  total?: number;
  totalPath?: string;
  remainderLabel?: string;
  format?: 'number' | 'percent' | 'currency' | string;
  digits?: number;
  currency?: string;
  prefix?: string;
  suffix?: string;
  labelFormat?: DesktopCardChartLabelFormat | string;
  caption?: string;
}

export type DesktopCardTemplate =
  | {
    kind: 'countdown';
    targetAtMs: number;
    startedAtMs?: number;
    message?: string;
    notify?: boolean;
    notifiedAtMs?: number;
  }
  | { kind: 'checklist'; items: DesktopCardChecklistItem[] }
  | { kind: 'note'; text: string }
  | {
    kind: 'progress';
    value?: number;
    max?: number;
    valuePath?: string;
    maxPath?: string;
    status?: string;
    statusPath?: string;
  }
  | { kind: 'metrics'; items: DesktopCardMetricItem[]; layout?: 'list' | 'grid' | string }
  | DesktopCardChartTemplate
  | { kind: 'cronJob'; jobId: string }
  | { kind: 'custom'; html: string };

export type DesktopCardDataSource =
  | {
    kind: 'http';
    url: string;
    headers?: Record<string, string>;
    intervalSeconds: number;
    parse?: 'json' | 'text';
  }
  | {
    kind: 'command';
    command: string;
    cwd?: string;
    intervalSeconds: number;
    timeoutSeconds?: number;
    parse?: 'json' | 'text';
  };

export interface DesktopCardDataSnapshot {
  fetchedAtMs: number;
  value?: unknown;
  error?: string;
  /** stderr of a command that still exited successfully. */
  warning?: string;
}

export interface DesktopCardRecord {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  accent?: DesktopCardTone | string;
  /** Records written by a newer build may carry a template kind this build does not know. */
  template: DesktopCardTemplate | ({ kind?: string } & Record<string, unknown>);
  data?: unknown;
  dataSource?: DesktopCardDataSource | ({ kind?: string } & Record<string, unknown>);
  link?: string;
  size?: { width: number; height: number };
  position?: { x: number; y: number };
  visible: boolean;
  alwaysOnTop: boolean;
  origin?: { sessionId?: string; agentType?: string; workspacePath?: string };
  createdAtMs: number;
  updatedAtMs: number;
  lastData?: DesktopCardDataSnapshot;
}

export interface DesktopCardList {
  enabled: boolean;
  cards: DesktopCardRecord[];
}

export interface DesktopCardChangedPayload {
  cardId: string;
  card: DesktopCardRecord | null;
  deleted: boolean;
}

export interface DesktopCardStatePayload {
  enabled: boolean;
}

/** Desktop cards are host windows on this computer; every command stays controller-local. */
export class DesktopCardAPI {
  private async invoke<T>(command: string, request: Record<string, unknown>): Promise<T> {
    try {
      return await api.invoke<T>(command, { request });
    } catch (error) {
      throw createTauriCommandError(command, error, request);
    }
  }

  async list(): Promise<DesktopCardList> {
    const result = await this.invoke<Partial<DesktopCardList> | null>('desktop_card_list', {});
    return {
      enabled: result?.enabled !== false,
      cards: Array.isArray(result?.cards) ? result.cards : [],
    };
  }

  async get(cardId: string): Promise<DesktopCardRecord> {
    return this.invoke<DesktopCardRecord>('desktop_card_get', { cardId });
  }

  async setVisible(cardId: string, visible: boolean): Promise<DesktopCardRecord> {
    return this.invoke<DesktopCardRecord>('desktop_card_set_visible', { cardId, visible });
  }

  async delete(cardId: string): Promise<void> {
    await this.invoke<void>('desktop_card_delete', { cardId });
  }

  async refresh(cardId: string): Promise<DesktopCardRecord> {
    return this.invoke<DesktopCardRecord>('desktop_card_refresh', { cardId });
  }

  async setChecklistItem(cardId: string, itemId: string, done: boolean): Promise<DesktopCardRecord> {
    return this.invoke<DesktopCardRecord>('desktop_card_set_checklist_item', { cardId, itemId, done });
  }

  async setAlwaysOnTop(cardId: string, alwaysOnTop: boolean): Promise<DesktopCardRecord> {
    return this.invoke<DesktopCardRecord>('desktop_card_set_always_on_top', { cardId, alwaysOnTop });
  }

  onChanged(callback: (payload: DesktopCardChangedPayload) => void): () => void {
    return api.listen<DesktopCardChangedPayload>(DESKTOP_CARD_CHANGED_EVENT, callback);
  }

  onStateChanged(callback: (payload: DesktopCardStatePayload) => void): () => void {
    return api.listen<DesktopCardStatePayload>(DESKTOP_CARD_STATE_EVENT, callback);
  }
}

export const desktopCardAPI = new DesktopCardAPI();
