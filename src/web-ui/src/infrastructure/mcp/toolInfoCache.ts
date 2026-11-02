import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { ToolInfo } from '@/shared/types/agent-api';

/** Tool descriptions come from the rendered device's MCP servers. */
const toolInfoCache = new Map<string, Promise<ToolInfo | null>>();

export function getCachedToolInfo(toolName: string): Promise<ToolInfo | null> {
  const key = getActiveSurfaceScope().key(toolName);
  const cached = toolInfoCache.get(key);
  if (cached) {
    return cached;
  }

  const request = toolAPI.getToolInfo(toolName).catch((error) => {
    if (toolInfoCache.get(key) === request) {
      toolInfoCache.delete(key);
    }
    throw error;
  });

  toolInfoCache.set(key, request);
  return request;
}

/** Test seam: forgets every cached tool description. */
export function resetToolInfoCache(): void {
  toolInfoCache.clear();
}
