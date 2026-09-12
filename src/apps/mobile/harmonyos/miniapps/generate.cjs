// Build-time projection of shared MiniApp sources; generated resources are not edited.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../../..');
const source = path.join(root, 'src/crates/contracts/product-domains/src/miniapp');
const output = path.resolve(__dirname, '../entry/src/main/resources/rawfile/miniapps');
const apps = ['gomoku', 'regex-playground', 'divination'];
function generate() {
  fs.mkdirSync(output, { recursive: true });
  const appearance = fs.readFileSync(path.join(source, 'generated/default_appearance_style.html'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
  const mobileCss = fs.readFileSync(path.join(__dirname, 'mobile.css'), 'utf8');
  const catalog = [];
  for (const folder of apps) {
    const read = name => fs.readFileSync(path.join(source, 'builtin/assets', folder, name), 'utf8');
    const meta = JSON.parse(read('meta.json'));
    if (meta.permissions.node.enabled !== false || meta.permissions.shell.allow.length || meta.permissions.net.allow.length) {
      throw new Error(`Built-in mobile MiniApp requires unsupported capabilities: ${meta.id}`);
    }
    const css = read('style.css');
    const js = read('ui.js');
    const script = text => `<script>${text.replace(/<\/script/gi, '<\\/script')}</script>`;
    const html = read('index.html')
      .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">`)
      .replace('</head>', () => `${appearance}<style>${css}\n${mobileCss}</style>${script(bridge)}</head>`)
      .replace('</body>', () => `${script(js)}</body>`);
    const file = path.join(output, `${meta.id}.html`);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== html) fs.writeFileSync(file, html);
    catalog.push({ id: meta.id, locales: meta.i18n.locales });
  }
  const file = path.join(output, 'catalog.json');
  const value = JSON.stringify(catalog);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== value) fs.writeFileSync(file, value);
}
module.exports = { generate };
if (require.main === module) generate();
