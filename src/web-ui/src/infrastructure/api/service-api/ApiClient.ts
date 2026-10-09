 

import {
  getTransportAdapter,
  isPeerLocalOnlyCommand,
  ITransportAdapter,
  type TransportRequestTiming,
} from '../adapters';
import {
  IApiClient,
  ApiResponse,
  ApiError,
  ApiRequest,
  ApiRequestConfig,
  TauriCommandConfig,
  HttpRequestConfig,
  ApiMiddleware,
  ApiStats,
  ApiConfig
} from './types';
import { createLogger } from '@/shared/utils/logger';
import { elapsedMs, nowMs } from '@/shared/utils/timing';
import { estimateJsonBytes, isRemoteTraceRequest, startupTrace } from '@/shared/utils/startupTrace';
import { sanitizeErrorForLog, sanitizeLogValue, sanitizeTextForLog } from '../logSanitizer';
import {
  SurfaceChangedError,
  getActiveSurfaceScope,
  isSurfaceChangedError,
} from '@/infrastructure/peer-device/deviceSurface';

const log = createLogger('ApiClient');
const sanitizeForLog = sanitizeLogValue;
const SESSION_RESPONSE_ESTIMATE_MAX_BYTES = 2 * 1024 * 1024;

function responseEstimateMaxBytes(command: string): number | undefined {
  return command === 'restore_session_view' ||
    command === 'restore_session_with_turns' ||
    command === 'load_session_turn_window' ||
    command === 'load_session_turns'
    ? SESSION_RESPONSE_ESTIMATE_MAX_BYTES
    : undefined;
}

function shouldEstimateApiPayloadBytes(): boolean {
  return globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ === true;
}

function transportErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'detail', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    try {
      return JSON.stringify(error) || 'Unknown command error';
    } catch {
      return 'Unknown command error';
    }
  }
  return String(error);
}

function apiErrorCause(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const transportError = error as Error & { code?: unknown; data?: unknown };
  if (transportError.code === undefined && transportError.data === undefined) {
    return error.message;
  }
  return {
    message: error.message,
    ...(transportError.code !== undefined ? { code: transportError.code } : {}),
    ...(transportError.data !== undefined ? { data: transportError.data } : {}),
  };
}

function isOptionalConfigNotFoundCommand(config: TauriCommandConfig, error: unknown): boolean {
  if (config.command !== 'get_config') {
    return false;
  }

  const requestPayload = config.args?.request;
  if (!requestPayload || typeof requestPayload !== 'object') {
    return false;
  }

  if (!(requestPayload as Record<string, unknown>).skipRetryOnNotFound) {
    return false;
  }

  const errorMessage = transportErrorMessage(error);
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('not found') && normalized.includes('config path');
}

function isOptionalConfigNotFound(request: ApiRequest, error: unknown): boolean {
  if (request.type !== 'tauri') {
    return false;
  }

  return isOptionalConfigNotFoundCommand(request.config as TauriCommandConfig, error);
}

function traceTargetForCommand(command: string, payload: unknown): string | undefined {
  if (command === 'explorer_get_children') {
    return 'file_explorer:children';
  }

  if (command === 'start_file_watch') {
    const record = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {};
    return record.recursive === true ? 'file_watch:recursive' : 'file_watch:non_recursive';
  }

  if (command === 'stop_file_watch') {
    return 'file_watch:stop';
  }

  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const request = (payload as { request?: unknown }).request;
  if (!request || typeof request !== 'object') {
    return undefined;
  }

  const record = request as Record<string, unknown>;
  if ((command === 'get_config' || command === 'set_config') && typeof record.path === 'string') {
    return record.path;
  }

  if (command === 'get_configs' && Array.isArray(record.paths)) {
    const paths = record.paths.filter((item): item is string => typeof item === 'string');
    return paths.length > 0 ? paths.join(',') : undefined;
  }

  return undefined;
}

