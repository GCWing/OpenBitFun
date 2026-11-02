import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { subscriptionProviderServices, SUBSCRIPTION_FIXTURE_HOSTS } from './subscription-provider-services.mjs';

/** External-service fixture only. It never selects an OpenBitFun candidate. */
export async function createPoolProvider(root, workspace) {
  const certificate = path.join(root, 'fixture-ca.pem');
  const rootKey = path.join(root, 'fixture-ca.key');
  const key = path.join(root, 'fixture-server.key');
  const serverCertificate = path.join(root, 'fixture-server.pem');
  const csr = path.join(root, 'fixture-server.csr');
  const extensions = path.join(root, 'fixture-server.ext');
  const openssl = args => {
    const generated = spawnSync('openssl', args, { windowsHide: true, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
  };
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', rootKey, '-out', certificate,
    '-days', '1', '-subj', '/CN=OpenBitFun isolated fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=auth.openai.com']);
  await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName='
    + SUBSCRIPTION_FIXTURE_HOSTS.map(host => 'DNS:' + host).join(',') + '\n');
  openssl(['x509', '-req', '-in', csr, '-CA', certificate, '-CAkey', rootKey, '-CAcreateserial',
    '-out', serverCertificate, '-days', '1', '-sha256', '-extfile', extensions]);
  const requests = [];
  const sockets = new Set();
  let initialRequests = 0;
  let backupRequests = 0;
  let phase = 'first';
  let cancelledStreams = 0;
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const stream = (res, events, anthropic = false) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`${anthropic ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
    res.end();
  };
  const services = subscriptionProviderServices(json, stream);
  const response = (text, tool, name = 'Read', call = 'read-once') => {
    const output = tool ? [{ type: 'function_call', id: `item-${call}`, call_id: call, name, arguments: JSON.stringify(tool) }] : [];
    return [
      ...(tool ? [
        { type: 'response.output_item.added', output_index: 0, item: { ...output[0], arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: output[0].arguments },
        { type: 'response.output_item.done', output_index: 0, item: output[0] },
      ] : [{ type: 'response.output_text.delta', delta: text }]),
      { type: 'response.completed', response: { id: `initial-${initialRequests}`, model: 'mock-codex-snapshot', output,
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
    ];
  };
  const anthropic = tool => [
    { type: 'message_start', message: { id: `backup-${backupRequests}`, type: 'message', role: 'assistant', model: 'mock-anthropic-snapshot', usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool
      ? { type: 'tool_use', id: 'append-once', name: 'ExecCommand', input: {} }
      : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify({ cmd: "printf 'pool-mutation\\n' >> pool-output.txt", workdir: workspace }) }
      : { type: 'text_delta', text: 'POOL_COMPLETE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  const signed = () => [
    { type: 'message_start', message: { id: 'signed-response', type: 'message', role: 'assistant', model: 'mock-anthropic-snapshot', usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture signed reasoning' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'mock-signed-state' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'POOL_SIGNED_COMPLETE' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  async function handle(req, res) {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url, `https://${req.headers.host}`);
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); } })() : {};
      if (services.handle(req, res, url, body)) return;
      if (url.pathname === '/oauth/token') {
        const seat = body.code === 'mock-seat-two' ? 'seat-two' : 'seat-one';
        const claims = { email: `${seat}@fixture.invalid`, exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: seat } };
        const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
        return json(res, 200, { access_token: token, id_token: token, refresh_token: `synthetic-refresh-${seat}`, expires_in: 3600 });
      }
      if (url.pathname === '/backend-api/wham/usage') return json(res, 200, { plan_type: 'fixture', rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600 } }, credits: { has_credits: false } });
      if (url.pathname.endsWith('/models')) return json(res, 200, { models: [] });
      const channel = url.pathname === '/backend-api/codex/responses' ? 'subscription-channel'
        : url.pathname === '/key-one' ? 'key-one' : url.pathname === '/key-two' ? 'key-two' : null;
      if (!channel) return json(res, 502, { error: { message: `External route not implemented by isolated fixture: ${url.pathname}` } });
      const toolNames = (body.tools ?? []).map(tool => tool.name ?? tool.function?.name);
      if (!toolNames.includes('Read') && !toolNames.includes('ExecCommand')) {
        if (channel === 'subscription-channel') return stream(res, toolNames.includes('get_weather')
          ? response('', { city: 'Beijing' }, 'get_weather', 'connection-check')
          : response('Fixture auxiliary response', null));
        return stream(res, anthropic(false), true);
      }
      const seat = req.headers['chatgpt-account-id'] ?? null;
      requests.push({ phase, channel, seat, key: req.headers['x-api-key'] ?? null, body });
      if (phase === 'hold') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': waiting for the user to cancel\n\n');
        res.on('close', () => { cancelledStreams++; });
        return;
      }
      if (phase === 'partial') {
        if (channel === 'subscription-channel') return stream(res, [
          { type: 'response.output_text.delta', delta: 'POOL_PARTIAL_OUTPUT' },
          { type: 'response.failed', response: { id: 'partial-rejection', error: { code: 'insufficient_quota', message: 'Fixture quota exhausted after output' } } },
        ]);
        return stream(res, [
          ...anthropic(false).slice(0, 2),
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'POOL_PARTIAL_OUTPUT' } },
          { type: 'error', error: { type: 'insufficient_quota', message: 'Fixture quota exhausted after output' } },
        ], true);
      }
      if (phase === 'healthy') {
        if (channel === 'subscription-channel') return stream(res, response('POOL_HEALTHY_COMPLETE', null));
        return stream(res, anthropic(false).map(event => event.type === 'content_block_delta'
          ? { ...event, delta: { type: 'text_delta', text: 'POOL_HEALTHY_COMPLETE' } } : event), true);
      }
      if (phase === 'first' && channel === 'subscription-channel') {
        initialRequests++;
        return stream(res, response('POOL_FIRST_COMPLETE', initialRequests === 1 ? { file_path: path.join(workspace, 'seed.txt') } : null));
      }
      if (channel !== 'key-two' || phase === 'denied') return json(res, 402, { error: { code: 'insufficient_quota', message: 'Fixture quota exhausted' } });
      if (phase === 'signed') return stream(res, signed(), true);
      backupRequests++;
      return stream(res, anthropic(backupRequests === 1), true);
    } catch (error) { json(res, 500, { error: { message: String(error) } }); }
  }
  const tls = https.createServer({ key: await readFile(key), cert: await readFile(serverCertificate) }, handle);
  tls.listen(0, '127.0.0.1'); await once(tls, 'listening');
  const proxy = http.createServer(handle);
  proxy.on('connect', (req, client, head) => {
    if (!services.hosts.map(host => host + ':443').includes(req.url)) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = net.connect(tls.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  for (const server of [tls, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  return { services, certificate, url: `http://127.0.0.1:${proxy.address().port}`, requests,
    continue() { phase = 'continue'; },
    deny() { phase = 'denied'; },
    signed() { phase = 'signed'; },
    hold() { phase = 'hold'; },
    partial() { phase = 'partial'; },
    healthy() { phase = 'healthy'; },
    get cancelledStreams() { return cancelledStreams; },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([tls, proxy].map(server => new Promise(resolve => server.close(resolve)))); },
  };
}
