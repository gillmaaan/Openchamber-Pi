import http from 'node:http';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { HindsightError, parseBank, parseEntry, parsePage, parseSettings, parseStats, record, type Resource } from './model.ts';

const MAX_RESPONSE = 4_000_000;
const MAX_BODY = 200_000;

export const readConnection = async (home = os.homedir()) => {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(home, '.hindsight/coding-agent.json'), 'utf8')); }
  catch (error) {
    throw new HindsightError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'configMissing' : 'configInvalid', 503);
  }
  try {
    const base = record(raw);
    const harnesses = base.harnesses == null ? {} : record(base.harnesses);
    const config = { ...base, ...(harnesses.pi == null ? {} : record(harnesses.pi)) };
    if (typeof config.apiUrl !== 'string') throw new Error();
    const url = new URL(config.apiUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error();
    if (config.apiToken != null && typeof config.apiToken !== 'string') throw new Error();
    return { url: url.href.replace(/\/+$/, ''), token: typeof config.apiToken === 'string' ? config.apiToken : '' };
  } catch { throw new HindsightError('configInvalid', 503); }
};

const boundedText = async (response: Response): Promise<string> => {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel();
    throw new HindsightError('tooLarge');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE) throw new HindsightError('tooLarge');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
};

const inputText = (value: unknown, max = 100_000): string => {
  if (typeof value !== 'string' || value.length > max) throw new HindsightError('invalidRequest', 400);
  return value;
};
const identifier = (value: string): string => {
  if (!value || value === '.' || value === '..' || Array.from(value).some((char) => char.charCodeAt(0) < 32) || value.length > 2048) throw new HindsightError('invalidRequest', 400);
  return encodeURIComponent(value);
};
const pageOffset = (value: string | null): string => {
  if (value === null) return '0';
  if (!/^\d{1,8}$/.test(value)) throw new HindsightError('invalidRequest', 400);
  return value;
};

export const createHindsightAPI = ({ home = os.homedir(), fetcher = fetch }: { home?: string; fetcher?: typeof fetch } = {}) => {
  const upstream = async (suffix: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const connection = await readConnection(home);
    let response: Response;
    try {
      response = await fetcher(`${connection.url}/v1/default/banks${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json', ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HindsightError('unavailable', 503); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HindsightError(response.status === 401 || response.status === 403 ? 'unauthorized' : 'upstream', response.status === 401 || response.status === 403 ? 502 : response.status === 404 ? 404 : 502);
    }
    const result = await boundedText(response);
    if (!result) return null;
    try { return JSON.parse(result); } catch { throw new HindsightError('invalidResponse'); }
  };

  return async (method: string, url: URL, body: unknown = null): Promise<unknown> => {
    if (method === 'GET' && url.pathname === '/connection') {
      const connection = await readConnection(home);
      return { endpoint: connection.url };
    }
    const q = inputText(url.searchParams.get('q') ?? '', 1000);
    const query = new URLSearchParams({ limit: '50', offset: pageOffset(url.searchParams.get('offset')) });
    if (q) query.set('q', q);
    if (method === 'GET' && url.pathname === '/banks') return parsePage(await upstream(`?${query}`), parseBank, 'banks');
    const parts = url.pathname.split('/').slice(1).map((part) => {
      try { return decodeURIComponent(part); } catch { throw new HindsightError('invalidRequest', 400); }
    });
    if (parts[0] !== 'banks' || !parts[1] || parts.length < 3 || parts.length > 4) throw new HindsightError('invalidRequest', 400);
    const bank = `/${identifier(parts[1])}`;
    const resource = parts[2];
    if (parts.length === 3 && resource === 'stats' && method === 'GET') return parseStats(await upstream(`${bank}/stats`));
    if (parts.length === 3 && resource === 'settings') {
      if (method === 'GET') return parseSettings(await upstream(`${bank}/config`));
      if (method === 'PATCH') {
        const v = record(body);
        if (Object.keys(v).some((k) => k !== 'reflect_mission' && k !== 'retain_mission')) throw new HindsightError('invalidRequest', 400);
        const update = { reflect_mission: inputText(v.reflect_mission, 16000), retain_mission: inputText(v.retain_mission, 16000) };
        return parseSettings(await upstream(`${bank}/config`, 'PATCH', { updates: update }));
      }
    }
    if (resource !== 'memories' && resource !== 'documents' && resource !== 'pages') throw new HindsightError('invalidRequest', 400);
    const kind: Resource = resource;
    const target = kind === 'pages' ? 'mental-models' : kind;
    if (parts.length === 3 && method === 'GET') {
      if (kind === 'pages') query.delete('q');
      if (kind === 'memories') {
        const state = url.searchParams.get('state') ?? 'valid';
        if (state !== 'valid' && state !== 'invalidated') throw new HindsightError('invalidRequest', 400);
        query.set('state', state);
      }
      const suffix = kind === 'memories' ? '/memories/list' : `/${target}`;
      return parsePage(await upstream(`${bank}${suffix}?${query}`), (value) => parseEntry(kind, value));
    }
    if (parts.length !== 4) throw new HindsightError('invalidRequest', 400);
    const item = `${bank}/${target}/${identifier(parts[3])}`;
    if (method === 'GET') return parseEntry(kind, await upstream(item));
    if (method === 'DELETE' && kind === 'documents') {
      const result = record(await upstream(item, 'DELETE'));
      if (result.success !== true) throw new HindsightError('invalidResponse');
      return { deleted: true };
    }
    if (method === 'PATCH' && kind === 'memories') {
      const v = record(body);
      if (Object.keys(v).some((k) => !['text', 'context', 'state'].includes(k))) throw new HindsightError('invalidRequest', 400);
      const update: { text: string; context: string } | { state: string } | null = v.state === undefined
        ? { text: inputText(v.text), context: inputText(v.context) }
        : v.state === 'invalidated' || v.state === 'valid' ? { state: v.state } : null;
      if (!update || ('text' in update && !update.text.trim())) throw new HindsightError('invalidRequest', 400);
      await upstream(item, 'PATCH', update);
      return { saved: true };
    }
    throw new HindsightError('invalidRequest', 400);
  };
};

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

export const createService = ({ token, api = createHindsightAPI() }: { token: string; api?: ReturnType<typeof createHindsightAPI> }) => http.createServer(async (req, res) => {
  const received = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (!token || received.length !== expected.length || !timingSafeEqual(received, expected)) { send(res, 401, { code: 'unauthorized' }); return; }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HindsightError('tooLarge', 413);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown = null;
    if (body) {
      try { parsed = JSON.parse(body); } catch { throw new HindsightError('invalidRequest', 400); }
    }
    send(res, 200, await api(req.method ?? 'GET', url, parsed));
  } catch (error) {
    const failure = error instanceof HindsightError ? error : new HindsightError('unavailable', 503);
    send(res, failure.status, { code: failure.code });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
  if (!Number.isInteger(port) || port <= 0 || !token) throw new Error('Missing service credentials');
  createService({ token }).listen(port, '127.0.0.1');
}
