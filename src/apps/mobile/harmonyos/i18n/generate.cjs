// Build-time i18n rawfile catalog; generated resources are not edited.
//
// Merges the en_US and zh_CN element string catalogs into the single
// rawfile document HostTextRetranslator reads: English entries keep the
// resource name as-is, Chinese entries gain a ".zh" suffix that
// HostTextRetranslator.splitEntryLanguage recognizes as the language tag.
const fs = require('node:fs');
const path = require('node:path');

const resources = path.resolve(__dirname, '../entry/src/main/resources');
const output = path.join(resources, 'rawfile', 'string.json');

function readElementCatalog(locale) {
  const file = path.join(resources, locale, 'element', 'string.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(catalog.string)) {
    throw new Error(`Expected a "string" array in ${locale}/element/string.json`);
  }
  return catalog.string;
}

// HostTextRetranslator.splitEntryLanguage treats a trailing dot segment of
// 2-3 lowercase letters as a language tag, so an English catalog name like
// "time.pm" would be misfiled as language "pm". HarmonyOS element names are
// [a-zA-Z0-9_] today; this guard keeps a future dotted name from silently
// corrupting the catalog instead of failing the build loudly.
function assertUntaggedEnglishNames(names) {
  for (const name of names) {
    const lastDot = name.lastIndexOf('.');
    if (lastDot < 0) {
      continue;
    }
    const suffix = name.slice(lastDot + 1);
    if (suffix.length >= 2 && suffix.length <= 3 && suffix.toLowerCase() === suffix) {
      throw new Error(`English catalog name "${name}" would be parsed as language "${suffix}"; rename it`);
    }
  }
}

function assertKeyLockstep(english, chinese) {
  const englishNames = new Set(english.map((entry) => entry.name));
  const chineseNames = new Set(chinese.map((entry) => entry.name));
  for (const entry of english) {
    if (!chineseNames.has(entry.name)) {
      throw new Error(`en_US catalog key "${entry.name}" is missing from zh_CN`);
    }
  }
  for (const entry of chinese) {
    if (!englishNames.has(entry.name)) {
      throw new Error(`zh_CN catalog key "${entry.name}" is missing from en_US`);
    }
  }
}

function generate() {
  const english = readElementCatalog('en_US');
  const chinese = readElementCatalog('zh_CN');
  assertKeyLockstep(english, chinese);
  assertUntaggedEnglishNames(english.map((entry) => entry.name));
  const entries = english.concat(
    chinese.map((entry) => ({ name: `${entry.name}.zh`, value: entry.value }))
  );
  const contents = JSON.stringify({ string: entries }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== contents) {
    fs.writeFileSync(output, contents);
  }
}

module.exports = { generate };
if (require.main === module) generate();