async function waitForTransport<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const error = new Error('Request timeout');
    error.name = 'AbortError';
    throw error;
  }

  let rejectOnAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const handleAbort = () => {
    const error = new Error('Request timeout');
    error.name = 'AbortError';
    rejectOnAbort(error);
  };
  signal.addEventListener('abort', handleAbort, { once: true });

  try {
    return await Promise.race([request, aborted]);
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

export class ApiClient implements IApiClient {
  private config: ApiConfig;
  private activeRequests = new Map<string, AbortController>();
  private activeRequestPressure = new Map<string, { maxConcurrentRequests: number }>();
  private stats: ApiStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    activeRequests: 0
  };
  private responseTimes: number[] = [];
  
  
  private adapter: ITransportAdapter;

  constructor(config: Partial<ApiConfig> = {}) {
    this.config = {
      timeout: 30000,
      retries: 0,
      retryDelay: 1000,
      enableLogging: process.env.NODE_ENV === 'development',
      middleware: [],
      ...config
    };
    
    
    this.adapter = getTransportAdapter();
  }

  async invoke<T = any>(
    command: string, 
    args?: any,
    config?: ApiRequestConfig
  ): Promise<T> {
    const requestConfig: TauriCommandConfig = {
      command,
      args: args,
      ...this.config,
      ...config
    };

    const request = this.createRequest('tauri', requestConfig);
    return this.executeRequest<T>(request);
  }

  async request<T = any>(config: HttpRequestConfig): Promise<T> {
    const requestConfig: HttpRequestConfig = {
      ...this.config,
      ...config
    };

    const request = this.createRequest('http', requestConfig);
    return this.executeRequest<T>(request);
  }

  cancelAll(): void {
    this.activeRequests.forEach(controller => {
      controller.abort();
    });
    this.activeRequests.clear();
  }

   
  listen<T = any>(event: string, callback: (data: T) => void): () => void {
    try {
      return this.adapter.listen<T>(event, callback);
    } catch (error) {
      log.error('Failed to listen to event', { event, error });
      
      return () => {};
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      
      if (!this.adapter.isConnected()) {
        await this.adapter.connect();
      }
      
      
      await this.invoke('ping', {}, { timeout: 5000, retries: 1 });
      return true;
    } catch (_error) {
      return false;
    }
  }

  getStats(): ApiStats {
    return { ...this.stats };
  }
  
   
  getAdapter(): ITransportAdapter {
    return this.adapter;
  }

  /** Re-bind to the process-global transport after Peer Mode enter/exit. */
  reattachTransportAdapter(): void {
    this.adapter = getTransportAdapter();
  }

  async waitForListenerRegistrations(): Promise<void> {
    await this.adapter.waitForListenerRegistrations?.();
  }

  private createRequest(type: 'tauri' | 'http', config: TauriCommandConfig | HttpRequestConfig): ApiRequest {
    const scope = type === 'tauri' ? getActiveSurfaceScope() : null;
    return {
      id: `${type}-${Date.now()}-${Math.random()}`,
      type,
      config,
      timestamp: new Date(),
      retryCount: 0,
      surfaceId: scope?.surfaceId,
      surfaceEpoch: scope?.epoch,
    };
  }

  private assertRequestSurface(request: ApiRequest, action: string): void {
    if (request.type !== 'tauri') {
      return;
    }
    const command = (request.config as TauriCommandConfig).command;
    // These commands are controller-plane operations even while a peer is
    // rendered, so a UI surface activation does not change their authority.
    if (isPeerLocalOnlyCommand(command)) {
      return;
    }
    const scope = getActiveSurfaceScope();
    if (request.surfaceId !== scope.surfaceId || request.surfaceEpoch !== scope.epoch) {
      throw new SurfaceChangedError(
        request.surfaceId ?? scope.surfaceId,
        request.surfaceEpoch ?? scope.epoch,
        action,
      );
    }
  }

  private async executeRequest<T>(request: ApiRequest): Promise<T> {
    const startedAt = nowMs();
    const estimatePayloadBytes = shouldEstimateApiPayloadBytes();
    const tracePayload = request.type === 'tauri'
      ? (request.config as TauriCommandConfig).args
      : {
          params: (request.config as HttpRequestConfig).params,
          data: (request.config as HttpRequestConfig).data,
        };
    const traceCommand = request.type === 'tauri'
      ? (request.config as TauriCommandConfig).command
      : `${(request.config as HttpRequestConfig).method} ${(request.config as HttpRequestConfig).url}`;
    const tracePayloadStartedAt = estimatePayloadBytes ? nowMs() : undefined;
    const requestBytes = estimatePayloadBytes ? estimateJsonBytes(tracePayload) : undefined;
    const remote = isRemoteTraceRequest(tracePayload);
    const traceTarget = traceTargetForCommand(traceCommand, tracePayload);
    const requestPayloadEstimateDurationMs = tracePayloadStartedAt !== undefined
      ? elapsedMs(tracePayloadStartedAt)
      : undefined;
    let activeRequestsAtStart = 0;
    let activeRequestsAtEnd = 0;
    let maxConcurrentRequests = 0;
    let transportTiming: TransportRequestTiming | undefined;
    
    this.updateStats({ totalRequests: this.stats.totalRequests + 1 });

    try {
      // In particular this stops an ApiClient retry from following a newly
      // rebound `this.adapter` onto another device.
      this.assertRequestSurface(request, traceCommand);
      
      const controller = new AbortController();
      activeRequestsAtStart = this.activeRequests.size;
      this.activeRequests.set(request.id, controller);
      const pressure = { maxConcurrentRequests: this.activeRequests.size };
      this.activeRequestPressure.set(request.id, pressure);
      this.activeRequestPressure.forEach(item => {
        item.maxConcurrentRequests = Math.max(item.maxConcurrentRequests, this.activeRequests.size);
      });

      
      // A non-positive timeout opts out of the deadline. `??` is deliberate: a
      // caller that disables the deadline must not fall back to the default.
      const timeoutMs = request.config.timeout ?? this.config.timeout;
      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
          }, timeoutMs)
        : undefined;

      try {
        
        const response = await this.applyMiddleware(request, async (req) => {
          // Middleware may delay or replay `next()`. Check at the actual
          // transport boundary as well as at request entry so it cannot run an
          // old product request through the adapter bound during that delay.
          this.assertRequestSurface(req, traceCommand);
          if (req.type === 'tauri') {
            transportTiming = {};
            return this.executeTauriCommand(
              req.config as TauriCommandConfig,
              transportTiming,
              controller.signal,
            );
          } else {
            return this.executeHttpRequest(req.config as HttpRequestConfig, controller.signal);
          }
        });
        this.assertRequestSurface(request, traceCommand);

        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        maxConcurrentRequests = this.activeRequestPressure.get(request.id)?.maxConcurrentRequests ?? this.activeRequests.size;
        this.activeRequests.delete(request.id);
        this.activeRequestPressure.delete(request.id);
        activeRequestsAtEnd = this.activeRequests.size;

        
        const durationMs = elapsedMs(startedAt);
        const responseEstimateStartedAt = estimatePayloadBytes ? nowMs() : undefined;
        const responseBytes = estimatePayloadBytes
          ? estimateJsonBytes(
              response.data,
              responseEstimateMaxBytes(traceCommand)
            )
          : undefined;
        const responseEstimateDurationMs = responseEstimateStartedAt !== undefined
          ? elapsedMs(responseEstimateStartedAt)
          : undefined;
        const payloadEstimateDurationMs = requestPayloadEstimateDurationMs !== undefined ||
          responseEstimateDurationMs !== undefined
            ? (requestPayloadEstimateDurationMs ?? 0) + (responseEstimateDurationMs ?? 0)
            : undefined;
        startupTrace.recordApiCall({
          type: request.type,
          command: traceCommand,
          target: traceTarget,
          durationMs,
          startedAtMs: startedAt,
          endedAtMs: startedAt + durationMs,
          outcome: 'success',
          requestBytes,
          responseBytes,
          payloadEstimateDurationMs,
          requestPayloadEstimateDurationMs,
          responsePayloadEstimateDurationMs: responseEstimateDurationMs,
          adapterInitDurationMs: transportTiming?.adapterInitDurationMs,
          transportDurationMs: transportTiming?.transportDurationMs,
          invokeDurationMs: transportTiming?.invokeDurationMs,
          activeRequestsAtStart,
          activeRequestsAtEnd,
          maxConcurrentRequests,
          remote,
        });
        this.recordResponseTime(durationMs);
        this.updateStats({ successfulRequests: this.stats.successfulRequests + 1 });


        if (this.config.enableLogging) {
          log.debug('Request completed', {
            type: request.type,
            durationMs,
            config: sanitizeForLog(request.config)
          });
        }

        return response.data;
      } finally {
        maxConcurrentRequests = maxConcurrentRequests ||
          this.activeRequestPressure.get(request.id)?.maxConcurrentRequests ||
          this.activeRequests.size;
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        this.activeRequests.delete(request.id);
        this.activeRequestPressure.delete(request.id);
        activeRequestsAtEnd = this.activeRequests.size;
      }
    } catch (error) {
      const optionalConfigNotFound = isOptionalConfigNotFound(request, error);
      this.updateStats(optionalConfigNotFound
        ? { successfulRequests: this.stats.successfulRequests + 1 }
        : { failedRequests: this.stats.failedRequests + 1 });
      startupTrace.recordApiCall({
        type: request.type,
        command: traceCommand,
        target: traceTarget,
        durationMs: elapsedMs(startedAt),
        startedAtMs: startedAt,
        endedAtMs: nowMs(),
        outcome: optionalConfigNotFound ? 'success' : 'failure',
        requestBytes,
        payloadEstimateDurationMs: requestPayloadEstimateDurationMs,
        requestPayloadEstimateDurationMs,
        adapterInitDurationMs: transportTiming?.adapterInitDurationMs,
        transportDurationMs: transportTiming?.transportDurationMs,
        invokeDurationMs: transportTiming?.invokeDurationMs,
        activeRequestsAtStart,
        activeRequestsAtEnd,
        maxConcurrentRequests,
        remote,
      });

      // A device activation ended. This is typed control flow: wrapping it as
      // COMMAND_FAILED would turn a normal switch into a product error, and
      // retrying could send the old request through the newly bound adapter.
      if (isSurfaceChangedError(error)) {
        throw error;
      }

      
      if (!optionalConfigNotFound && request.retryCount < (request.config.retries || this.config.retries)) {
        const delay = (request.config.retryDelay || this.config.retryDelay) * Math.pow(2, request.retryCount);
        
        
        if (this.config.enableLogging) {
          log.warn('Retrying request', { 
            requestId: request.id, 
            attempt: request.retryCount + 1, 
            maxRetries: request.config.retries || this.config.retries,
            delay 
          });
        }

        await new Promise(resolve => setTimeout(resolve, delay));
        request.retryCount++;
        return this.executeRequest<T>(request);
      }


      if (this.config.enableLogging && !optionalConfigNotFound) {
        log.error('Request failed after retries', {
          requestId: request.id,
          retryCount: request.retryCount,
          config: sanitizeForLog(request.config),
          error: sanitizeErrorForLog(error)
        });
      }

      throw this.normalizeError(error as Error);
    }
  }

  private async executeTauriCommand(
    config: TauriCommandConfig,
    transportTiming: TransportRequestTiming | undefined,
    signal: AbortSignal,
  ): Promise<ApiResponse> {
    try {
      
      const data = await waitForTransport(
        this.adapter.request(config.command, config.args || {}, transportTiming),
        signal,
      );
      
      return {
        success: true,
        data,
        timestamp: new Date()
      };
    } catch (error) {
      if (isSurfaceChangedError(error)) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw this.createApiError('REQUEST_TIMEOUT', 'Request timeout', error);
      }
      const errorMessage = transportErrorMessage(error);
      
      
      const isExpectedError = errorMessage.includes('not found') || 
                             errorMessage.includes('Config path') ||
                             errorMessage.includes('Configuration error');
      const optionalConfigNotFound = isOptionalConfigNotFoundCommand(config, error);
      
      
      if (this.config.enableLogging) {
        if (isExpectedError && !optionalConfigNotFound) {
          log.debug('Command returned expected result', {
            command: config.command,
            message: sanitizeTextForLog(errorMessage)
          });
        } else if (!isExpectedError) {
          log.error('Command failed', {
            command: config.command,
            args: sanitizeForLog(config.args),
            error: sanitizeTextForLog(errorMessage),
            rawError: sanitizeErrorForLog(error)
          });
        }
      }
      
      throw this.createApiError('COMMAND_FAILED', errorMessage, error);
    }
  }


  private async executeHttpRequest(config: HttpRequestConfig, signal: AbortSignal): Promise<ApiResponse> {
    try {
      const url = new URL(config.url, this.config.baseUrl);
      
      
      if (config.params) {
        Object.entries(config.params).forEach(([key, value]) => {
          url.searchParams.append(key, String(value));
        });
      }

      const requestInit: RequestInit = {
        method: config.method,
        headers: {
          'Content-Type': 'application/json',
          ...config.headers
        },
        signal
      };

      if (config.data && config.method !== 'GET') {
        requestInit.body = JSON.stringify(config.data);
      }

      const response = await fetch(url.toString(), requestInit);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        success: true,
        data,
        timestamp: new Date()
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw this.createApiError('REQUEST_TIMEOUT', 'Request timeout', error);
      }
      throw this.createApiError('HTTP_REQUEST_FAILED', (error as Error).message, error);
    }
  }

  private async applyMiddleware(
    request: ApiRequest,
    executor: (request: ApiRequest) => Promise<ApiResponse>
  ): Promise<ApiResponse> {
    if (this.config.middleware.length === 0) {
      return executor(request);
    }

    let index = 0;
    const next = async (req: ApiRequest): Promise<ApiResponse> => {
      if (index >= this.config.middleware.length) {
        return executor(req);
      }

      const middleware = this.config.middleware[index++];
      return middleware(req, next);
    };

    return next(request);
  }

  private normalizeError(error: Error): ApiError {
    if (this.isApiError(error)) {
      return error as unknown as ApiError;
    }

    return this.createApiError('UNKNOWN_ERROR', error.message, error);
  }

  private createApiError(code: string, message: string, originalError?: any): ApiError {
    const apiError = new Error(message) as unknown as ApiError;
    apiError.code = code;
    apiError.message = message;
    
    if (originalError) {
      apiError.details = {
        originalError: apiErrorCause(originalError),
        stack: originalError.stack
      };
    }

    return apiError;
  }

  private isApiError(error: any): boolean {
    return error && typeof error.code === 'string';
  }

  private recordResponseTime(time: number): void {
    this.responseTimes.push(time);
    
    
    if (this.responseTimes.length > 100) {
      this.responseTimes = this.responseTimes.slice(-100);
    }

    
    const average = this.responseTimes.reduce((sum, t) => sum + t, 0) / this.responseTimes.length;
    this.updateStats({ averageResponseTime: Math.round(average) });
  }

  private updateStats(updates: Partial<ApiStats>): void {
    this.stats = { ...this.stats, ...updates };
    
  }
}


