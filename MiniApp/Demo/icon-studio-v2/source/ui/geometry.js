(() => {
  const G = {};
  const copy = value => JSON.parse(JSON.stringify(value));
  const point = (x, y) => ({ x, y, in: null, out: null });
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const xy = n => [n.x, n.y];
  const rounded = n => Number(n.toFixed(3));
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  function pathData(shape) {
    return shape.contours.map(contour => {
      const nodes = contour.nodes;
      if (!nodes.length) return '';
      let d = `M${rounded(nodes[0].x)} ${rounded(nodes[0].y)}`;
      const count = contour.closed ? nodes.length : nodes.length - 1;
      for (let i = 0; i < count; i++) {
        const a = nodes[i], b = nodes[(i + 1) % nodes.length];
        if (a.out || b.in) {
          const c1 = a.out || xy(a), c2 = b.in || xy(b);
          d += `C${c1.map(rounded).join(' ')} ${c2.map(rounded).join(' ')} ${rounded(b.x)} ${rounded(b.y)}`;
        } else if (i + 1 < nodes.length) d += `L${rounded(b.x)} ${rounded(b.y)}`;
      }
      return d + (contour.closed ? 'Z' : '');
    }).join('');
  }
  function shapeMarkup(shape) {
    return `<path d="${pathData(shape)}" fill="${shape.fill ? 'currentColor' : 'none'}" fill-rule="evenodd" stroke="${shape.stroke ? 'currentColor' : 'none'}" stroke-width="${rounded(shape.width)}" stroke-linecap="${shape.cap}" stroke-linejoin="${shape.join}" opacity="${rounded(shape.opacity)}"/>`;
  }
  function exportSVG(doc, size = 24) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${escape(doc.name)}">\n${doc.shapes.filter(s => s.visible).map(shapeMarkup).join('\n')}\n</svg>`;
  }
  function bounds(shape) {
    const points = shape.contours.flatMap(c => c.nodes.flatMap(n => [xy(n), ...(n.in ? [n.in] : []), ...(n.out ? [n.out] : [])]));
    if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  function transform(shape, sx, sy, dx, dy, origin = [0, 0]) {
    for (const contour of shape.contours) for (const n of contour.nodes) {
      n.x = origin[0] + (n.x - origin[0]) * sx + dx;
      n.y = origin[1] + (n.y - origin[1]) * sy + dy;
      for (const key of ['in', 'out']) if (n[key]) {
        n[key] = [origin[0] + (n[key][0] - origin[0]) * sx + dx, origin[1] + (n[key][1] - origin[1]) * sy + dy];
      }
    }
  }
  function moveNode(node, x, y) {
    const dx = x - node.x, dy = y - node.y;
    if (node.in) node.in = [node.in[0] + dx, node.in[1] + dy];
    if (node.out) node.out = [node.out[0] + dx, node.out[1] + dy];
    node.x = x; node.y = y;
  }
  function smoothNode(contour, index, amount = 1) {
    const nodes = contour.nodes;
    const node = nodes[index];
    if ((!contour.closed && (index === 0 || index === nodes.length - 1)) || nodes.length < 3) return;
    const prev = nodes[(index + nodes.length - 1) % nodes.length], next = nodes[(index + 1) % nodes.length];
    const length = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    const radius = Math.min(Math.hypot(node.x - prev.x, node.y - prev.y), Math.hypot(next.x - node.x, next.y - node.y)) * .3 * amount;
    const dx = (next.x - prev.x) / length * radius, dy = (next.y - prev.y) / length * radius;
    node.in = [node.x - dx, node.y - dy]; node.out = [node.x + dx, node.y + dy];
  }
  function splitSegment(contour, index, t = .5) {
    const a = contour.nodes[index], b = contour.nodes[(index + 1) % contour.nodes.length];
    if (!b || !contour.closed && index === contour.nodes.length - 1) return false;
    let node;
    if (a.out || b.in) {
      const p = xy(a), q = a.out || p, r = b.in || xy(b), s = xy(b);
      const pq = mix(p, q, t), qr = mix(q, r, t), rs = mix(r, s, t);
      const pqr = mix(pq, qr, t), qrs = mix(qr, rs, t), at = mix(pqr, qrs, t);
      a.out = pq; b.in = rs;
      node = { x: at[0], y: at[1], in: pqr, out: qrs };
    } else { const at = mix(xy(a), xy(b), t); node = point(...at); }
    contour.nodes.splice(index + 1, 0, node);
    return true;
  }
  function evaluate(a, b, t) {
    if (!a.out && !b.in) return mix(xy(a), xy(b), t);
    const p = xy(a), q = a.out || p, r = b.in || xy(b), s = xy(b);
    return mix(mix(mix(p, q, t), mix(q, r, t), t), mix(mix(q, r, t), mix(r, s, t), t), t);
  }
  function nearestSegment(shape, x, y) {
    let best = null;
    shape.contours.forEach((c, ci) => {
      const count = c.closed ? c.nodes.length : c.nodes.length - 1;
      for (let i = 0; i < count; i++) {
        const a = c.nodes[i], b = c.nodes[(i + 1) % c.nodes.length];
        if (!a.out && !b.in) {
          const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
          const t = length ? Math.max(.001, Math.min(.999, ((x - a.x) * dx + (y - a.y) * dy) / length)) : .5;
          const at = mix(xy(a), xy(b), t), distance = Math.hypot(at[0] - x, at[1] - y);
          if (!best || distance < best.distance) best = { contour: ci, index: i, t, distance };
          continue;
        }
        for (let k = 1; k < 32; k++) {
        const t = k / 32, at = evaluate(c.nodes[i], c.nodes[(i + 1) % c.nodes.length], t);
        const distance = Math.hypot(at[0] - x, at[1] - y);
        if (!best || distance < best.distance) best = { contour: ci, index: i, t, distance };
        }
      }
    });
    return best;
  }
  function shape(contours, name = 'Path', filled = false) {
    return { id: '', name, visible: true, fill: filled, stroke: !filled, width: 2, cap: 'round', join: 'round', opacity: 1, contours };
  }
  function primitive(type, a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    let nodes;
    if (type === 'line') nodes = [point(a.x, a.y), point(b.x, b.y)];
    else if (type === 'rect') nodes = [point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)];
    else {
      const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, k = .5522847498;
      nodes = [
        { x: cx, y, in: [cx - rx * k, y], out: [cx + rx * k, y] },
        { x: x + w, y: cy, in: [x + w, cy - ry * k], out: [x + w, cy + ry * k] },
        { x: cx, y: y + h, in: [cx + rx * k, y + h], out: [cx - rx * k, y + h] },
        { x, y: cy, in: [x, cy + ry * k], out: [x, cy - ry * k] },
      ];
    }
    return shape([{ closed: type !== 'line', nodes }], type);
  }
  function simplify(points, epsilon) {
    if (points.length <= 2) return points.map(p => [...p]);
    const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
    const work = [[0, points.length - 1]];
    while (work.length) {
      const [first, last] = work.pop(), a = points[first], b = points[last];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
      let max = epsilon * epsilon, index = -1;
      for (let i = first + 1; i < last; i++) {
        const p = points[i], t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
        const distance = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
        if (distance > max) { max = distance; index = i; }
      }
      if (index >= 0) { keep[index] = 1; work.push([first, index], [index, last]); }
    }
    return points.filter((_, i) => keep[i]).map(p => [...p]);
  }
  function simplifyClosed(points, epsilon) {
    if (points.length < 4) return points;
    let far = 1, distance = 0;
    for (let i = 1; i < points.length; i++) {
      const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
      if (d > distance) { far = i; distance = d; }
    }
    return [...simplify(points.slice(0, far + 1), epsilon).slice(0, -1),
      ...simplify([...points.slice(far), points[0]], epsilon).slice(0, -1)];
  }
  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1 || !Array.isArray(raw.shapes)
      || raw.shapes.length > 512) throw new Error('invalidProject');
    let total = 0;
    const finite = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 10000;
    const handle = value => value == null ? null : Array.isArray(value) && value.length === 2 && value.every(finite) ? [...value] : (() => { throw new Error('invalidProject'); })();
    const ids = new Set();
    const shapes = raw.shapes.map((s, i) => {
      if (!s || !Array.isArray(s.contours) || !s.contours.length || s.contours.length > 1024) throw new Error('invalidProject');
      const contours = s.contours.map(c => {
        if (!c || !Array.isArray(c.nodes) || c.nodes.length < 2 || c.closed && c.nodes.length < 3) throw new Error('invalidProject');
        total += c.nodes.length;
        if (total > 20000) throw new Error('invalidProject');
        return { closed: Boolean(c.closed), nodes: c.nodes.map(n => {
          if (!n || !finite(n.x) || !finite(n.y)) throw new Error('invalidProject');
          return { x: n.x, y: n.y, in: handle(n.in), out: handle(n.out) };
        }) };
      });
      const id = typeof s.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s.id) ? s.id : `shape-${i}`;
      if (ids.has(id)) throw new Error('invalidProject'); ids.add(id);
      return { ...shape(contours), id, name: String(s.name || 'Path').slice(0, 80), visible: s.visible !== false,
        fill: Boolean(s.fill), stroke: s.stroke !== false, width: finite(s.width) ? Math.max(.1, Math.min(8, s.width)) : 2,
        cap: ['round', 'butt', 'square'].includes(s.cap) ? s.cap : 'round',
        join: ['round', 'miter', 'bevel'].includes(s.join) ? s.join : 'round',
        opacity: finite(s.opacity) ? Math.max(0, Math.min(1, s.opacity)) : 1 };
    });
    return { schemaVersion: 1, release: '2.0.2', name: String(raw.name || 'icon').slice(0, 80), shapes };
  }
  Object.assign(G, { copy, point, xy, mix, pathData, shapeMarkup, exportSVG, bounds, transform, moveNode, smoothNode, splitSegment, evaluate, nearestSegment, shape, primitive, simplify, simplifyClosed, normalizeProject });
  globalThis.IconGeometry = Object.freeze(G);
})();
