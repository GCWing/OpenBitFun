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
