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
