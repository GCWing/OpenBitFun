import { util } from '@kit.ArkTS';

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
// entry language, and untagged entries belong to the locale language passed
// to the constructor.
//
// Per-language reverse indexes identify which catalog language a stored
// message was rendered in; the matched key is then re-rendered in the output
// language: the constructor language when the message matches another
// catalog language, and otherwise the first other catalog language. That way
// a stored string never re-renders in the language it matched.
export class HostTextRetranslator {
  private currentLanguage: string = 'en';
  private languages: string[] = [];
  private forwardByLanguage: Map<string, Map<string, string>> = new Map();
  private reverseByLanguage: Map<string, Map<string, string>> = new Map();
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
        const translated = this.renderEntry(exactKey, language);
        if (translated !== null) {
          return translated;
        }
      }
    }

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
          const translated = this.renderTemplate(entry, language, matched);
          if (translated !== null) {
            return translated;
          }
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
        const templates = this.templatesByLanguage.get(tagged.language);
        if (!forward || !reverse || !templates) {
          continue;
        }
        forward.set(tagged.key, entry.value);
        reverse.set(entry.value, tagged.key);
        if (entry.value.indexOf('%1$s') >= 0 || entry.value.indexOf('%2$s') >= 0) {
          templates.push({ key: tagged.key, template: entry.value });
        }
      }
    } catch (error) {
      // Fallback: catalog unavailable, retranslate returns original message
    }
  }

  private ensureLanguage(language: string): void {
    if (this.forwardByLanguage.has(language)) {
      return;
    }
    this.forwardByLanguage.set(language, new Map());
    this.reverseByLanguage.set(language, new Map());
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
    return { key: name, language: this.currentLanguage };
  }

  private outputLanguageFor(sourceLanguage: string): string {
    if (sourceLanguage !== this.currentLanguage && this.forwardByLanguage.has(this.currentLanguage)) {
      return this.currentLanguage;
    }
    for (let index = 0; index < this.languages.length; index += 1) {
      const language = this.languages[index];
      if (language !== sourceLanguage) {
        return language;
      }
    }
    return sourceLanguage;
  }

  private renderEntry(baseKey: string, sourceLanguage: string): string | null {
    const forward = this.forwardByLanguage.get(this.outputLanguageFor(sourceLanguage));
    if (!forward) {
      return null;
    }
    const value = forward.get(baseKey);
    return value !== undefined ? value : null;
  }

  private renderTemplate(entry: TemplateEntry, sourceLanguage: string, matched: string[]): string | null {
    const forward = this.forwardByLanguage.get(this.outputLanguageFor(sourceLanguage));
    if (!forward) {
      return null;
    }
    const template = forward.get(entry.key);
    if (template === undefined) {
      return null;
    }
    if (matched.length === 1) {
      return template.replace('%1$s', matched[0]);
    }
    return template.replace('%1$s', matched[0]).replace('%2$s', matched[1]);
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
