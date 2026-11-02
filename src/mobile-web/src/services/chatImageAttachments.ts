/** Model-ready image attachment projected from a remote transcript message. */
export interface RemoteImageContext {
  id: string;
  data_url: string;
  mime_type: string;
  metadata: { name: string; source: string };
}

/** Attachment restored into the mobile composer. */
export interface PendingChatImage {
  name: string;
  dataUrl: string;
}

/**
 * Accept only canonical base64 image data URLs. The host may replay transcript
 * data that was edited or truncated, so padding bits and quantum length are
 * checked as well as the alphabet (RFC 4648 section 3.5) before the payload is
 * forwarded to the model or decoded by the browser.
 */
export function normalizeValidImageDataUrl(
  url: unknown,
): { trimmedUrl: string; mimeType: string } | null {
  if (typeof url !== 'string') return null;
  const trimmedUrl = url.trim();
  const match = trimmedUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const base64Data = match[2];
  const isValid =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{4})$/.test(
      base64Data,
    );
  if (!isValid) return null;
  return { trimmedUrl, mimeType };
}

/** Project valid transcript images into `send_message` image contexts. */
export function extractValidImageContexts(
  images: unknown,
  prefix: string,
): RemoteImageContext[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const valid: { data_url: string; mime_type: string; name: string }[] = [];
  for (const img of images) {
    try {
      if (img && typeof img === 'object') {
        const normalized = normalizeValidImageDataUrl(img.data_url);
        if (normalized) {
          valid.push({
            data_url: normalized.trimmedUrl,
            mime_type: normalized.mimeType,
            name: typeof img.name === 'string' && img.name ? img.name : 'image',
          });
        }
      }
    } catch {
      // Ignore corrupted attachment items.
    }
  }
  if (valid.length === 0) return undefined;
  return valid.map((item, idx) => ({
    id: `${prefix}_${Date.now()}_${idx}`,
    data_url: item.data_url,
    mime_type: item.mime_type,
    metadata: { name: item.name, source: 'remote' },
  }));
}

/** Project valid transcript images into composer attachments. */
export function extractValidPendingImages(images: unknown): PendingChatImage[] {
  if (!Array.isArray(images) || images.length === 0) return [];
  const result: PendingChatImage[] = [];
  for (const img of images) {
    try {
      if (img && typeof img === 'object') {
        const normalized = normalizeValidImageDataUrl(img.data_url);
        if (normalized) {
          result.push({
            name: typeof img.name === 'string' && img.name ? img.name : 'image',
            dataUrl: normalized.trimmedUrl,
          });
        }
      }
    } catch {
      // Ignore corrupted attachment items.
    }
  }
  return result;
}
