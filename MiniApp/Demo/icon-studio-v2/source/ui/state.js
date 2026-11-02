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
