import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyCompactionUpdate, createCompactionSettings, createWebSearchChoiceStore } from './settings.js';

describe('applyCompactionUpdate', () => {
  it('maps auto, keepTokens and a numeric buffer onto Pi\'s settings keys', () => {
    expect(applyCompactionUpdate({}, { auto: false, keepTokens: 5000, buffer: 8000 })).toEqual({
      enabled: false, keepRecentTokens: 5000, reserveTokens: 8000,
    });
  });

  it('null removes a key, falling back to Pi\'s own default', () => {
    expect(applyCompactionUpdate({ keepRecentTokens: 5000 }, { keepTokens: null })).toEqual({});
  });

  it('refuses a percentage share: Pi has no per-model window to resolve it against', () => {
    expect(() => applyCompactionUpdate({}, { buffer: '20%' })).toThrow(/percentage/);
  });
});

describe('createCompactionSettings', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  const makeSettings = () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-compaction-'));
    dirs.push(root);
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    return { settings: createCompactionSettings({ getAgentDir: () => agentDir }), agentDir };
  };

  it('reads Pi\'s own defaults when settings.json has no compaction block', async () => {
    const { settings } = makeSettings();
    expect(await settings.get()).toEqual({ auto: true, keepTokens: null, buffer: null, background: false });
  });

  it('round-trips a write through get()', async () => {
    const { settings, agentDir } = makeSettings();
    await settings.set({ auto: false, keepTokens: 12_000, buffer: 9_000 });
    expect(await settings.get()).toEqual({ auto: false, keepTokens: 12_000, buffer: 9_000, background: false });
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(raw.compaction).toEqual({ enabled: false, keepRecentTokens: 12_000, reserveTokens: 9_000 });
  });

  it('preserves an unrelated key already in settings.json', async () => {
    const { settings, agentDir } = makeSettings();
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic' }));
    await settings.set({ auto: false });
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(raw.defaultProvider).toBe('anthropic');
    expect(raw.compaction.enabled).toBe(false);
  });

  it('a corrupt settings.json is never silently overwritten', async () => {
    const { settings, agentDir } = makeSettings();
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{ not json');
    await expect(settings.set({ auto: false })).rejects.toThrow();
    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).toBe('{ not json');
  });
});

describe('createWebSearchChoiceStore', () => {
  it('round-trips every selection shape, including false and random', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-websearch-'));
    try {
      const store = createWebSearchChoiceStore({ filePath: path.join(root, 'pi', 'websearch.json') });
      expect(await store.get()).toBeNull();
      await store.set(false);
      expect(await store.get()).toBe(false);
      await store.set('random');
      expect(await store.get()).toBe('random');
      await store.set('tavily');
      expect(await store.get()).toBe('tavily');
      await store.set(null);
      expect(await store.get()).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