export const apiClient = new ApiClient();


export const api = {
  
  invoke: <T = any>(command: string, args?: any, config?: ApiRequestConfig): Promise<T> =>
    apiClient.invoke<T>(command, args, config),

  
  listen: <T = any>(event: string, callback: (data: T) => void): (() => void) =>
    apiClient.listen<T>(event, callback),

  
  get: <T = any>(url: string, config?: Partial<HttpRequestConfig>): Promise<T> =>
    apiClient.request<T>({ method: 'GET', url, ...config }),

  post: <T = any>(url: string, data?: any, config?: Partial<HttpRequestConfig>): Promise<T> =>
    apiClient.request<T>({ method: 'POST', url, data, ...config }),

  put: <T = any>(url: string, data?: any, config?: Partial<HttpRequestConfig>): Promise<T> =>
    apiClient.request<T>({ method: 'PUT', url, data, ...config }),

  delete: <T = any>(url: string, config?: Partial<HttpRequestConfig>): Promise<T> =>
    apiClient.request<T>({ method: 'DELETE', url, ...config }),

  patch: <T = any>(url: string, data?: any, config?: Partial<HttpRequestConfig>): Promise<T> =>
    apiClient.request<T>({ method: 'PATCH', url, data, ...config }),

  
  cancelAll: (): void => apiClient.cancelAll(),

  
  healthCheck: (): Promise<boolean> => apiClient.healthCheck(),

  
  getStats: (): ApiStats => apiClient.getStats(),

  waitForListenerRegistrations: (): Promise<void> =>
    apiClient.waitForListenerRegistrations(),
  
  
  getAdapter: (): ITransportAdapter => apiClient.getAdapter(),

  reattachTransportAdapter: (): void => apiClient.reattachTransportAdapter(),
};


