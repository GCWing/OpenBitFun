(() => {
  async function trace(image, options = {}, cancelled = () => false) {
    const { width, height, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > 512 || height > 512 || data.length !== width * height * 4) throw new Error('invalidImage');
    const contrast = Number(options.contrast ?? 28), epsilon = Number(options.simplify ?? 1.5);
    const minArea = Number(options.minArea ?? 6), smoothing = Number(options.smoothing ?? .7);
    if (![contrast, epsilon, minArea, smoothing].every(Number.isFinite) || contrast < 1 || contrast > 255
      || epsilon < 0 || epsilon > 8 || minArea < 1 || smoothing < 0 || smoothing > 1) throw new Error('invalidImage');
    const checkpoint = async () => {
      if (cancelled()) throw new Error('cancelled');
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelled()) throw new Error('cancelled');
    };
    await checkpoint();
    const border = [];
    for (let x = 0; x < width; x++) { border.push(x * 4); if (height > 1) border.push(((height - 1) * width + x) * 4); }
    for (let y = 1; y < height - 1; y++) { border.push(y * width * 4); if (width > 1) border.push((y * width + width - 1) * 4); }
    const opaque = border.filter(i => data[i + 3] >= 250);
    let transparentPixels = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 128) { transparentPixels = true; break; }
    const useAlpha = transparentPixels || opaque.length < border.length * .5;
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    const background = [0, 1, 2].map(c => median(opaque.map(i => data[i + c])));
    const count = width * height;
    const mask = new Uint8Array(count);
    let foreground = 0;
    for (let i = 0; i < count; i++) {
      const p = i * 4;
      const difference = Math.max(...background.map((v, c) => Math.abs(data[p + c] - v)));
      if (data[p + 3] >= 128 && (useAlpha || difference >= contrast)) { mask[i] = 1; foreground++; }
      if (i > 0 && i % 65536 === 0) await checkpoint();
    }
    if (!foreground) throw new Error('noForeground');
    const seen = new Uint8Array(count), queue = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      if (!mask[i] || seen[i]) continue;
      let head = 0, tail = 1; queue[0] = i; seen[i] = 1;
      const visit = n => { if (mask[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; } };
      while (head < tail) {
        const n = queue[head++], x = n % width;
        if (x > 0) visit(n - 1); if (x + 1 < width) visit(n + 1);
        if (n >= width) visit(n - width); if (n + width < count) visit(n + width);
        if (head % 65536 === 0) await checkpoint();
      }
      if (tail < minArea) for (let n = 0; n < tail; n++) mask[queue[n]] = 0;
    }
    await checkpoint();
    // Directed pixel-cell boundaries form complete compound paths. At diagonal
    // contacts prefer a right turn, keeping touching components from crossing.
    const edges = [], outgoing = new Map(), stride = width + 1;
    const add = (a, b, direction) => {
      const index = edges.length;
      edges.push({ a, b, direction, used: false });
      if (!outgoing.has(a)) outgoing.set(a, []);
      outgoing.get(a).push(index);
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const n = y * width + x;
      if (!mask[n]) continue;
      const a = y * stride + x, b = a + 1, c = b + stride, d = a + stride;
      if (y === 0 || !mask[n - width]) add(a, b, 0);
      if (x === width - 1 || !mask[n + 1]) add(b, c, 1);
      if (y === height - 1 || !mask[n + width]) add(c, d, 2);
      if (x === 0 || !mask[n - 1]) add(d, a, 3);
    }
    if (edges.length > 160000) throw new Error('tooComplex');
    await checkpoint();
    const contours = [];
    const scale = 24 / Math.max(width, height), dx = (24 - width * scale) / 2, dy = (24 - height * scale) / 2;
    const priority = { 1: 0, 0: 1, 3: 2, 2: 3 };
    let totalNodes = 0;
    for (const first of edges) {
      if (first.used) continue;
      let edge = first;
      const points = [];
      do {
        edge.used = true;
        points.push([edge.a % stride, Math.floor(edge.a / stride)]);
        if (edge.b === first.a) break;
        const candidates = (outgoing.get(edge.b) || []).map(i => edges[i]).filter(e => !e.used);
        candidates.sort((a, b) => priority[(a.direction - edge.direction + 4) % 4] - priority[(b.direction - edge.direction + 4) % 4]);
        if (!candidates.length) throw new Error('traceFailed');
        edge = candidates[0];
      } while (points.length <= edges.length);
      let simple = IconGeometry.simplifyClosed(points, epsilon);
      // A tiny enclosed hole must not disappear merely because simplification
      // would collapse its contour to a line.
      if (simple.length < 3) simple = IconGeometry.simplifyClosed(points, 0);
      const contour = { closed: true, nodes: simple.map(([x, y]) => IconGeometry.point(x * scale + dx, y * scale + dy)) };
      if (smoothing) contour.nodes.forEach((node, i) => {
        const prev = contour.nodes[(i + contour.nodes.length - 1) % contour.nodes.length], next = contour.nodes[(i + 1) % contour.nodes.length];
        const ax = node.x - prev.x, ay = node.y - prev.y, bx = next.x - node.x, by = next.y - node.y;
        const dot = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
        if (dot > .6) IconGeometry.smoothNode(contour, i, smoothing);
      });
      totalNodes += contour.nodes.length;
      if (totalNodes > 12000 || contours.length >= 1024) throw new Error('tooComplex');
      contours.push(contour);
      if (contours.length % 32 === 0) await checkpoint();
    }
    if (!contours.length) throw new Error('noForeground');
    await checkpoint();
    return { shape: IconGeometry.shape(contours, 'Trace', true), nodes: totalNodes, alphaMode: useAlpha };
  }
  globalThis.IconTrace = Object.freeze({ trace });
})();
