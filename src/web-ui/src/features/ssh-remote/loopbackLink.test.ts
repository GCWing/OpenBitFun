import { describe, expect, it } from 'vitest';
import { isLoopbackRemoteHost, parseLoopbackLink, rewriteLoopbackLink } from './loopbackLink';

describe('parseLoopbackLink', () => {
  it.each([
    ['http://127.0.0.1:5173/', 5173, '127.0.0.1'],
    ['http://localhost:3000/app', 3000, 'localhost'],
    ['https://0.0.0.0:8443', 8443, '127.0.0.1'],
    ['http://[::1]:8080/x', 8080, '::1'],
    ['http://app.localhost:4000', 4000, 'localhost'],
    ['http://127.1.2.3:9000', 9000, '127.1.2.3'],
  ])('recognizes %s', (uri, port, remoteHost) => {
    const link = parseLoopbackLink(uri);
    expect(link?.remotePort).toBe(port);
    expect(link?.remoteHost).toBe(remoteHost);
  });

  it.each([
    'http://localhost/',
    'http://127.0.0.1:80/',
    'https://example.com:3000',
    'ftp://127.0.0.1:21',
    'http://10.0.0.1:3000',
    'not a url',
  ])('ignores %s', (uri) => {
    expect(parseLoopbackLink(uri)).toBeNull();
  });
});

describe('rewriteLoopbackLink', () => {
  it('keeps localhost names and path, query and hash', () => {
    const link = parseLoopbackLink('http://localhost:5173/a/b?x=1#frag')!;
    expect(rewriteLoopbackLink(link, '127.0.0.1', 5174)).toBe('http://localhost:5174/a/b?x=1#frag');
  });

  it('maps other loopback spellings to the bound address', () => {
    const link = parseLoopbackLink('http://0.0.0.0:3000/p')!;
    expect(rewriteLoopbackLink(link, '127.0.0.1', 3000)).toBe('http://127.0.0.1:3000/p');
    const v6 = parseLoopbackLink('http://[::1]:3000/')!;
    expect(rewriteLoopbackLink(v6, '0.0.0.0', 40001)).toBe('http://127.0.0.1:40001/');
  });
});

describe('isLoopbackRemoteHost', () => {
  it('accepts loopback remote hosts only', () => {
    expect(isLoopbackRemoteHost('127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteHost('localhost')).toBe(true);
    expect(isLoopbackRemoteHost('db.internal')).toBe(false);
  });
});
