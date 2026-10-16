import type { FlowToolItem } from '../types/flow-chat';
import { importedToolDisplayName, projectImportedToolItem } from './importedToolPresentation';

export const DEFERRED_TOOL_GATEWAY_NAME = 'CallDeferredTool';

export interface EffectiveToolInvocation {
  toolName: string;
  input: unknown;
  isDeferred: boolean;
}

export function effectiveToolInvocation(
  wireToolName: string,
  wireInput: unknown,
): EffectiveToolInvocation {
  if (
    wireToolName !== DEFERRED_TOOL_GATEWAY_NAME
    || wireInput === null
    || typeof wireInput !== 'object'
    || Array.isArray(wireInput)
  ) {
    return { toolName: wireToolName, input: wireInput, isDeferred: false };
  }

  const input = wireInput as Record<string, unknown>;
  if (
    typeof input.tool_name !== 'string'
    || input.tool_name.trim().length === 0
  ) {
    return { toolName: wireToolName, input: wireInput, isDeferred: false };
  }

  const hasArgs = Object.prototype.hasOwnProperty.call(input, 'args');
  if (
    hasArgs
    && (
      input.args === null
      || typeof input.args !== 'object'
      || Array.isArray(input.args)
    )
  ) {
    return { toolName: wireToolName, input: wireInput, isDeferred: false };
  }

  const args = hasArgs ? input.args as Record<string, unknown> : {};
  const overflowEntries = Object.entries(input)
    .filter(([key]) => key !== 'tool_name' && key !== 'args');
  const effectiveInput = overflowEntries.length === 0
    ? args
    : Object.fromEntries([
        ...overflowEntries,
        ...Object.entries(args),
      ]);

  return {
    toolName: input.tool_name,
    input: effectiveInput,
    isDeferred: true,
  };
}

export function getEffectiveToolName(toolItem: Pick<FlowToolItem, 'toolName' | 'toolCall' | 'importedSource'>): string {
  if (toolItem.importedSource) return importedToolDisplayName(toolItem);
  return effectiveToolInvocation(toolItem.toolName, toolItem.toolCall?.input).toolName;
}

export function projectEffectiveToolItem(toolItem: FlowToolItem): FlowToolItem {
  if (toolItem.importedSource) return projectImportedToolItem(toolItem);
  const effective = effectiveToolInvocation(toolItem.toolName, toolItem.toolCall?.input);
  if (!effective.isDeferred) {
    return toolItem;
  }

  return {
    ...toolItem,
    toolName: effective.toolName,
    toolCall: {
      ...toolItem.toolCall,
      input: effective.input,
    },
  };
}
