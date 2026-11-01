/* ui/geometry.js */
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

/* ui/trace.js */
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

/* ui/i18n.js */
(() => {
  globalThis.StudioMessages = {
    'zh-CN': {
      title: '图标工坊', tagline: '从像素轮廓到可编辑图标', import: '导入图片 / 工程', new: '新建画布',
      svg: '导出 SVG', copy: '复制 SVG', project: '保存工程', name: '图标名称', layers: '图层', emptyLayers: '导入图片或在画布上绘制。',
      tools: '绘制工具', select: '选择 V', node: '节点 A', pen: '钢笔 P', pencil: '自由绘制 B', line: '直线 L', rect: '矩形 R', ellipse: '椭圆 O',
      undo: '撤销', redo: '重做', duplicate: '复制图层', delete: '删除', up: '上移图层', down: '下移图层',
      templates: '线框起点', home: '首页', download: '下载', grid: '像素网格', snap: '吸附', off: '关闭',
      zoom: '画布缩放', reference: '参考图', opacity: '参考透明度', hideRef: '显示参考图',
      properties: '图层属性', noSelection: '选择一个图层，或使用绘制工具。', filled: '填充轮廓', stroked: '显示描边', width: '描边宽度', cap: '端点', join: '转角',
      round: '圆形', butt: '平头', square: '方形', miter: '尖角', bevel: '斜角',
      fit: '适配 20px 安全区', center: '居中', closePath: '闭合路径', nodeTitle: '节点编辑', smooth: '平滑节点', corner: '转为尖角', insert: '插入节点', removeNode: '删除节点',
      traceTitle: '图片 → 矢量', contrast: '前景对比阈值', simplify: '轮廓简化', smoothing: '曲线平滑', minArea: '最小区域（像素）', trace: '描摹为新图层',
      traceHelp: '单色轮廓描摹，保留镂空。线框图标可在参考图上重绘中线；不会自动识别“首页”等语义。',
      preview: '实际尺寸', code: 'SVG 源码', guide: '24×24 · 默认 2px 圆角描边 · currentColor',
      help: 'V 选择 · A 节点 · P 钢笔 · Enter 完成 · Esc 取消 · ⌘/Ctrl Z 撤销 · 方向键微调',
      penHelp: '逐点点击，拖动创建曲线手柄；点击起点闭合，Enter 完成。',
      ready: '导入 PNG / JPG / WebP 自动描摹，或选择工具开始绘制。',
      tracing: '正在分析像素并描摹轮廓…', traced: '已生成可编辑路径。按 A 调整节点与手柄。', imported: '工程已载入。',
      saved: '文件已保存。', downloaded: '已发起文件下载。', copied: 'SVG 已复制。', emptyExport: '请先绘制或描摹一个可见图层。',
      invalidImage: '请选择有效的 PNG / JPG / WebP 图片，最大 20 MB、1600 万像素、单边 8192 像素。',
      invalidProject: '工程格式不受支持或数据不完整。当前画布和原文件已保留。',
      noForeground: '未找到前景，请降低对比阈值或减小最小区域。', tooComplex: '轮廓过于复杂，请提高简化或最小区域数值，或使用更简单的图片。',
      traceFailed: '描摹失败，请换一张简单背景的单色图片。',
      saveFailed: '保存失败，请重试或选择可写位置。', storageFailed: '自动保存不可用，请保存工程文件。', storageInvalid: '上次保存的工程无法读取，原记录已保留。可手动导入工程。',
      copyFailed: '剪贴板不可用，请导出 SVG 文件。', unsupportedSave: '此宿主不支持保存文件，请使用独立 HTML 版本。',
      busy: '请等待图片处理完成。', tooSmall: '拖动距离太小，请重新绘制。',
      layer: '路径', traceLayer: '描摹', changed: '已更新。', restored: '已恢复上次的矢量工程。',
      autosave: '自动保存矢量工程', noRasterExport: 'SVG 不包含参考图片、网格和编辑手柄。',
      theme: '明暗', language: 'English', canvas: '矢量绘制画布', nodeX: '节点 X', nodeY: '节点 Y',
      visible: '显示图层', layerName: '图层名称', nodeMin: '闭合路径至少需要 3 个节点，开放路径至少需要 2 个。',
      clipping: '部分路径可能越过画布，请检查实际尺寸预览或适配安全区。', paths: '图层', nodes: '节点',
      sampling: '按最长边 512px 采样；参考图不会写入 SVG。',
    },
    'en-US': {
      title: 'Icon Studio', tagline: 'From pixels to editable UI icons', import: 'Import image / project', new: 'New canvas',
      svg: 'Export SVG', copy: 'Copy SVG', project: 'Save project', name: 'Icon name', layers: 'Layers', emptyLayers: 'Import an image or draw on the canvas.',
      tools: 'Drawing tools', select: 'Select V', node: 'Nodes A', pen: 'Pen P', pencil: 'Freehand B', line: 'Line L', rect: 'Rectangle R', ellipse: 'Ellipse O',
      undo: 'Undo', redo: 'Redo', duplicate: 'Duplicate layer', delete: 'Delete', up: 'Raise layer', down: 'Lower layer',
      templates: 'Outline starters', home: 'Home', download: 'Download', grid: 'Pixel grid', snap: 'Snap', off: 'Off',
      zoom: 'Canvas zoom', reference: 'Reference', opacity: 'Reference opacity', hideRef: 'Show reference',
      properties: 'Layer properties', noSelection: 'Select a layer or choose a drawing tool.', filled: 'Fill silhouette', stroked: 'Show stroke', width: 'Stroke width', cap: 'Line cap', join: 'Line join',
      round: 'Round', butt: 'Butt', square: 'Square', miter: 'Miter', bevel: 'Bevel',
      fit: 'Fit 20px safe area', center: 'Center', closePath: 'Close path', nodeTitle: 'Edit node', smooth: 'Smooth node', corner: 'Corner node', insert: 'Insert node', removeNode: 'Delete node',
      traceTitle: 'Image → vector', contrast: 'Foreground contrast', simplify: 'Simplification', smoothing: 'Curve smoothing', minArea: 'Min. area (pixels)', trace: 'Trace as new layer',
      traceHelp: 'Monochrome silhouette tracing preserves holes. Redraw centerlines over the reference for outline icons; tracing does not infer meanings such as “Home”.',
      preview: 'Actual sizes', code: 'SVG source', guide: '24×24 · Default 2px round strokes · currentColor',
      help: 'V select · A nodes · P pen · Enter finish · Esc cancel · ⌘/Ctrl Z undo · Arrow keys nudge',
      penHelp: 'Click to add nodes, drag for curve handles. Click the first node to close; Enter to finish.',
      ready: 'Import PNG / JPG / WebP to trace automatically, or choose a drawing tool.',
      tracing: 'Analyzing pixels and tracing contours…', traced: 'Editable paths created. Press A to edit nodes and handles.', imported: 'Project loaded.',
      saved: 'File saved.', downloaded: 'File download started.', copied: 'SVG copied.', emptyExport: 'Draw or trace a visible layer first.',
      invalidImage: 'Choose a valid PNG / JPG / WebP: up to 20 MB, 16 megapixels, 8192 pixels per side.',
      invalidProject: 'Unsupported or incomplete project. The current canvas and original file are preserved.',
      noForeground: 'No foreground found. Lower contrast or minimum area.', tooComplex: 'Too many contours. Increase simplification or minimum area, or use a simpler image.',
      traceFailed: 'Tracing failed. Try a monochrome image with a simple background.',
      saveFailed: 'Could not save. Try again or choose a writable location.', storageFailed: 'Autosave unavailable. Save a project file.', storageInvalid: 'The saved project could not be read. Its record is preserved; import a project manually.',
      copyFailed: 'Clipboard unavailable. Export an SVG file instead.', unsupportedSave: 'This host cannot save files. Use the standalone HTML version.',
      busy: 'Please wait for image processing to finish.', tooSmall: 'Drag farther to draw a shape.',
      layer: 'Path', traceLayer: 'Trace', changed: 'Updated.', restored: 'Previous vector project restored.',
      autosave: 'Vector project autosave', noRasterExport: 'SVG excludes the reference image, grid and editing handles.',
      theme: 'Theme', language: '中文', canvas: 'Vector drawing canvas', nodeX: 'Node X', nodeY: 'Node Y',
      visible: 'Show layer', layerName: 'Layer name', nodeMin: 'Closed paths need at least 3 nodes; open paths need at least 2.',
      clipping: 'Some paths may extend beyond the canvas. Check actual sizes or fit the safe area.', paths: 'layers', nodes: 'nodes',
      sampling: 'Sampled at up to 512px on the longest side. The reference is excluded from SVG.',
    },
  };
})();

