import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-bash';
import { splitTokensByNewlines } from '../components/inlineDiffTokens';

self.onmessage = (event: MessageEvent<{ id: number; content: string; language: string }>) => {
  const { id, content, language } = event.data;
  try {
    const grammar = Prism.languages[language];
    const lines = grammar ? splitTokensByNewlines(Prism.tokenize(content, grammar)) : content.split('\n').map(line => [line]);
    self.postMessage({ id, lines });
  } catch {
    self.postMessage({ id, lines: content.split('\n').map(line => [line]) });
  }
};
