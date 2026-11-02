import { ModelConfig } from '../types';
import { aiApi } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import type { ConnectionTestMessageCode } from './aiConnectionTestMessages';

const log = createLogger('ConfigConverter');

 
export interface RustModelConfig {
  id: string;
  name: string;
  model_name: string;      
  format: string;
  base_url: string;        
  api_key?: string;        
  context_window: number;  
  max_tokens?: number;     
  max_images_per_request?: number;
}

 
export function convertToRustConfig(config: ModelConfig): RustModelConfig {
  return {
    id: config.id,
    name: config.name,
    model_name: config.modelName,      
    format: config.format,
    base_url: config.baseUrl,          
    api_key: config.apiKey,            
    context_window: config.contextWindow || 128128,  
    max_tokens: config.maxTokens,      
    max_images_per_request: config.maxImagesPerRequest,
  };
}

 
export function validateModelConfig(config: ModelConfig, isNewConfig: boolean = false): string[] {
  const errors: string[] = [];
  
  
  if (!isNewConfig && !config.id) errors.push('Missing configuration ID');
  if (!config.name) errors.push('Missing configuration name');
  if (!config.modelName) errors.push('Missing model name');
  if (!config.format) errors.push('Missing API format');
  if (!config.baseUrl) errors.push('Missing API base URL');
  
  return errors;
}

 
export async function invokeAICommand<T>(
  command: string, 
  config: ModelConfig, 
  additionalArgs?: Record<string, any>
): Promise<T> {
  try {
    
    const configErrors = validateModelConfig(config, false);
    if (configErrors.length > 0) {
      throw new Error(`Configuration validation failed: ${configErrors.join(', ')}`);
    }
    
    
    const rustConfig = convertToRustConfig(config);
    const result = await aiApi.invokeAICommand<T>(command, rustConfig, additionalArgs);
    return result;
    
  } catch (error) {
    log.error('AI command invocation failed', { command, error });
    
    
    if (error instanceof Error) {
      if (error.message.includes('Failed to fetch')) {
        throw new Error(`Failed to connect to the Tauri backend. Make sure the app is running. Original error: ${error.message}`);
      } else if (error.message.includes('command not found')) {
        throw new Error(`Rust backend command not found: ${command}. Please check the backend build.`);
      } else {
        throw new Error(`Rust backend invocation failed: ${error.message}`);
      }
    } else {
      throw new Error(`Rust backend invocation failed: ${String(error)}`);
    }
  }
}

 
export async function invokeAIChat(
  config: ModelConfig, 
  messages: any[]
): Promise<any> {
  return invokeAICommand('ai_chat', config, { messages });
}

 
export interface ConnectionTestResult {
  success: boolean;
  response_time_ms: number;
  model_response?: string;
  message_code?: ConnectionTestMessageCode;
  error_details?: string;
}

 
export async function testAIConnection(config: ModelConfig): Promise<ConnectionTestResult> {
  return invokeAICommand<ConnectionTestResult>('test_ai_connection', config);
}

 
export async function testAIConfigConnection(config: ModelConfig): Promise<ConnectionTestResult> {
  return invokeAICommand('test_ai_config_connection', config);
}
