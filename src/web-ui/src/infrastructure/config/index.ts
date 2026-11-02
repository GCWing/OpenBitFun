/**
 * Configuration infrastructure unified exports.
 */

// Core config logic
export * from './core';

// Types
export * from './types';
export * from './hooks';

// Services
export * from './services/ConfigManager';
export * from './services/modelConfigs';
export * from './services/PermissionConfigService';


// Default instance
export { configManager } from './services/ConfigManager';

// Re-export common types
export type {
  ModelConfig,
  ProviderTemplate,
  ApiFormat
} from '../../shared/types';

// Configuration infrastructure lifecycle
import { configManager } from './services/ConfigManager';
import { globalEventBus } from '../event-bus';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ConfigInfrastructure');

export async function initializeConfigInfrastructure(): Promise<void> {
  log.info('Initializing configuration infrastructure');
  
  try {
    // Reload configuration
    await configManager.reload();
    
    globalEventBus.emit('infrastructure:config:ready');
    log.info('Configuration infrastructure initialized');
  } catch (error) {
    log.error('Failed to initialize configuration infrastructure', error);
    throw error;
  }
}

// Configuration infrastructure metadata
export const ConfigInfrastructureMetadata = {
  name: 'Config Infrastructure',
  version: '1.0.0',
  description: 'Application configuration management infrastructure',
  dependencies: ['event-bus'],
  capabilities: [
    'configuration-management',
    'appearance-selection',
    'ai-model-configuration',
    'editor-settings',
    'import-export'
  ]
} as const;