/* ui/state.js */
(() => {
  const G = IconGeometry;
  const S = {
    $: id => document.getElementById(id), host: window.app,
    locale: /^(zh|yue)/i.test(window.app?.locale || navigator.language) ? 'zh-CN' : 'en-US',
    doc: { schemaVersion: 1, release: '2.0.2', name: 'icon', shapes: [] },
    selected: null, node: null, tool: 'select', draft: null, gesture: null,
    undo: [], redo: [], revision: 0, sequence: 0, job: 0, busy: false, saving: false,
    source: null, referenceURL: '', statusKey: 'ready', tone: '',
  };
  S.t = key => StudioMessages[S.locale][key] || key;
  S.status = (key, tone = '') => {
    S.statusKey = key; S.tone = tone;
    S.$('status').textContent = S.t(key); S.$('status').dataset.tone = tone;
  };
  S.current = () => S.doc.shapes.find(s => s.id === S.selected) || null;
  S.currentNode = () => S.node ? S.current()?.contours[S.node.ci]?.nodes[S.node.ni] : null;
  S.nextId = () => {
    let id;
    do { id = `path-${++S.sequence}`; } while (S.doc.shapes.some(s => s.id === id));
    return id;
  };
  S.snapshot = () => G.copy(S.doc);
  S.record = before => {
    if (JSON.stringify(before) === JSON.stringify(S.doc)) { S.render?.(); return true; }
    // The editor must never save a document that its own reader cannot open.
    try { G.normalizeProject(S.doc); }
    catch {
      S.doc = before;
      if (!S.current()) S.selected = S.doc.shapes.at(-1)?.id || null;
      S.node = null; S.render?.(); S.status('tooComplex', 'warning'); return false;
    }
    S.undo.push(before); if (S.undo.length > 100) S.undo.shift();
    S.redo = []; S.revision++; S.autosave?.(); S.render?.();
    if (S.doc.shapes.some(shape => {
      const b = G.bounds(shape), padding = shape.stroke ? shape.width / 2 : 0;
      return shape.visible && (b.x - padding < 0 || b.y - padding < 0 || b.x + b.width + padding > 24 || b.y + b.height + padding > 24);
    })) S.status('clipping', 'warning');
    return true;
  };
  S.change = fn => {
    if (S.busy || S.saving) { S.status('busy'); return false; }
    const before = S.snapshot(); fn(); return S.record(before);
  };
  S.add = (shape, name) => {
    shape.id = S.nextId(); shape.name = name || shape.name;
    S.doc.shapes.push(shape); S.selected = shape.id; S.node = null;
  };
  S.history = redo => {
    if (S.busy || S.saving) return;
    S.draft = null; S.gesture = null;
    const from = redo ? S.redo : S.undo, to = redo ? S.undo : S.redo;
    if (!from.length) return;
    to.push(S.snapshot()); S.doc = from.pop();
    if (!S.current()) S.selected = S.doc.shapes.at(-1)?.id || null;
    S.node = null; S.revision++; S.autosave?.(); S.render(); S.status('changed');
  };
  S.finishDraft = closed => {
    if (!S.draft) return;
    const draft = S.draft; S.draft = null;
    const contour = draft.contours[0];
    contour.closed = Boolean(closed);
    if (contour.nodes.length >= (closed ? 3 : 2)) S.change(() => S.add(draft, S.t('layer')));
    else S.render?.();
  };
  S.setTool = tool => {
    if (S.busy || S.saving) return;
    if (S.draft) S.finishDraft(false);
    S.tool = tool; S.node = null; S.render();
    S.status(tool === 'pen' ? 'penHelp' : 'ready');
  };
  S.snap = (number, disabled = false) => {
    const step = disabled ? 0 : Number(S.$('snap').value);
    return step ? Math.round(number / step) * step : number;
  };
  S.select = id => { S.selected = id; S.node = null; S.render(); };
  globalThis.IconStudio = S;
})();

