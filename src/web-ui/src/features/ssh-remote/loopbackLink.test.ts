import { describe, expect, it } from 'vitest';
import { parseLoopbackLink, rewriteLoopbackLink, sameRemoteHost } from './loopbackLink';

describe('parseLoopbackLink', () => {
  it.each([
    ['http://127.0.0.1:5173/', 5173, '127.0.0.1'],
    ['http://localhost:3000/app', 3000, 'localhost'],
    ['http://localhost.:3000/app', 3000, 'localhost'],
    ['https://0.0.0.0:8443', 8443, '127.0.0.1'],
    ['http://[::1]:8080/x', 8080, '::1'],
    ['http://app.localhost:4000', 4000, 'localhost'],
    ['http://127.1.2.3:9000', 9000, '127.1.2.3'],
  ])('recognizes %s', (uri, port, remoteHost) => {
    const link = parseLoopbackLink(uri);
    expect(link?.remotePort).toBe(port);
    expect(link?.remoteHost).toBe(remoteHost);
  });

  it.each(['http://localhost/', 'http://127.0.0.1:80/', 'https://localhost./'])(
    'recognizes %s without an explicit port',
    (uri) => {
      const link = parseLoopbackLink(uri);
      expect(link).not.toBeNull();
      expect(link?.remotePort).toBeNull();
    },
  );

  it.each([
    'https://example.com:3000',
    'ftp://127.0.0.1:21',
    'http://10.0.0.1:3000',
    'not a url',
  ])('ignores %s', (uri) => {
    expect(parseLoopbackLink(uri)).toBeNull();
  });
});

describe('rewriteLoopbackLink', () => {
  it('always uses the bound address, keeping path, query and hash', () => {
    const link = parseLoopbackLink('http://localhost:5173/a/b?x=1#frag')!;
    expect(rewriteLoopbackLink(link, '127.0.0.1', 5174)).toBe('http://127.0.0.1:5174/a/b?x=1#frag');
    const sub = parseLoopbackLink('http://app.localhost:5173/')!;
    expect(rewriteLoopbackLink(sub, '127.0.0.1', 5173)).toBe('http://127.0.0.1:5173/');
  });

  it('maps other loopback spellings to the bound address', () => {
    const link = parseLoopbackLink('http://0.0.0.0:3000/p')!;
    expect(rewriteLoopbackLink(link, '127.0.0.1', 3000)).toBe('http://127.0.0.1:3000/p');
    const v6 = parseLoopbackLink('http://[::1]:3000/')!;
    expect(rewriteLoopbackLink(v6, '0.0.0.0', 40001)).toBe('http://127.0.0.1:40001/');
  });
});

describe('sameRemoteHost', () => {
  it('matches exactly or localhost with 127.0.0.1 only', () => {
    expect(sameRemoteHost('127.0.0.1', 'localhost')).toBe(true);
    expect(sameRemoteHost('127.1.2.3', '127.1.2.3')).toBe(true);
    expect(sameRemoteHost('[::1]', '::1')).toBe(true);
    expect(sameRemoteHost('127.0.0.1', '::1')).toBe(false);
    expect(sameRemoteHost('127.0.0.1', '127.1.2.3')).toBe(false);
  });
});
