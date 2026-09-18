/** Mirrors `FILE_TOOL_GUIDANCE_PREFIX` in file_tool_guidance.rs */
export const FILE_TOOL_GUIDANCE_PREFIX = '[guidance] ';

export function isFileToolGuidanceMessage(message: unknown): boolean {
  return typeof message === 'string' && message.startsWith(FILE_TOOL_GUIDANCE_PREFIX);
}

export function displayFileToolGuidanceMessage(message: unknown): string {
  if (typeof message !== 'string') {
    return '';
  }
  return message.startsWith(FILE_TOOL_GUIDANCE_PREFIX)
    ? message.slice(FILE_TOOL_GUIDANCE_PREFIX.length)
    : message;
}

/** Explicit classification wins over legacy text, including unknown kinds. */
export function isFileToolGuidanceResult(message: unknown, result: unknown): boolean {
  if (result && typeof result === 'object' && 'error_detail' in result) {
    const detail = result.error_detail;
    return Boolean(detail && typeof detail === 'object' && 'kind' in detail && detail.kind === 'guidance');
  }
  return isFileToolGuidanceMessage(message);
}