/* ui/render.js */
(() => {
  const S = IconStudio, G = IconGeometry, $ = S.$;
  const ns = 'http://www.w3.org/2000/svg';
  const node = (tag, attrs = {}) => {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  function field(id, value) { if (document.activeElement !== $(id)) $(id).value = value; }
  S.localize = () => {
    document.documentElement.lang = S.locale;
    document.title = `${S.t('title')} V2.0.2`;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = S.t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', S.t(el.dataset.i18nAria)); });
    S.status(S.statusKey, S.tone);
  };
  S.renderCanvas = () => {
    const art = $('art'); art.replaceChildren();
    for (const shape of S.doc.shapes) {
      if (!shape.visible) continue;
      const group = node('g', { 'data-shape': shape.id });
      const path = node('path', { d: G.pathData(shape), fill: shape.fill ? 'currentColor' : 'none', stroke: shape.stroke ? 'currentColor' : 'none',
        'fill-rule': 'evenodd', 'stroke-width': shape.width, 'stroke-linecap': shape.cap, 'stroke-linejoin': shape.join, opacity: shape.opacity });
      group.append(path, node('path', { d: G.pathData(shape), class: 'art-hit', 'pointer-events': 'stroke' })); art.append(group);
    }
    const draft = $('draft'); draft.replaceChildren();
    if (S.draft) {
      draft.append(node('path', { d: G.pathData(S.draft), fill: 'none', stroke: 'currentColor', 'stroke-width': S.draft.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    }
    const handles = $('handles'); handles.replaceChildren();
    const selected = S.current();
    if (selected && selected.visible) {
      const b = G.bounds(selected);
      handles.append(node('rect', { x: b.x - .2, y: b.y - .2, width: Math.max(.4, b.width + .4), height: Math.max(.4, b.height + .4), class: 'selection-box' }));
      if (S.tool === 'node') selected.contours.forEach((contour, ci) => {
        contour.nodes.forEach((n, ni) => {
          const active = S.node?.ci === ci && S.node?.ni === ni;
          const group = node('g', { 'data-node': ni, 'data-contour': ci });
          group.append(node('circle', { cx: n.x, cy: n.y, r: .48, class: 'node-hit' }),
            node('circle', { cx: n.x, cy: n.y, r: active ? .21 : .15, class: `node-point${active ? ' active' : ''}`, 'pointer-events': 'none' }));
          handles.append(group);
        });
      });
      if (S.tool === 'node' && S.currentNode()) {
        const n = S.currentNode();
        for (const key of ['in', 'out']) if (n[key]) {
          const [x, y] = n[key];
          handles.append(node('line', { x1: n.x, y1: n.y, x2: x, y2: y, class: 'control-line' }));
          const group = node('g', { 'data-handle': key });
          group.append(node('circle', { cx: x, cy: y, r: .48, class: 'node-hit' }), node('circle', { cx: x, cy: y, r: .15, class: 'control-point', 'pointer-events': 'none' }));
          handles.append(group);
        }
      }
    }
    if (S.draft && S.tool === 'pen') S.draft.contours[0].nodes.forEach((n, i) => {
      handles.append(node('circle', { cx: n.x, cy: n.y, r: .19, class: 'node-point', 'data-draft-node': i }));
    });
    $('grid-overlay').hidden = !$('grid').checked;
    $('grid-overlay').style.display = $('grid').checked ? '' : 'none';
    $('reference-image').setAttribute('href', S.referenceURL);
    $('reference-image').setAttribute('opacity', $('show-reference').checked ? $('reference-opacity').value : '0');
    $('canvas').style.cursor = ['select', 'node'].includes(S.tool) ? 'default' : 'crosshair';
  };
  S.render = () => {
    S.renderCanvas();
    document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === S.tool)));
    const selected = S.current(), disabled = S.busy || S.saving;
    $('properties').disabled = !selected || disabled;
    $('no-selection').hidden = Boolean(selected);
    field('name', S.doc.name);
    const layers = $('layers'); layers.replaceChildren();
    if (!S.doc.shapes.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = S.t('emptyLayers'); layers.append(empty); }
    for (const shape of [...S.doc.shapes].reverse()) {
      const row = document.createElement('div'); row.className = `layer${shape.id === S.selected ? ' active' : ''}`;
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = shape.visible; check.disabled = disabled;
      check.setAttribute('aria-label', `${S.t('visible')}: ${shape.name}`);
      check.addEventListener('change', () => S.change(() => { shape.visible = check.checked; }));
      const button = document.createElement('button'); button.textContent = shape.name; button.disabled = disabled;
      button.addEventListener('click', () => S.select(shape.id)); row.append(check, button); layers.append(row);
    }
    if (selected) {
      const b = G.bounds(selected);
      field('layer-name', selected.name);
      for (const [id, value] of [['shape-x', b.x], ['shape-y', b.y], ['shape-w', b.width], ['shape-h', b.height], ['stroke-width', selected.width]]) field(id, Number(value.toFixed(3)));
      $('fill').checked = selected.fill; $('stroke').checked = selected.stroke; $('visible').checked = selected.visible;
      $('cap').value = selected.cap; $('join').value = selected.join;
    }
    const currentNode = S.currentNode();
    $('node-properties').hidden = !currentNode;
    if (currentNode) { field('node-x', Number(currentNode.x.toFixed(3))); field('node-y', Number(currentNode.y.toFixed(3))); }
    for (const id of ['duplicate', 'delete', 'fit', 'center', 'close-path', 'raise', 'lower']) $(id).disabled = !selected || disabled;
    $('undo').disabled = !S.undo.length || disabled; $('redo').disabled = !S.redo.length || disabled;
    $('trace-controls').disabled = !S.source || disabled;
    $('reference-controls').hidden = !S.referenceURL;
    for (const id of ['import', 'new', 'project', 'export', 'copy', 'home', 'download-starter', 'name']) $(id).disabled = disabled;
    document.querySelectorAll('[data-tool]').forEach(button => { button.disabled = disabled; });
    const svg = G.exportSVG(S.doc);
    $('code').value = svg;
    const previews = $('previews'); previews.replaceChildren();
    for (const size of [16, 20, 24, 32]) {
      const sample = document.createElement('div'); sample.className = 'preview-sample';
      const label = document.createElement('span'); label.textContent = `${size}px`;
      const standard = document.createElement('div'); standard.className = 'preview-pair'; standard.innerHTML = G.exportSVG(S.doc, size);
      const inverse = document.createElement('div'); inverse.className = 'preview-pair preview-inverse'; inverse.innerHTML = G.exportSVG(S.doc, size);
      sample.append(label, standard, inverse); previews.append(sample);
    }
    const count = S.doc.shapes.reduce((sum, shape) => sum + shape.contours.reduce((n, c) => n + c.nodes.length, 0), 0);
    $('node-count').textContent = `${S.doc.shapes.length} ${S.t('paths')} · ${count} ${S.t('nodes')}`;
    $('instructions').textContent = S.t(S.tool === 'pen' ? 'penHelp' : 'help');
  };
})();

/* ui/interactions.js */
(() => {
  const S = IconStudio, G = IconGeometry, $ = S.$;
  const canvas = $('canvas');
  function location(event) {
    const box = canvas.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width * 24, y: (event.clientY - box.top) / box.height * 24 };
  }
  const snapped = (p, disabled = false) => ({ x: S.snap(p.x, disabled), y: S.snap(p.y, disabled) });
  function begin(event) {
    if (event.button !== 0 || S.busy || S.saving || event.detail > 1) return;
    event.preventDefault(); canvas.focus();
    const raw = location(event), p = snapped(raw, event.altKey);
    const shapeElement = event.target.closest('[data-shape]');
    const nodeElement = event.target.closest('[data-node]');
    const handleElement = event.target.closest('[data-handle]');
    let gesture;
    if (S.tool === 'select' || S.tool === 'node') {
      if (S.tool === 'node' && handleElement && S.currentNode()) {
        gesture = { type: 'handle', key: handleElement.dataset.handle, before: S.snapshot(), original: G.copy(S.current()), start: raw };
      } else if (S.tool === 'node' && nodeElement && S.current()) {
        S.node = { ci: Number(nodeElement.dataset.contour), ni: Number(nodeElement.dataset.node) };
        gesture = { type: 'node', before: S.snapshot(), original: G.copy(S.current()), start: raw };
      } else if (shapeElement) {
        if (S.selected !== shapeElement.dataset.shape) { S.selected = shapeElement.dataset.shape; S.node = null; }
        if (S.tool === 'select') gesture = { type: 'move', before: S.snapshot(), original: G.copy(S.current()), start: raw };
      } else { S.selected = null; S.node = null; }
    } else if (S.tool === 'pen') {
      if (S.draft && event.target.dataset.draftNode === '0' && S.draft.contours[0].nodes.length >= 3) {
        S.finishDraft(true); S.render(); return;
      }
      const draftBefore = S.draft ? G.copy(S.draft) : null;
      if (!S.draft) S.draft = G.shape([{ closed: false, nodes: [] }]);
      S.draft.contours[0].nodes.push(G.point(p.x, p.y));
      gesture = { type: 'pen', start: p, draftBefore };
    } else if (S.tool === 'pencil') {
      S.draft = G.shape([{ closed: false, nodes: [G.point(raw.x, raw.y)] }]);
      gesture = { type: 'pencil', points: [[raw.x, raw.y]] };
    } else {
      S.draft = G.primitive(S.tool, p, p);
      gesture = { type: 'primitive', primitive: S.tool, start: p };
    }
    if (gesture) {
      gesture.pointerId = event.pointerId;
      S.gesture = gesture;
      canvas.setPointerCapture?.(event.pointerId);
    }
    S.render();
  }
  function move(event) {
    const gesture = S.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const raw = location(event), p = snapped(raw, event.altKey);
    if (['move', 'node', 'handle'].includes(gesture.type)) {
      const shape = G.copy(gesture.original);
      if (gesture.type === 'move') {
        G.transform(shape, 1, 1, S.snap(raw.x - gesture.start.x, event.altKey), S.snap(raw.y - gesture.start.y, event.altKey));
      } else {
        const n = shape.contours[S.node.ci].nodes[S.node.ni];
        if (gesture.type === 'node') G.moveNode(n, p.x, p.y);
        else n[gesture.key] = [p.x, p.y];
      }
      const index = S.doc.shapes.findIndex(s => s.id === shape.id); S.doc.shapes[index] = shape;
    } else if (gesture.type === 'pen') {
      const n = S.draft.contours[0].nodes.at(-1), dx = p.x - n.x, dy = p.y - n.y;
      if (Math.hypot(dx, dy) > .08) { n.out = [p.x, p.y]; n.in = [n.x - dx, n.y - dy]; }
    } else if (gesture.type === 'pencil') {
      const last = gesture.points.at(-1);
      if (Math.hypot(raw.x - last[0], raw.y - last[1]) >= .05) {
        gesture.points.push([raw.x, raw.y]);
        S.draft.contours[0].nodes.push(G.point(raw.x, raw.y));
      }
    } else if (gesture.type === 'primitive') {
      if (event.shiftKey && gesture.primitive !== 'line') {
        const size = Math.max(Math.abs(p.x - gesture.start.x), Math.abs(p.y - gesture.start.y));
        p.x = gesture.start.x + size * (p.x < gesture.start.x ? -1 : 1);
        p.y = gesture.start.y + size * (p.y < gesture.start.y ? -1 : 1);
      }
      S.draft = G.primitive(gesture.primitive, gesture.start, p);
    }
    S.renderCanvas();
  }
  function end(event, cancelled = false) {
    const gesture = S.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!cancelled) move(event);
    S.gesture = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (cancelled) {
      if (gesture.before) S.doc = gesture.before;
      if (gesture.type === 'pen') S.draft = gesture.draftBefore;
      else S.draft = null;
      S.render(); return;
    }
    if (gesture.before) S.record(gesture.before);
    else if (gesture.type === 'primitive') {
      const draft = S.draft, b = G.bounds(draft); S.draft = null;
      const valid = gesture.primitive === 'line' ? Math.hypot(b.width, b.height) >= .1 : b.width >= .1 && b.height >= .1;
      if (valid) S.change(() => S.add(draft, S.t(gesture.primitive).replace(/\s+[A-Z]$/, '')));
      else { S.status('tooSmall', 'warning'); S.render(); }
    } else if (gesture.type === 'pencil') {
      const points = G.simplify(gesture.points, .08);
      S.draft.contours[0].nodes = points.map(([x, y]) => G.point(x, y));
      S.draft.contours[0].nodes.forEach((_, i) => G.smoothNode(S.draft.contours[0], i, .7));
      S.finishDraft(false);
    } else S.render();
  }
  canvas.addEventListener('pointerdown', begin);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', e => end(e));
  canvas.addEventListener('pointercancel', e => end(e, true));
  canvas.addEventListener('dblclick', event => {
    event.preventDefault();
    if (S.tool === 'pen') { S.finishDraft(false); return; }
    if (S.tool !== 'node' || !S.current() || event.target.closest('[data-node], [data-handle]')) return;
    const p = location(event), nearest = G.nearestSegment(S.current(), p.x, p.y);
    if (nearest && nearest.distance < 1) S.change(() => {
      G.splitSegment(S.current().contours[nearest.contour], nearest.index, nearest.t);
      S.node = { ci: nearest.contour, ni: nearest.index + 1 };
    });
  });
  S.deleteNode = () => {
    const node = S.currentNode(); if (!node) return;
    const contour = S.current().contours[S.node.ci];
    if (contour.nodes.length <= (contour.closed ? 3 : 2)) { S.status('nodeMin', 'warning'); return; }
    S.change(() => { contour.nodes.splice(S.node.ni, 1); S.node.ni = Math.min(S.node.ni, contour.nodes.length - 1); });
  };
  S.deleteLayer = () => {
    if (!S.current()) return;
    S.change(() => { S.doc.shapes = S.doc.shapes.filter(s => s.id !== S.selected); S.selected = S.doc.shapes.at(-1)?.id || null; S.node = null; });
  };
  S.duplicate = () => {
    if (!S.current()) return;
    S.change(() => { const shape = G.copy(S.current()); G.transform(shape, 1, 1, .5, .5); S.add(shape); });
  };
  document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => S.setTool(button.dataset.tool)));
  $('undo').addEventListener('click', () => S.history(false)); $('redo').addEventListener('click', () => S.history(true));
  $('duplicate').addEventListener('click', S.duplicate); $('delete').addEventListener('click', S.deleteLayer);
  $('delete-node').addEventListener('click', S.deleteNode);
  $('insert-node').addEventListener('click', () => { if (S.currentNode()) S.change(() => {
    if (G.splitSegment(S.current().contours[S.node.ci], S.node.ni)) S.node.ni++;
  }); });
  $('smooth').addEventListener('click', () => { if (S.currentNode()) S.change(() => G.smoothNode(S.current().contours[S.node.ci], S.node.ni)); });
  $('corner').addEventListener('click', () => { if (S.currentNode()) S.change(() => { S.currentNode().in = null; S.currentNode().out = null; }); });
  for (const key of ['x', 'y']) $(`node-${key}`).addEventListener('change', () => {
    const n = S.currentNode(), value = Number($(`node-${key}`).value);
    if (n && Number.isFinite(value) && Math.abs(value) <= 10000) S.change(() => G.moveNode(n, key === 'x' ? value : n.x, key === 'y' ? value : n.y));
    else S.render();
  });
  for (const [id, key] of [['fill', 'fill'], ['stroke', 'stroke'], ['visible', 'visible']]) $(id).addEventListener('change', () => { if (S.current()) S.change(() => { S.current()[key] = $(id).checked; }); });
  for (const key of ['cap', 'join']) $(key).addEventListener('change', () => { if (S.current()) S.change(() => { S.current()[key] = $(key).value; }); });
  $('stroke-width').addEventListener('change', () => {
    const value = Number($('stroke-width').value);
    if (S.current() && value >= .1 && value <= 8) S.change(() => { S.current().width = value; }); else S.render();
  });
  $('layer-name').addEventListener('change', () => { if (S.current()) S.change(() => { S.current().name = $('layer-name').value.slice(0, 80) || S.t('layer'); }); });
  $('name').addEventListener('change', () => S.change(() => { S.doc.name = $('name').value.slice(0, 80) || 'icon'; }));
  for (const key of ['x', 'y', 'w', 'h']) $(`shape-${key}`).addEventListener('change', () => {
    const shape = S.current(), value = Number($(`shape-${key}`).value);
    if (!shape || !Number.isFinite(value) || Math.abs(value) > 1000 || ['w', 'h'].includes(key) && value < .1) { S.render(); return; }
    S.change(() => {
      const b = G.bounds(shape);
      if (key === 'x' || key === 'y') G.transform(shape, 1, 1, key === 'x' ? value - b.x : 0, key === 'y' ? value - b.y : 0);
      else if (b[key === 'w' ? 'width' : 'height'] > 0) G.transform(shape, key === 'w' ? value / b.width : 1, key === 'h' ? value / b.height : 1, 0, 0, [b.x, b.y]);
    });
  });
  $('center').addEventListener('click', () => { if (S.current()) S.change(() => {
    const b = G.bounds(S.current()); G.transform(S.current(), 1, 1, 12 - b.x - b.width / 2, 12 - b.y - b.height / 2);
  }); });
  $('fit').addEventListener('click', () => { if (S.current()) S.change(() => {
    const shape = S.current(), b = G.bounds(shape), padding = shape.stroke ? shape.width / 2 : 0;
    const scale = (20 - padding * 2) / (Math.max(b.width, b.height) || 1);
    G.transform(shape, scale, scale, 0, 0, [b.x + b.width / 2, b.y + b.height / 2]);
    const next = G.bounds(shape); G.transform(shape, 1, 1, 12 - next.x - next.width / 2, 12 - next.y - next.height / 2);
  }); });
  $('close-path').addEventListener('click', () => { if (S.current()) S.change(() => {
    for (const contour of S.current().contours) if (contour.nodes.length >= 3) contour.closed = true;
  }); });
  for (const [id, direction] of [['raise', 1], ['lower', -1]]) $(id).addEventListener('click', () => { if (S.current()) S.change(() => {
    const index = S.doc.shapes.findIndex(s => s.id === S.selected), next = index + direction;
    if (next >= 0 && next < S.doc.shapes.length) [S.doc.shapes[index], S.doc.shapes[next]] = [S.doc.shapes[next], S.doc.shapes[index]];
  }); });
  $('grid').addEventListener('change', S.renderCanvas);
  $('zoom').addEventListener('change', () => { canvas.setAttribute('width', $('zoom').value); canvas.setAttribute('height', $('zoom').value); });
  $('show-reference').addEventListener('change', S.renderCanvas); $('reference-opacity').addEventListener('input', S.renderCanvas);
  for (const key of ['contrast', 'simplify', 'smoothing', 'minArea']) $(`trace-${key}`).addEventListener('input', () => { $(`trace-${key}-value`).textContent = $(`trace-${key}`).value; });
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, textarea, select') || event.target.isContentEditable || S.busy || S.saving) return;
    const key = event.key.toLowerCase(), command = event.metaKey || event.ctrlKey;
    if (command && key === 'z') { event.preventDefault(); S.history(event.shiftKey); return; }
    if (command && key === 'y') { event.preventDefault(); S.history(true); return; }
    if (command && key === 'd') { event.preventDefault(); S.duplicate(); return; }
    if (command && key === 's') { event.preventDefault(); S.saveProject?.(); return; }
    if (command || event.altKey) return;
    if (key === 'escape') {
      if (S.gesture?.before) S.doc = S.gesture.before;
      S.draft = null; S.gesture = null; S.node = null; S.render(); return;
    }
    if (key === 'enter') { S.finishDraft(false); return; }
    if (key === 'delete' || key === 'backspace') {
      event.preventDefault();
      if (S.draft) { S.draft.contours[0].nodes.pop(); if (!S.draft.contours[0].nodes.length) S.draft = null; S.render(); }
      else if (S.tool === 'node' && S.currentNode()) S.deleteNode(); else S.deleteLayer();
      return;
    }
    const tools = { v: 'select', a: 'node', p: 'pen', b: 'pencil', l: 'line', r: 'rect', o: 'ellipse' };
    if (tools[key]) { event.preventDefault(); S.setTool(tools[key]); return; }
    if (key.startsWith('arrow') && S.current()) {
      event.preventDefault(); const step = event.shiftKey ? 1 : Number($('snap').value) || .1;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      S.change(() => { const n = S.currentNode(); if (n) G.moveNode(n, n.x + dx, n.y + dy); else G.transform(S.current(), 1, 1, dx, dy); });
    }
  });
})();

