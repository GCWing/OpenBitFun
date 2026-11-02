import { util } from '@kit.ArkTS';
import { fillMessageTemplate } from './MessageTemplate';

interface TemplateEntry {
  key: string;
  template: string;
}

interface StringEntry {
  name: string;
  value: string;
}

interface StringCatalog {
  string: StringEntry[];
}

interface EntryLanguage {
  key: string;
  language: string;
}

// Retranslates catalog-backed host text across the app catalog languages.
//
// The rawfile catalog keeps every language in one document: a trailing
// 2-3 letter lowercase dot segment (for example "common.back.zh") tags the
// entry language, and untagged entries are the generator's English block.
//
// Reverse indexes recover the catalog key; rendering always uses the requested
// language. Already localized messages therefore remain stable across refreshes.
//
// Values that several keys share in one language cannot identify their key,
// so ambiguous values are refused rather than guessed, like the legacy
// retranslate policy.
export class HostTextRetranslator {
  private currentLanguage: string = 'en';
  private languages: string[] = [];
  private forwardByLanguage: Map<string, Map<string, string>> = new Map();
  private reverseByLanguage: Map<string, Map<string, string>> = new Map();
  private ambiguousByLanguage: Map<string, Set<string>> = new Map();
  private templatesByLanguage: Map<string, TemplateEntry[]> = new Map();

  constructor(locale: string) {
    this.currentLanguage = this.languageTag(locale);
    this.loadCatalog();
  }

  retranslate(message: string): string {
    if (message.length === 0) {
      return message;
    }

    // 1. Exact match per language O(1)
    for (let languageIndex = 0; languageIndex < this.languages.length; languageIndex += 1) {
      const language = this.languages[languageIndex];
      const reverse = this.reverseByLanguage.get(language);
      if (!reverse) {
        continue;
      }
      const exactKey = reverse.get(message);
      if (exactKey !== undefined) {
        const translated = this.renderEntry(exactKey);
        if (translated !== null) {
          return translated;
        }
      }
    }

    // Prefer the most specific template; an equal-specificity disagreement
    // cannot identify a key safely and leaves the original message intact.
    let best: string | null = null;
    let bestSpecificity = -1;
    let ambiguous = false;
    // 2. Template match per language O(M)
    for (let languageIndex = 0; languageIndex < this.languages.length; languageIndex += 1) {
      const language = this.languages[languageIndex];
      const templates = this.templatesByLanguage.get(language);
      if (!templates) {
        continue;
      }
      for (let templateIndex = 0; templateIndex < templates.length; templateIndex += 1) {
        const entry = templates[templateIndex];
        const matched = this.matchTemplate(entry.template, message);
        if (matched !== null) {
          const translated = this.renderTemplate(entry, matched);
          if (translated !== null) {
            const specificity = entry.template.replace(/%[12]\$s/g, '').length;
            if (specificity > bestSpecificity) {
              best = translated;
              bestSpecificity = specificity;
              ambiguous = false;
            } else if (specificity === bestSpecificity && best !== translated) {
              ambiguous = true;
            }
          }
        }
      }
    }

    return best !== null && !ambiguous ? best : message;
  }

