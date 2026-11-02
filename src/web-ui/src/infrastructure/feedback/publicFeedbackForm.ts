/** Build the public Feishu questionnaire URL used by the product feedback entry. */

export interface PublicFeedbackContext {
  uid?: string | number | null;
  version?: string | null;
  source?: string | null;
  deviceInfo?: string | null;
}

/** Read and validate the build-time public questionnaire URL. */
export function resolvePublicFeedbackFormUrl(
  rawUrl: string | undefined = import.meta.env.VITE_OPENBITFUN_FEEDBACK_FORM_URL,
): URL | null {
  const value = rawUrl?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return url;
}

/**
 * Add public-form prefill values without putting credentials in the URL.
 * `hide_*` only hides the fields in the form; it is not an authentication boundary.
 */
export function buildPublicFeedbackFormUrl(
  rawUrl: string,
  context: PublicFeedbackContext = {},
): string | null {
  const url = resolvePublicFeedbackFormUrl(rawUrl);
  if (!url) return null;

  const fields: Record<string, string | number | null | undefined> = {
    uid: context.uid,
    source: context.source ?? 'openbitfun',
    harness_version: context.version,
    device_info: context.deviceInfo,
  };
  for (const [name, value] of Object.entries(fields)) {
    url.searchParams.set(`hide_${name}`, '1');
    url.searchParams.delete(`prefill_${name}`);
    if (value !== null && value !== undefined && String(value).length > 0) {
      url.searchParams.set(`prefill_${name}`, String(value));
    }
  }
  return url.href;
}
