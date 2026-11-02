import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(sourceRoot);
const repoRoot = path.resolve(appRoot, '../../..');
const inputs = ['ui/geometry.js', 'ui/trace.js', 'ui/i18n.js', 'ui/state.js', 'ui/render.js', 'ui/interactions.js', 'ui/io.js', 'ui/boot.js'];
const bundle = inputs.map(file => `/* ${file} */\n${fs.readFileSync(path.join(sourceRoot, file), 'utf8')}\n`).join('');
fs.writeFileSync(path.join(sourceRoot, 'ui.js'), bundle);

// This is an offline user deliverable, not the host-managed compiled.html.
// Reuse the canonical first-paint projection instead of creating another palette.
const appearance = fs.readFileSync(path.join(repoRoot,
  'src/crates/contracts/product-domains/src/miniapp/generated/default_appearance_style.html'), 'utf8');
const css = fs.readFileSync(path.join(sourceRoot, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(sourceRoot, 'index.html'), 'utf8');
const escapeScript = script => script.replace(/<\/script/gi, '<\\/script');
const standalone = html
  .replace('</head>', `${appearance}\n<style>\n${css}\n</style>\n</head>`)
  .replace('</body>', `<script>\n${escapeScript(bundle)}\n</script>\n</body>`);
const outputDir = path.join(repoRoot, 'output', 'miniapps');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'icon-studio-v2.0.2.html'), standalone);
console.log('Built MiniApp source/ui.js and standalone output/miniapps/icon-studio-v2.0.2.html');
