 

import { configManager } from './ConfigManager';
import { DEFAULT_AGENT_COMPANION_PET } from './AgentCompanionPetService';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { createLogger } from '@/shared/utils/logger';
import type { VoiceInputSettings } from '../types';

const log = createLogger('AIExperienceConfig');

/** A quick action item shown in the post-coding actions menu. */
export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  enabled: boolean;
}

export interface AIExperienceSettings {
  enable_session_title_generation: boolean;
  /** Whether to show the desktop Agent companion. */
  enable_agent_companion: boolean;
  /** Optional Petdex-compatible companion package selected by the user. */
  agent_companion_pet?: AgentCompanionPetSelection | null;
  /** Flashgrep-backed accelerated workspace search for local workspaces. */
  enable_workspace_search: boolean;
  /** Local speech-to-text settings for the chat composer. */
  voice_input: VoiceInputSettings;
  /** User-defined quick actions shown in the post-coding actions menu. */
  quick_actions?: QuickAction[];
  /** Absent on older execution hosts; their commit co-author policy is not configurable. */
  enable_git_commit_coauthor?: boolean;
}

export type AIExperienceSettingsPatch = Partial<Omit<AIExperienceSettings, 'voice_input'>> & {
  voice_input?: Partial<VoiceInputSettings>;
};

export interface AgentCompanionPetSelection {
  id: string;
  displayName: string;
  description?: string | null;
  source: 'preset' | 'user';
  packagePath: string;
  spritesheetPath: string;
  spritesheetMimeType: string;
  /** Absent in legacy saved selections; resolve from the installed package before rendering. */
  spriteVersionNumber?: number | null;
}

const CONFIG_PATH = 'app.ai_experience';

type PersistedAIExperienceSettings = AIExperienceSettings & {
  /** Retired visual mode setting from older builds. */
  enable_visual_mode?: unknown;
  /** Retired in favor of the desktop-only companion surface. */
  agent_companion_display_mode?: unknown;
};

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'commit',
    label: 'Commit',
    prompt: 'Commit all current code changes',
    enabled: true,
  },
  {
    id: 'create_pr',
    label: 'Create PR',
    prompt: 'Create a Pull Request for the current branch',
    enabled: true,
  },
];

const defaultSettings: AIExperienceSettings = {
  enable_session_title_generation: true,
  enable_agent_companion: true,
  agent_companion_pet: DEFAULT_AGENT_COMPANION_PET,
  enable_workspace_search: false,
  voice_input: {
    enabled: true,
    provider: 'local',
    model_id: 'sensevoice-small-int8',
    default_language: 'auto',
    max_recording_seconds: 60,
    microphone_device_id: '',
  },
  quick_actions: DEFAULT_QUICK_ACTIONS,
};

function normalizeSettings(settings: PersistedAIExperienceSettings | null | undefined): AIExperienceSettings {
  // Older builds persisted "input" or "desktop" here. The input surface no
  // longer exists, so discard the retired field and let the enable flag own
  // the single desktop companion surface.
  const {
    enable_visual_mode: _legacyVisualMode,
    agent_companion_display_mode: _legacyDisplayMode,
    ...currentSettings
  } = settings ?? {} as PersistedAIExperienceSettings;
  const merged = {
    ...defaultSettings,
    ...currentSettings,
    voice_input: {
      ...defaultSettings.voice_input,
      ...currentSettings.voice_input,
    },
    quick_actions: currentSettings.quick_actions ?? DEFAULT_QUICK_ACTIONS,
    // Older hosts omit the field; keep it absent so the UI can gate unsupported writes.
    enable_git_commit_coauthor: typeof currentSettings.enable_git_commit_coauthor === 'boolean'
      ? currentSettings.enable_git_commit_coauthor
      : undefined,
  };
  // Legacy configs used null to mean the built-in SVG panda. Resolve null to the current preset.
  if (!merged.agent_companion_pet) {
    merged.agent_companion_pet = DEFAULT_AGENT_COMPANION_PET;
  }
  return merged;
}

 
export class AIExperienceConfigService {
  private static instance: AIExperienceConfigService;
  private cachedSettings: AIExperienceSettings | null = null;
  private listeners: Set<(settings: AIExperienceSettings) => void> = new Set();
  private unwatchConfig: (() => void) | null = null;

  private constructor() {}

  private ensureConfigWatcher(): void {
    if (this.unwatchConfig) {
      return;
    }
    this.unwatchConfig = configManager.watch(CONFIG_PATH, () => {
      void this.reload();
    });
  }

   
  static getInstance(): AIExperienceConfigService {
    if (!AIExperienceConfigService.instance) {
      AIExperienceConfigService.instance = new AIExperienceConfigService();
    }
    return AIExperienceConfigService.instance;
  }

   
  private async loadSettings(): Promise<void> {
    this.ensureConfigWatcher();
    try {
      const settings = await configManager.getConfig<PersistedAIExperienceSettings>(CONFIG_PATH);
      const merged = normalizeSettings(settings);
      this.cachedSettings = merged;
    } catch (error) {
      log.warn('Failed to load config, using defaults', error);
      this.cachedSettings = { ...defaultSettings };
    }
  }

   
  getSettings(): AIExperienceSettings {
    if (this.cachedSettings) {
      return { ...this.cachedSettings };
    }
    
    return { ...defaultSettings };
  }

   
  async getSettingsAsync(options?: { forceRefresh?: boolean; requireLoaded?: boolean }): Promise<AIExperienceSettings> {
    this.ensureConfigWatcher();
    try {
      const settings = options?.forceRefresh
        ? await configAPI.getConfig(CONFIG_PATH) as PersistedAIExperienceSettings
        : await configManager.getConfig<PersistedAIExperienceSettings>(CONFIG_PATH);
      this.cachedSettings = normalizeSettings(settings);
      return this.cachedSettings;
    } catch (error) {
      log.error('Failed to get config', error);
      if (options?.requireLoaded) throw error;
      return this.getSettings(); 
    }
  }

   
  /** Save only the fields the caller edited, never a cached settings snapshot. */
  async saveSettings(settings: AIExperienceSettingsPatch): Promise<void> {
    this.ensureConfigWatcher();
    try {
      for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) continue;
        if (key === 'voice_input' && value && typeof value === 'object') {
          for (const [voiceKey, voiceValue] of Object.entries(value)) {
            if (voiceValue !== undefined) {
              await configManager.setConfig(`${CONFIG_PATH}.voice_input.${voiceKey}`, voiceValue);
            }
          }
        } else {
          await configManager.setConfig(`${CONFIG_PATH}.${key}`, value);
        }
      }
      await this.loadSettings();
      this.notifyListeners();
    } catch (error) {
      log.error('Failed to save config', error);
      throw error;
    }
  }

   
  isSessionTitleGenerationEnabled(): boolean {
    return this.getSettings().enable_session_title_generation;
  }

  addChangeListener(listener: (settings: AIExperienceSettings) => void): () => void {
    this.ensureConfigWatcher();
    this.listeners.add(listener);
    
    
    return () => {
      this.listeners.delete(listener);
    };
  }

   
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.getSettings());
      } catch (error) {
        log.error('Listener execution failed', error);
      }
    });
  }

   
  async reload(): Promise<void> {
    await this.loadSettings();
    this.notifyListeners();
  }

   
  dispose(): void {
    if (this.unwatchConfig) {
      this.unwatchConfig();
      this.unwatchConfig = null;
    }
    this.listeners.clear();
  }
}

 
export const aiExperienceConfigService = AIExperienceConfigService.getInstance();
