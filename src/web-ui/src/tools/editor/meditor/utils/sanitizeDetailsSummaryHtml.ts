const linkProtocols = new Set([
  'http:', 'https:', 'mailto:', 'tel:', 'sms:', 'xmpp:', 'irc:', 'ircs:',
  'file:', 'computer:', 'tab:', 'visualization:',
]);
const imageProtocols = new Set(['http:', 'https:', 'file:', 'asset:', 'tauri:', 'blob:', 'data:']);

function isSafePreviewUrl(value: string, tagName: string): boolean {
  try {
    // URL parsing applies the browser's control-character normalization and
    // resolves relative paths without depending on the local/remote host URL.
    const url = new URL(value, 'https://markdown-preview.invalid/');
    return (tagName === 'IMG' ? imageProtocols : linkProtocols).has(url.protocol);
  } catch {
    return false;
  }
}

export function sanitizeDetailsSummaryHtml(summaryHtml: string): string {
  if (typeof document === 'undefined') {
    // Never hand unsanitized markup to the HTML sink when a DOM is unavailable.
    return summaryHtml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const template = document.createElement('template');
  template.innerHTML = summaryHtml;
  const allowedTags = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'BR', 'IMG']);

  const sanitizeNode = (node: Element) => {
    // SVG/MathML are not HTMLElements, but can contain active content. Drop the
    // whole foreign subtree rather than letting it bypass the HTML allowlist.
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
      node.remove();
      return;
    }

    // Sanitize descendants before unwrapping an unsupported parent. Moving
    // them first would skip them in the parent's snapshot of child nodes.
    Array.from(node.children).forEach(sanitizeNode);

    if (!allowedTags.has(node.tagName)) {
      while (node.firstChild) {
        node.before(node.firstChild);
      }
      node.remove();
      return;
    }

    const allowedAttributes = node.tagName === 'A'
      ? ['href', 'title']
      : node.tagName === 'IMG'
        ? ['src', 'alt', 'title', 'width', 'height', 'align']
        : ['class'];

    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (!allowedAttributes.includes(name)
        || ((name === 'href' || name === 'src') && !isSafePreviewUrl(attr.value, node.tagName))) {
        node.removeAttribute(attr.name);
      }
    });
  };

  Array.from(template.content.children).forEach(sanitizeNode);
  return template.innerHTML;
}
