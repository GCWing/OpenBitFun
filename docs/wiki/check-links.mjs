import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wikiRoot = fileURLToPath(new URL('./pages/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const pages = readdirSync(wikiRoot).filter(name => name.endsWith('.md'));
const errors = [];
const pending = new Map();
const checklistTopics = [];

for (const name of pages) {
  const content = readFileSync(path.join(wikiRoot, name), 'utf8');
  for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(target)) {
      const source = target.match(/^https:\/\/github\.com\/GCWing\/OpenBitFun\/blob\/v1\.0\.0\/([^#]+)/);
      if (source && !existsSync(path.join(repoRoot, decodeURIComponent(source[1])))) {
        errors.push(`${name}: missing source reference ${source[1]}`);
      }
      continue;
    }
    const page = decodeURIComponent(target.split('#')[0]);
    if (!existsSync(path.join(wikiRoot, `${page}.md`))) {
      errors.push(`${name}: missing Wiki target ${target}`);
    }
  }
  if (!name.startsWith('_')) {
    const counterpart = content.split('\n')[0].match(/\]\(([^)]+)\)/)?.[1];
    const counterpartPath = counterpart && path.join(wikiRoot, `${counterpart}.md`);
    if (!counterpartPath || !existsSync(counterpartPath)) {
      errors.push(`${name}: missing language counterpart`);
    } else {
      const firstLine = readFileSync(counterpartPath, 'utf8').split('\n')[0];
      if (!firstLine.includes(`](${name.slice(0, -3)})`)) {
        errors.push(`${name}: counterpart does not link back`);
      }
    }
  }
  if (name === 'Screenshot-Checklist.md' || name === '截图清单.md') {
    checklistTopics.push(new Set([...content.matchAll(/^\| (S\d+) \|/gm)].map(m => m[1])));
  }
  for (const line of content.split('\n').filter(line => /^> (Screenshot pending:|待补截图：)/.test(line))) {
    for (const id of line.match(/S\d+/g) ?? []) {
      const locations = pending.get(id) ?? new Set();
      locations.add(name);
      pending.set(id, locations);
    }
  }
}

const [english, chinese] = checklistTopics;
if (!english || !chinese || english.size === 0 || english.size !== chinese.size || [...english].some(id => !chinese.has(id))) {
  errors.push('Screenshot checklist topics differ between languages or are empty');
}
for (const id of english ?? []) {
  if (pending.get(id)?.size !== 2) errors.push(`${id}: expected one placeholder in each language`);
}
for (const id of pending.keys()) {
  if (!english?.has(id)) errors.push(`${id}: placeholder absent from screenshot checklist`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Wiki checks passed: ${pages.length} Markdown files, ${pending.size} screenshot topics.`);
}
