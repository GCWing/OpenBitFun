import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { markdownGfmOptions } from './markdownGfmOptions';

const parser = unified().use(remarkParse).use(remarkGfm, markdownGfmOptions);
self.onmessage = (event: MessageEvent<string>) => {
  try { self.postMessage({ tree: parser.parse(event.data) }); }
  catch { self.postMessage({}); }
};
