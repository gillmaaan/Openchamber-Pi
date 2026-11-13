import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionMetaStore } from './session-meta-store.js';

const dirs = [];
const makeStore = (options = {}) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-meta-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'pi', 'sessions-meta.json');
  return { dir, filePath, store: createSessionMetaStore({ filePath, ...options }) };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('session meta store', () => {
  it('keeps a record across a new store instance on the same file', async () => {
    const { filePath, store } = makeStore();
    await store.patch('ses_a', { archivedAt: 5, metadata: { pinned: true } });

    const again = createSessionMetaStore({ filePath });
    expect(again.get('ses_a')).toEqual({ archivedAt: 5, metadata: { pinned: true } });
  });

  it('merges fields, replaces values whole and removes a key set to null', async () => {
    const { store } = makeStore();
    await store.patch('ses_a', { archivedAt: 5, metadata: { a: 1 }, agent: 'build' });
    await store.patch('ses_a', { metadata: { b: 2 }, archivedAt: null });

    expect(store.get('ses_a')).toEqual({ metadata: { b: 2 }, agent: 'build' });
  });

  it('drops a record that has no fields left', async () => {
    const { store } = makeStore();
    await store.patch('ses_a', { agent: 'build' });
    await store.patch('ses_a', { agent: undefined });
    expect(store.get('ses_a')).toBeNull();
    expect(store.all()).toEqual({});
  });

  it('does not lose concurrent patches to different fields', async () => {
    const { filePath, store } = makeStore();
    await Promise.all([
      store.patch('ses_a', { archivedAt: 1 }),
      store.patch('ses_a', { viewedAt: 2 }),
      store.patch('ses_b', { agent: 'plan' }),
    ]);
    const reloaded = createSessionMetaStore({ filePath });
    expect(reloaded.get('ses_a')).toEqual({ archivedAt: 1, viewedAt: 2 });
    expect(reloaded.get('ses_b')).toEqual({ agent: 'plan' });
  });

  it('lists sessions that exist only as drafts', async () => {
    const { store } = makeStore();
    await store.patch('ses_draft', { draft: { directory: '/work/a', createdAt: 10 }, title: 'New' });
    await store.patch('ses_other', { agent: 'build' });
    expect(store.drafts()).toEqual([{ id: 'ses_draft', directory: '/work/a', createdAt: 10 }]);

    await store.patch('ses_draft', { draft: null });
    expect(store.drafts()).toEqual([]);
  });

  it('removes a record and reports whether there was one', async () => {
    const { store } = makeStore();
    await store.patch('ses_a', { agent: 'build' });
    expect(await store.remove('ses_a')).toBe(true);
    expect(await store.remove('ses_a')).toBe(false);
  });

  it('sets a corrupt file aside and starts empty instead of failing', async () => {
    const { dir, filePath, store: first } = makeStore({ now: () => 99 });
    await first.patch('ses_a', { agent: 'build' });
    fs.writeFileSync(filePath, '{ not json');

    const store = createSessionMetaStore({ filePath, now: () => 99 });
    expect(store.get('ses_a')).toBeNull();
    expect(fs.existsSync(`${filePath}.corrupt-99`)).toBe(true);
    await store.patch('ses_b', { agent: 'plan' });
    expect(createSessionMetaStore({ filePath }).get('ses_b')).toEqual({ agent: 'plan' });
    expect(fs.readdirSync(path.join(dir, 'pi')).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('treats a file from another format version as unreadable', async () => {
    const { filePath } = makeStore();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, sessions: { ses_a: { agent: 'x' } } }));
    expect(createSessionMetaStore({ filePath }).get('ses_a')).toBeNull();
  });
});