/* ui/io.js */
(() => {
  const S = IconStudio, G = IconGeometry, $ = S.$;
  const storageKey = 'icon-studio-project-v1';
  let timer, dirty = false, queued = null, writing = false, drainPromise = Promise.resolve();
  const errorKey = (error, fallback) => Object.hasOwn(StudioMessages['en-US'], error?.message) ? error.message : fallback;
  async function drain() {
    writing = true;
    try {
      while (queued) {
        const snapshot = queued; queued = null;
        try {
        if (S.host) {
          if (!S.host.storage?.set) throw new Error('storageFailed');
          await S.host.storage.set(storageKey, snapshot);
        } else localStorage.setItem(storageKey, JSON.stringify(snapshot));
        } catch { S.status('storageFailed', 'warning'); }
      }
    } finally { writing = false; }
  }
  S.flushSave = () => {
    clearTimeout(timer); timer = null;
    if (dirty) { queued = S.snapshot(); dirty = false; }
    // drain() invokes the host before its first await, so pagehide does not
    // leave a new save request waiting in a cancelled debounce timer.
    if (queued && !writing) drainPromise = drain();
    return drainPromise;
  };
  S.autosave = () => {
    dirty = true; clearTimeout(timer);
    timer = setTimeout(S.flushSave, 400);
  };
  S.restore = async () => {
    const revision = S.revision;
    try {
      const saved = S.host ? await S.host.storage?.get?.(storageKey) : JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved == null || S.revision !== revision || S.busy || S.draft) return;
      S.doc = G.normalizeProject(saved); S.selected = S.doc.shapes.at(-1)?.id || null;
      S.render(); S.status('restored');
    } catch { S.status('storageInvalid', 'warning'); }
  };
  async function saveFile(text, filename, extension, mime) {
    if (S.busy || S.saving) return;
    S.finishDraft(false);
    S.saving = true; S.render();
    try {
      if (S.host) {
        if (!S.host.dialog?.save || !S.host.fs?.writeFile) { S.status('unsupportedSave', 'error'); return; }
        const path = await S.host.dialog.save({ title: filename, defaultPath: filename, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
        if (!path) return;
        await S.host.fs.writeFile(path, text, { encoding: 'utf-8' }); S.status('saved');
      } else {
        const link = document.createElement('a'); link.download = filename;
        link.href = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
        document.body.append(link); link.click(); link.remove(); S.status('downloaded');
      }
    } catch { S.status('saveFailed', 'error'); }
    finally { S.saving = false; S.render(); }
  }
  const filename = () => (S.doc.name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'icon').slice(0, 64);
  S.saveProject = () => {
    S.finishDraft(false);
    return saveFile(JSON.stringify(S.doc, null, 2), `${filename()}.icon.json`, 'json', 'application/json');
  };
  S.exportSVG = () => {
    S.finishDraft(false);
    if (!S.doc.shapes.some(s => s.visible && (s.fill || s.stroke))) { S.status('emptyExport', 'warning'); return; }
    return saveFile(G.exportSVG(S.doc), `${filename()}.svg`, 'svg', 'image/svg+xml');
  };
  S.trace = async () => {
    if (!S.source || S.busy || S.saving) return;
    S.finishDraft(false);
    const job = ++S.job, revision = S.revision;
    S.busy = true; S.render(); S.status('tracing');
    try {
      const output = await IconTrace.trace(S.source, {
        contrast: Number($('trace-contrast').value), simplify: Number($('trace-simplify').value),
        smoothing: Number($('trace-smoothing').value), minArea: Number($('trace-minArea').value),
      }, () => job !== S.job || revision !== S.revision);
      if (job !== S.job || revision !== S.revision) return;
      S.busy = false;
      S.change(() => S.add(output.shape, S.t('traceLayer')));
      S.tool = 'node'; S.node = null; S.render(); S.status('traced');
    } catch (error) {
      if (job === S.job && error.message !== 'cancelled') S.status(errorKey(error, 'traceFailed'), 'error');
    } finally { if (job === S.job) { S.busy = false; S.render(); } }
  };
  const readURL = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
  });
  S.load = async file => {
    if (S.busy || S.saving) { S.status('busy'); return; }
    if (S.draft) S.finishDraft(false);
    if (file.size > 20 * 1024 * 1024) { S.status('invalidImage', 'error'); return; }
    if (/\.json$/i.test(file.name)) {
      S.busy = true; S.render();
      try {
        if (file.size > 4 * 1024 * 1024) throw new Error('invalidProject');
        const next = G.normalizeProject(JSON.parse(await file.text()));
        S.busy = false;
        S.change(() => { S.doc = next; S.selected = next.shapes.at(-1)?.id || null; S.node = null; });
        S.source = null; S.referenceURL = ''; S.render(); S.status('imported');
      } catch { S.status('invalidProject', 'error'); }
      finally { S.busy = false; S.render(); }
      return;
    }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !(file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name))) { S.status('invalidImage', 'error'); return; }
    const job = ++S.job;
    S.busy = true; S.render(); S.status('tracing');
    try {
      const source = await readURL(file), image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = source; });
      if (job !== S.job) return;
      const w = image.naturalWidth, h = image.naturalHeight;
      if (!w || !h || w * h > 16000000 || w > 8192 || h > 8192) throw new Error('invalidImage');
      const scale = Math.min(1, 512 / Math.max(w, h));
      const buffer = document.createElement('canvas'); buffer.width = Math.max(1, Math.round(w * scale)); buffer.height = Math.max(1, Math.round(h * scale));
      const context = buffer.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0, buffer.width, buffer.height);
      S.source = context.getImageData(0, 0, buffer.width, buffer.height);
      S.referenceURL = buffer.toDataURL('image/png'); $('show-reference').checked = true;
      S.busy = false; S.render(); await S.trace();
    } catch (error) {
      if (job === S.job) S.status(errorKey(error, 'invalidImage'), 'error');
    } finally { if (job === S.job) { S.busy = false; S.render(); } }
  };
  $('import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) void S.load(file); event.target.value = ''; });
  $('export').addEventListener('click', S.exportSVG); $('project').addEventListener('click', S.saveProject); $('trace').addEventListener('click', S.trace);
  $('copy').addEventListener('click', async () => {
    S.finishDraft(false);
    if (!S.doc.shapes.some(s => s.visible && (s.fill || s.stroke))) { S.status('emptyExport', 'warning'); return; }
    const svg = G.exportSVG(S.doc);
    try { if (S.host) await S.host.clipboard.writeText(svg); else await navigator.clipboard.writeText(svg); S.status('copied'); }
    catch { S.status('copyFailed', 'warning'); }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault(); dragDepth++; document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0]; if (file) void S.load(file);
  });
  document.addEventListener('paste', event => {
    if (event.target.matches('input, textarea') || event.target.isContentEditable) return;
    const file = Array.from(event.clipboardData?.files || []).find(f => f.type.startsWith('image/'));
    if (file) { event.preventDefault(); void S.load(file); }
  });
  window.addEventListener('pagehide', () => {
    S.job++;
    void S.flushSave();
  });
  S.host?.onDeactivate?.(() => { void S.flushSave(); });
})();

