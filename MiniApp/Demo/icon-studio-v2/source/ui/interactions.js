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
