import type * as Monaco from 'monaco-editor';
import { createLogger } from '@/shared/utils/logger';
import type {
  AppearanceRendererAdapter,
  AppearanceRendererContext,
  MonacoAppearanceSettings,
} from '../types';
import {
  isMonacoAppearanceColor,
  projectMonacoAppearanceSettings,
  validateMonacoAppearanceColorSemantics,
} from './monacoThemeColorCodec';

const log = createLogger('MonacoAppearanceAdapter');

export interface MonacoAppearanceChangeEvent {
  previousThemeId: string | null;
  currentThemeId: string;
  revision: number;
}

type MonacoModule = typeof Monaco;
type MonacoAppearanceListener = (event: MonacoAppearanceChangeEvent) => void;

const FONT_STYLE_PATTERN = /^(?:|italic|bold|underline|strikethrough)(?: (?:italic|bold|underline|strikethrough))*$/;
const THEME_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class MonacoAppearanceAdapter implements AppearanceRendererAdapter<'monaco'> {
  readonly id = 'monaco';

  private monaco: MonacoModule | null = null;
  private settings: MonacoAppearanceSettings | null = null;
  private revision = 0;
  private currentThemeId: string | null = null;
  private applied: { monaco: MonacoModule; settings: MonacoAppearanceSettings; revision: number } | null = null;
  private listeners = new Set<MonacoAppearanceListener>();

  validate(settings: unknown): string[] {
    const errors: string[] = [];
    if (!isRecord(settings)) return ['Settings must be an object'];
    const known = new Set(['id', 'base', 'inherit', 'rules', 'colors']);
    Object.keys(settings).forEach(key => {
      if (!known.has(key)) errors.push(`Unknown setting: ${key}`);
    });
    if (typeof settings.id !== 'string' || !THEME_ID_PATTERN.test(settings.id)) {
      errors.push('id must contain only lowercase letters, digits, and hyphens');
    }
    if (!['vs', 'vs-dark', 'hc-black', 'hc-light'].includes(String(settings.base))) {
      errors.push('base must be a supported Monaco base theme');
    }
    if (typeof settings.inherit !== 'boolean') errors.push('inherit must be boolean');
    if (!Array.isArray(settings.rules) || settings.rules.length > 512) {
      errors.push('rules must be an array with at most 512 entries');
    } else {
      settings.rules.forEach((rule, index) => {
        if (!isRecord(rule) || typeof rule.token !== 'string' || rule.token.length > 160) {
          errors.push(`rules.${index}.token is invalid`);
          return;
        }
        const keys = new Set(['token', 'foreground', 'background', 'fontStyle']);
        Object.keys(rule).forEach(key => {
          if (!keys.has(key)) errors.push(`rules.${index} has unknown field ${key}`);
        });
        for (const key of ['foreground', 'background'] as const) {
          const color = rule[key];
          if (color !== undefined && (typeof color !== 'string' || !isMonacoAppearanceColor(color, true))) {
            errors.push(`rules.${index}.${key} is not a supported color`);
          }
        }
        if (rule.fontStyle !== undefined && (typeof rule.fontStyle !== 'string' || !FONT_STYLE_PATTERN.test(rule.fontStyle))) {
          errors.push(`rules.${index}.fontStyle is invalid`);
        }
      });
    }
    if (!isRecord(settings.colors) || Object.keys(settings.colors).length > 512) {
      errors.push('colors must be an object with at most 512 entries');
    } else {
      Object.entries(settings.colors).forEach(([key, value]) => {
        if (!/^[A-Za-z][A-Za-z0-9.]{0,159}$/.test(key)) errors.push(`colors.${key} has an invalid key`);
        if (typeof value !== 'string' || !isMonacoAppearanceColor(value)) {
          errors.push(`colors.${key} is not a supported color`);
        }
      });
    }
    if (Array.isArray(settings.rules)
      && settings.rules.every(isRecord)
      && isRecord(settings.colors)
      && Object.values(settings.colors).every(value => typeof value === 'string')) {
      errors.push(...validateMonacoAppearanceColorSemantics(settings as unknown as MonacoAppearanceSettings));
    }
    return errors;
  }

  async apply(
    next: Readonly<MonacoAppearanceSettings> | undefined,
    _previous: Readonly<MonacoAppearanceSettings> | undefined,
    context: AppearanceRendererContext,
  ): Promise<void> {
    const settings = next ?? null;
    if (settings) {
      const errors = this.validate(settings);
      if (errors.length > 0) throw new Error(`Invalid Monaco appearance: ${errors.join('; ')}`);
    }
    this.settings = settings;
    this.revision = context.revision;
    if (this.monaco && settings) {
      this.applyToMonaco(this.monaco, settings, context.revision);
    }
  }

  initialize(): void {
    if (this.monaco && this.settings) {
      this.applyToMonaco(this.monaco, this.settings, this.revision);
    }
  }

  attachMonaco(monaco: MonacoModule): string {
    this.monaco = monaco;
    const settings = this.requireSettings();
    // A new view shares the runtime's existing theme. Re-defining it also
    // invalidates the stylesheet/token colors of every retained editor.
    if (this.applied?.monaco !== monaco || this.applied.settings !== settings || this.applied.revision !== this.revision) {
      this.applyToMonaco(monaco, settings, this.revision);
    }
    return settings.id;
  }

  getCurrentThemeId(): string {
    return this.currentThemeId ?? this.requireSettings().id;
  }

  subscribe(listener: MonacoAppearanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyToMonaco(
    monaco: MonacoModule,
    settings: MonacoAppearanceSettings,
    revision: number,
  ): void {
    const previousThemeId = this.currentThemeId;
    const projectedSettings = projectMonacoAppearanceSettings(settings);
    monaco.editor.defineTheme(settings.id, {
      base: projectedSettings.base,
      inherit: projectedSettings.inherit,
      rules: projectedSettings.rules,
      colors: projectedSettings.colors,
    });
    monaco.editor.setTheme(settings.id);
    monaco.editor.getEditors().forEach((editor, index) => {
      try {
        editor.updateOptions({});
      } catch (error) {
        log.warn('Failed to refresh editor after appearance change', { index, error });
      }
    });
    this.currentThemeId = settings.id;
    this.applied = { monaco, settings, revision };
    if (previousThemeId !== settings.id) {
      const event = { previousThemeId, currentThemeId: settings.id, revision };
      this.listeners.forEach(listener => listener(event));
    }
  }

  private requireSettings(): MonacoAppearanceSettings {
    if (!this.settings) throw new Error('Monaco appearance has not been applied');
    return this.settings;
  }
}

export const monacoAppearanceAdapter = new MonacoAppearanceAdapter();