export function createLoggingMiddleware(): ApiMiddleware {
  const middlewareLog = createLogger('ApiMiddleware');
  return async (request: ApiRequest, next: (request: ApiRequest) => Promise<ApiResponse>) => {
    const startedAt = nowMs();
    
    try {
      const response = await next(request);
      const durationMs = elapsedMs(startedAt);
      middlewareLog.debug('Request completed', {
        type: request.type,
        durationMs,
        config: sanitizeForLog(request.config)
      });
      return response;
    } catch (error) {
      const durationMs = elapsedMs(startedAt);
      middlewareLog.error('Request failed', { type: request.type, durationMs, error });
      throw error;
    }
  };
}

export function createRetryMiddleware(maxRetries: number = 3, baseDelay: number = 1000): ApiMiddleware {
  const middlewareLog = createLogger('ApiRetryMiddleware');
  return async (request: ApiRequest, next: (request: ApiRequest) => Promise<ApiResponse>) => {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next(request);
      } catch (error) {
        // Retrying inside middleware bypasses executeRequest's outer surface
        // assertion. Let the typed cancellation escape immediately so an old
        // request cannot be replayed through the adapter bound for a new device.
        if (isSurfaceChangedError(error)) {
          throw error;
        }
        lastError = error as Error;
        
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          middlewareLog.warn('Retrying request', { attempt: attempt + 1, maxRetries, delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError!;
  };
}
