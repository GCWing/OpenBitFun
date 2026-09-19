import { createTauriCommandError } from '../errors/TauriCommandError';
import { api } from './ApiClient';
import type {
  ProductControlCapabilityId,
  ProductControlOperationId,
  ProductControlOptionId,
} from '../generated/productControl';

export type ProductControlAction = 'get' | 'configure' | 'execute' | 'open';

export type ProductControlDiscoveryRequest = (
  | { action: 'list'; query?: string }
  | { action: 'search'; query: string }
) & { cursor?: number; limit?: number };

export interface ProductControlDiscoveryPage {
  items: Record<string, unknown>[];
  catalogDigest?: string;
  cursor?: number;
  nextCursor?: number | null;
  totalCount?: number;
}

export interface ProductControlInspectResult {
  catalogDigest: string;
  revision: number;
  currentOptionValues: Record<string, unknown>;
  controlAvailability: {
    status: string;
    adapter: string;
    readBack: boolean;
  };
}

export interface ProductControlOutcome {
  catalogDigest: string;
  capabilityId: string;
  optionId?: string;
  operationId?: string;
  revision: number;
  effectiveValue?: unknown;
  effectiveState?: unknown;
  changedPaths?: string[];
  readBack?: boolean;
}

interface ProductControlInvokeRequest {
  action: ProductControlAction;
  capabilityId: ProductControlCapabilityId;
  itemId?: string;
  optionId?: string;
  operationId?: string;
  value?: unknown;
  arguments?: Record<string, unknown>;
}

/**
 * Typed GUI adapter for the native ProductControl executor. Components must
 * use stable capability/option/operation IDs, never config paths or arbitrary
 * Tauri command names.
 */
export class ProductControlAPI {
  private async invoke<T>(request: ProductControlInvokeRequest | ProductControlDiscoveryRequest): Promise<T> {
    try {
      return await api.invoke<T>('product_control_invoke', { request });
    } catch (error) {
      throw createTauriCommandError('product_control_invoke', error, request);
    }
  }

  async discover(request: ProductControlDiscoveryRequest): Promise<ProductControlDiscoveryPage> {
    return this.invoke(request);
  }

  async get<C extends ProductControlCapabilityId>(
    capabilityId: C,
  ): Promise<ProductControlInspectResult> {
    return this.invoke({ action: 'get', capabilityId });
  }

  async configure<C extends ProductControlCapabilityId>(
    capabilityId: C,
    optionId: ProductControlOptionId<C>,
    value: unknown,
  ): Promise<ProductControlOutcome> {
    return this.invoke({ action: 'configure', capabilityId, optionId, value });
  }

  async execute<C extends ProductControlCapabilityId>(
    capabilityId: C,
    operationId: ProductControlOperationId<C>,
    args?: Record<string, unknown>,
  ): Promise<ProductControlOutcome> {
    return this.invoke({
      action: 'execute',
      capabilityId,
      operationId,
      ...(args ? { arguments: args } : {}),
    });
  }

  async open<C extends ProductControlCapabilityId>(
    capabilityId: C,
    itemId?: string,
  ): Promise<ProductControlOutcome> {
    return this.invoke({
      action: 'open',
      capabilityId,
      ...(itemId ? { itemId } : {}),
    });
  }
}

export const productControlAPI = new ProductControlAPI();
