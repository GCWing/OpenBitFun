type HtmlNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
};

/** Group adjacent image-only blocks in chat, leaving prose and linked badges intact. */
export function rehypeImageThumbnails({ enabled = false }: { enabled?: boolean } = {}) {
  return (tree: HtmlNode) => {
    if (!enabled) return;

    const standaloneImages = (node: HtmlNode): HtmlNode[] | undefined => {
      if (node.type !== 'element') return;
      if (node.tagName === 'img') return [node];
      if (node.tagName !== 'p') return;
      const images: HtmlNode[] = [];
      for (const child of node.children ?? []) {
        if (child.type === 'text' && !child.value?.trim()) continue;
        if (child.type === 'element' && child.tagName === 'br') continue;
        if (child.type !== 'element' || child.tagName !== 'img') return;
        images.push(child);
      }
      return images.length ? images : undefined;
    };

    const group = (parent: HtmlNode) => {
      if (!parent.children || (parent.type === 'element' && !['div', 'blockquote', 'li', 'td', 'th', 'section', 'article', 'details', 'figure'].includes(parent.tagName ?? ''))) return;
      const children: HtmlNode[] = [];
      let images: HtmlNode[] = [];
      const flush = () => {
        if (!images.length) return;
        for (const image of images) {
          image.properties ??= {};
          const classes = image.properties.className;
          image.properties.className = [...(Array.isArray(classes) ? classes : classes ? [String(classes)] : []), 'markdown-image-thumbnail'];
        }
        children.push({
          type: 'element', tagName: 'div',
          properties: { className: [
            'markdown-image-gallery',
            ...(images.length === 1 ? ['markdown-image-gallery--single'] : []),
            ...([2, 4].includes(images.length) ? ['markdown-image-gallery--paired'] : []),
          ] },
          children: images.map(image => ({
            type: 'element', tagName: 'span', properties: { className: ['markdown-image-tile'] }, children: [image],
          })),
        });
        images = [];
      };
      for (const node of parent.children) {
        const found = standaloneImages(node);
        if (found) { images.push(...found); continue; }
        if (images.length && node.type === 'text' && !node.value?.trim()) continue;
        flush();
        if (node.type === 'element') group(node);
        children.push(node);
      }
      flush();
      parent.children = children;
    };
    group(tree);
  };
}