/* ui/boot.js */
(() => {
  const S = IconStudio, G = IconGeometry, $ = S.$;
  const theme = mode => { document.documentElement.dataset.openbitfunAppearanceMode = mode; };
  if (S.host) {
    theme(S.host.appearanceMode || 'dark');
    S.host.onAppearanceChange?.(payload => theme(payload.mode));
    S.host.onLocaleChange?.(locale => { S.locale = /^(zh|yue)/i.test(locale) ? 'zh-CN' : 'en-US'; S.localize(); S.render(); });
  } else { theme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); $('theme').hidden = false; }
  $('theme').addEventListener('click', () => theme(document.documentElement.dataset.openbitfunAppearanceMode === 'dark' ? 'light' : 'dark'));
  $('language').addEventListener('click', () => { S.locale = S.locale === 'zh-CN' ? 'en-US' : 'zh-CN'; S.localize(); S.render(); });
  $('new').addEventListener('click', () => {
    if (S.change(() => { S.doc.shapes = []; S.doc.name = 'icon'; S.selected = null; S.node = null; })) {
      S.draft = null; S.referenceURL = ''; S.source = null; S.render(); S.status('ready');
    }
  });
  // Simple editable centerline starters, drawn on the same 24px canvas. These
  // are starting geometry, not semantic predictions from the imported image.
  $('home').addEventListener('click', () => S.change(() => {
    const roof = [G.point(3, 10), G.point(12, 3), G.point(21, 10)];
    const walls = [[5, 9], [5, 21], [10, 21], [10, 15], [14, 15], [14, 21], [19, 21], [19, 9]].map(([x, y]) => G.point(x, y));
    S.add(G.shape([{ closed: false, nodes: roof }, { closed: false, nodes: walls }]), S.t('home'));
  }));
  $('download-starter').addEventListener('click', () => S.change(() => {
    const contours = [[[12, 3], [12, 16]], [[7, 11], [12, 16], [17, 11]], [[4, 17], [4, 21], [20, 21], [20, 17]]]
      .map(points => ({ closed: false, nodes: points.map(([x, y]) => G.point(x, y)) }));
    S.add(G.shape(contours), S.t('download'));
  }));
  S.localize(); S.render(); void S.restore();
})();

