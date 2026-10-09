import {
  ChatMessage,
  ImageAttachment,
  RemoteModelCatalog,
  RemoteModelConfig,
  RemoteSession
} from '../model/RemoteModels';
import { RemoteI18n } from '../i18n/RemoteI18n';
import { remoteSessionIdentity } from './RemoteSessionIdentity';
import { TranscriptIntegrityPolicy } from './TranscriptIntegrityPolicy';

export class RemoteUiState {
  static canUseRemote(connectionState: string): boolean {
    return connectionState === 'connected' ||
      connectionState === 'reconnecting' ||
      connectionState === 'pairing';
  }

  static desktopNameFromRemoteUrl(value: string): string {
    return RemoteUiState.queryValueFromRemoteUrl(value, 'dn');
  }

  static desktopIdFromRemoteUrl(value: string): string {
    return RemoteUiState.queryValueFromRemoteUrl(value, 'did');
  }

  private static queryValueFromRemoteUrl(value: string, key: string): string {
    const marker = `${key}=`;
    const index = value.indexOf(marker);
    if (index < 0) {
      return '';
    }
    const tail = value.slice(index + marker.length);
    const end = tail.indexOf('&');
    const encoded = end >= 0 ? tail.slice(0, end) : tail;
    try {
      return decodeURIComponent(encoded.replace(/\+/g, ' '));
    } catch (_err) {
      return encoded;
    }
  }