  retranslateKnown(message: string, keys: string[]): string {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index].replace(/\./g, '_');
      for (let languageIndex = 0; languageIndex < this.languages.length; languageIndex += 1) {
        const language = this.languages[languageIndex];
        const template = this.forwardByLanguage.get(language)?.get(key);
        if (template === undefined) {
          continue;
        }
        if (template === message) {
          return this.renderEntry(key) ?? message;
        }
        const matched = this.matchTemplate(template, message);
        if (matched !== null) {
          return this.renderTemplate({ key, template }, matched) ?? message;
        }
      }
    }
    return message;
  }

  private loadCatalog(): void {
    try {
      const resourceManager = getContext(this).resourceManager;
      // Rawfile paths are relative to the resources/rawfile root, and the
      // content arrives as UTF-8 bytes. Decode multi-byte catalog text with
      // TextDecoder instead of per-byte fromCharCode, which mangles it.
      const rawResource = resourceManager.getRawFileContentSync('string.json');
      const jsonString = util.TextDecoder.create('utf-8').decodeWithStream(rawResource);
      const catalog = JSON.parse(jsonString) as StringCatalog;
      const strings = catalog.string || [];

      for (let index = 0; index < strings.length; index += 1) {
        const entry = strings[index];
        const tagged = this.splitEntryLanguage(entry.name);
        this.ensureLanguage(tagged.language);
        const forward = this.forwardByLanguage.get(tagged.language);
        const reverse = this.reverseByLanguage.get(tagged.language);
        const ambiguous = this.ambiguousByLanguage.get(tagged.language);
        const templates = this.templatesByLanguage.get(tagged.language);
        if (!forward || !reverse || !ambiguous || !templates) {
          continue;
        }
        forward.set(tagged.key, entry.value);
        const existingKey = reverse.get(entry.value);
        if (existingKey !== undefined) {
          if (existingKey !== tagged.key) {
            // A second key shares this value within the language, so the
            // value cannot identify its key: refuse it instead of letting
            // the later entry win like a plain overwrite would.
            ambiguous.add(entry.value);
            reverse.delete(entry.value);
          }
        } else if (!ambiguous.has(entry.value)) {
          reverse.set(entry.value, tagged.key);
        }
        if (entry.value.indexOf('%1$s') >= 0 || entry.value.indexOf('%2$s') >= 0) {
          templates.push({ key: tagged.key, template: entry.value });
        }
      }
      this.pruneAmbiguousTemplates();
    } catch (error) {
      // Fallback: catalog unavailable, retranslate returns original message
    }
  }

  // A template is trustworthy only when its key's value is unique in every
  // catalog language: one shared value in any language leaves the template
  // shape unable to identify its key. Refuse such templates in every
  // language, matching the legacy hasUniqueTemplate gate.
  private pruneAmbiguousTemplates(): void {
    for (let languageIndex = 0; languageIndex < this.languages.length; languageIndex += 1) {
      const language = this.languages[languageIndex];
      const templates = this.templatesByLanguage.get(language);
      if (!templates) {
        continue;
      }
      const kept: TemplateEntry[] = [];
      for (let templateIndex = 0; templateIndex < templates.length; templateIndex += 1) {
        const entry = templates[templateIndex];
        if (!this.hasAmbiguousTemplate(entry.key)) {
          kept.push(entry);
        }
      }
      this.templatesByLanguage.set(language, kept);
    }
  }

  private hasAmbiguousTemplate(key: string): boolean {
    for (let languageIndex = 0; languageIndex < this.languages.length; languageIndex += 1) {
      const language = this.languages[languageIndex];
      const forward = this.forwardByLanguage.get(language);
      const ambiguous = this.ambiguousByLanguage.get(language);
      if (!forward || !ambiguous) {
        return true;
      }
      const value = forward.get(key);
      if (value === undefined || ambiguous.has(value)) {
        return true;
      }
    }
    return false;
  }

  private ensureLanguage(language: string): void {
    if (this.forwardByLanguage.has(language)) {
      return;
    }
    this.forwardByLanguage.set(language, new Map());
    this.reverseByLanguage.set(language, new Map());
    this.ambiguousByLanguage.set(language, new Set<string>());
    this.templatesByLanguage.set(language, []);
    this.languages.push(language);
  }

  private languageTag(locale: string): string {
    const primary = locale.split('-')[0].toLowerCase();
    return primary.length > 0 ? primary : 'en';
  }

  private splitEntryLanguage(name: string): EntryLanguage {
    const lastDot = name.lastIndexOf('.');
    if (lastDot >= 0) {
      const suffix = name.slice(lastDot + 1);
      if (suffix.length >= 2 && suffix.length <= 3 && suffix.toLowerCase() === suffix) {
        return { key: name.slice(0, lastDot), language: suffix };
      }
    }
    // Untagged entries are the generator's English block.
    return { key: name, language: 'en' };
  }

  private renderEntry(baseKey: string): string | null {
    const forward = this.forwardByLanguage.get(this.currentLanguage);
    if (!forward) {
      return null;
    }
    const value = forward.get(baseKey);
    return value !== undefined ? value : null;
  }

  private renderTemplate(entry: TemplateEntry, matched: string[]): string | null {
    const forward = this.forwardByLanguage.get(this.currentLanguage);
    if (!forward) {
      return null;
    }
    const template = forward.get(entry.key);
    if (template === undefined) {
      return null;
    }
    return fillMessageTemplate(template, matched);
  }

  private matchTemplate(template: string, message: string): string[] | null {
    // Parse %1$s and %2$s placeholders
    const firstSlot = template.indexOf('%1$s');
    if (firstSlot < 0) {
      return null;
    }

    const prefix = template.slice(0, firstSlot);
    const afterFirst = template.slice(firstSlot + 4);
    const secondSlot = afterFirst.indexOf('%2$s');

    if (secondSlot < 0) {
      // Single placeholder: %1$s
      const suffix = afterFirst;
      if (!message.startsWith(prefix) || !message.endsWith(suffix)) {
        return null;
      }
      const value = message.slice(prefix.length, message.length - suffix.length);
      return [value];
    }

    // Two placeholders: %1$s and %2$s
    const middle = afterFirst.slice(0, secondSlot);
    const suffix = afterFirst.slice(secondSlot + 4);
    if (!message.startsWith(prefix) || !message.endsWith(suffix)) {
      return null;
    }
    const body = message.slice(prefix.length, message.length - suffix.length);
    const middleAt = body.indexOf(middle);
    if (middleAt < 0) {
      return null;
    }
    const first = body.slice(0, middleAt);
    const second = body.slice(middleAt + middle.length);
    return [first, second];
  }
}