  static normalizeRemoteFilePath(path: string): string {
    return path
      .replace(/^computer:\/\//, '')
      .replace(/^file:\/\//, '')
      .trim();
  }

  static formatBytes(value: number): string {
    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${Math.round(value / 1024)} KB`;
    }
    return `${Math.round(value / 1024 / 1024)} MB`;
  }

  static mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    const merged = current.slice();
    incoming.forEach((item: ChatMessage) => {
      const existingIndex = merged.findIndex((existing: ChatMessage) => {
        return existing.id === item.id;
      });
      if (existingIndex >= 0) {
        merged[existingIndex] = RemoteUiState.mergeMessageSnapshot(merged[existingIndex], item);
      } else {
        merged.push(item);
      }
    });
    return merged;
  }

  static mergeRemoteWithLocalOptimistic(remoteMessages: ChatMessage[], currentMessages: ChatMessage[]): ChatMessage[] {
    const merged = remoteMessages.slice();
    const acknowledgedRemoteIndexes = new Set<number>();
    currentMessages.forEach((item: ChatMessage) => {
      if (!RemoteUiState.isLocalOptimisticMessage(item)) {
        return;
      }
      const acknowledgedIndex = merged.findIndex((remote: ChatMessage, index: number) => {
        return !acknowledgedRemoteIndexes.has(index) && RemoteUiState.isOptimisticDuplicate(item, remote);
      });
      if (acknowledgedIndex >= 0) {
        acknowledgedRemoteIndexes.add(acknowledgedIndex);
      } else {
        merged.push(item);
      }
    });
    return merged;
  }

  static mergeSessions(current: RemoteSession[], incoming: RemoteSession[]): RemoteSession[] {
    const seen = new Set<string>();
    current.forEach((item: RemoteSession) => {
      seen.add(remoteSessionIdentity(item));
    });
    const merged = current.slice();
    incoming.forEach((item: RemoteSession) => {
      const key = remoteSessionIdentity(item);
      if (!seen.has(key)) {
        merged.push(item);
        seen.add(key);
      }
    });
    return merged;
  }

  static updateSessionTitle(items: RemoteSession[], sessionId: string, title: string): RemoteSession[] {
    return items.map((item: RemoteSession) => {
      if (item.id !== sessionId) {
        return item;
      }
      const updated: RemoteSession = {
        id: item.id,
        title,
        agentType: item.agentType,
        status: item.status,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt,
        messageCount: item.messageCount,
        workspacePath: item.workspacePath,
        workspaceName: item.workspaceName,
        pinned: item.pinned,
        titleGenerated: item.titleGenerated,
        deviceId: item.deviceId
      };
      return updated;
    });
  }

  static markMessageFailed(messages: ChatMessage[], messageId: string): ChatMessage[] {
    return messages.map((item: ChatMessage) => {
      if (item.id !== messageId) {
        return item;
      }
      const failed: ChatMessage = {
        id: item.id,
        turnId: item.turnId,
        role: item.role,
        text: item.text,
        status: 'failed',
        detail: item.detail,
        error: item.error,
        timestamp: item.timestamp,
        thinking: item.thinking,
        tools: item.tools,
        items: item.items,
        images: item.images
      };
      return failed;
    });
  }

  static localUserMessage(text: string, images?: ImageAttachment[], turnId?: string): ChatMessage {
    return {
      id: `optimistic-user-${Date.now()}`,
      turnId,
      role: 'user',
      text,
      status: 'sent',
      timestamp: new Date().toISOString(),
      images: images || []
    };
  }

  static emptyActiveTurn(): ChatMessage {
    return {
      id: '',
      role: 'assistant',
      text: '',
      status: '',
      detail: ''
    };
  }

  static emptyModelCatalog(): RemoteModelCatalog {
    return {
      version: 0,
      models: [],
      default_models: {}
    };
  }

  static selectedModelIdForCatalog(catalog: RemoteModelCatalog, currentSelectedModelId: string): string {
    const sessionModelId = catalog.session_model_id || '';
    if (sessionModelId.length > 0) {
      return sessionModelId;
    }
    if (currentSelectedModelId.length > 0) {
      // A semantic selector stays semantic while the host can still resolve it,
      // so the composer keeps showing the role that will actually run. The
      // canonical value is returned, not the padded one that came in.
      const semanticModelId = RemoteUiState.resolveSemanticModelId(catalog, currentSelectedModelId);
      if (semanticModelId.length > 0) {
        return semanticModelId;
      }
      const exists = catalog.models.some((model: RemoteModelConfig) => {
        return model.id === currentSelectedModelId && model.enabled;
      });
      if (exists) {
        return currentSelectedModelId;
      }
    }
    return catalog.default_models.primary || catalog.default_models.fast || currentSelectedModelId;
  }

  /**
   * Keeps a semantic selector (`primary` / `fast`) only while it resolves to an
   * enabled model, mirroring the host's own selection semantics including the
   * fast-to-primary fallback. Returns an empty string for anything else.
   *
   * This repeats `ConversationModelPresentationPolicy.resolveModel` because the
   * service layer may not import the page policy layer. Both sides trim, so a
   * padded selector or default resolves the same way in either one.
   */
  private static resolveSemanticModelId(catalog: RemoteModelCatalog, modelId: string): string {
    const value = (modelId || '').trim();
    const primary = (catalog.default_models.primary || '').trim();
    if (value === 'primary') {
      return RemoteUiState.hasEnabledModel(catalog, primary) ? value : '';
    }
    if (value === 'fast') {
      const fast = (catalog.default_models.fast || '').trim();
      if (RemoteUiState.hasEnabledModel(catalog, fast)) {
        return value;
      }
      return RemoteUiState.hasEnabledModel(catalog, primary) ? value : '';
    }
    return '';
  }

  private static hasEnabledModel(catalog: RemoteModelCatalog, modelId: string): boolean {
    const value = (modelId || '').trim();
    if (value.length === 0) {
      return false;
    }
    return catalog.models.some((model: RemoteModelConfig) => model.id === value && model.enabled);
  }

  static seedMessage(title: string): ChatMessage {
    return {
      id: `system-${Date.now()}`,
      role: 'assistant',
      text: RemoteI18n.f('ui.seedConnected', title),
      status: 'ready'
    };
  }

  private static isLocalOptimisticMessage(item: ChatMessage): boolean {
    return item.role === 'user' && item.id.indexOf('optimistic-user-') === 0;
  }

  private static isOptimisticDuplicate(local: ChatMessage, remote: ChatMessage): boolean {
    if (!RemoteUiState.isLocalOptimisticMessage(local) || local.role !== remote.role) {
      return false;
    }
    const localTurnId = (local.turnId || '').trim();
    const remoteTurnId = (remote.turnId || '').trim();
    if (localTurnId.length > 0 && remoteTurnId.length > 0) {
      return localTurnId === remoteTurnId;
    }
    return local.text.trim() === remote.text.trim() &&
      local.text.trim().length > 0 &&
      RemoteUiState.imageSignature(local.images || []) === RemoteUiState.imageSignature(remote.images || []);
  }

  private static imageSignature(images: ImageAttachment[]): string {
    return images.map((image: ImageAttachment) => {
      return `${image.name || ''}:${image.data_url || ''}`;
    }).sort().join('|');
  }

  private static mergeMessageSnapshot(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
    const hasIncomingText = (incoming.text || '').trim().length > 0;
    const incomingThinking = (incoming.thinking || '').trim();
    const incomingTools = incoming.tools && incoming.tools.length > 0 ? incoming.tools : undefined;
    const incomingItems = TranscriptIntegrityPolicy.hasRenderableItems(incoming.items) ? incoming.items : undefined;
    const incomingImages = incoming.images && incoming.images.length > 0 ? incoming.images : undefined;
    return {
      id: incoming.id,
      turnId: incoming.turnId || previous.turnId,
      role: incoming.role || previous.role,
      text: hasIncomingText ? incoming.text : previous.text,
      status: incoming.status || previous.status,
      detail: incoming.detail || previous.detail,
      error: incoming.error || previous.error,
      timestamp: incoming.timestamp || previous.timestamp,
      // Final text without a thinking field still clears streamed thinking.
      // An empty stub must not wipe a body the previous snapshot already had.
      thinking: incomingThinking.length > 0
        ? incoming.thinking
        : (hasIncomingText ? incoming.thinking : previous.thinking),
      tools: incomingTools !== undefined ? incomingTools : previous.tools,
      items: incomingItems !== undefined ? incomingItems : previous.items,
      images: incomingImages !== undefined ? incomingImages : previous.images,
      renderVersion: incoming.renderVersion !== undefined ? incoming.renderVersion : previous.renderVersion
    };
  }
}
