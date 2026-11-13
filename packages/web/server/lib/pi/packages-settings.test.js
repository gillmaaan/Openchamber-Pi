import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSettingsWriter,
  filtersOf,
  isDisabledEntry,
  isEnabledByOverrides,
  readSettingsFile,
  withEnabled,
  withExtensionsEnabled,
  withFilters,
  withoutExtensionOverrides,
} from './packages-settings.js';

let root;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-pi-settings-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const OFF = { extensions: [], skills: [], prompts: [], themes: [] };

describe('the enabled switch of a package entry', () => {
  it('turns a plain source into the all-empty form and back', () => {
    const off = withEnabled('npm:pkg', false);
    expect(off).toEqual({ source: 'npm:pkg', ...OFF });
    expect(isDisabledEntry(off)).toBe(true);
    expect(withEnabled(off, true)).toBe('npm:pkg');
  });

  it('is a no-op in the state it already has', () => {
    const plain = 'npm:pkg';
    const off = { source: 'npm:pkg', ...OFF };
    expect(withEnabled(plain, true)).toBe(plain);
    expect(withEnabled(off, false)).toBe(off);
    const narrowed = { source: 'npm:pkg', skills: ['skills/a'] };
    expect(withEnabled(narrowed, true)).toBe(narrowed);
  });

  it('keeps the user\'s own filters while off and restores them', () => {
    const narrowed = { source: 'npm:pkg', extensions: ['extensions/a.js', '!extensions/b.js'], skills: [] };
    const off = withEnabled(narrowed, false);
    expect(off).toEqual({ source: 'npm:pkg', ...OFF, openchamberFilters: { extensions: ['extensions/a.js', '!extensions/b.js'], skills: [] } });
    expect(withEnabled(off, true)).toEqual(narrowed);
  });

  it('keeps keys it does not own, in both directions', () => {
    const entry = { source: 'npm:pkg', autoload: false, note: 'x' };
    const off = withEnabled(entry, false);
    expect(off).toMatchObject({ autoload: false, note: 'x', ...OFF });
    expect(withEnabled(off, true)).toEqual(entry);
  });

  it('does not mutate the entry it was given', () => {
    const entry = { source: 'npm:pkg', skills: ['a'] };
    const copy = structuredClone(entry);
    withEnabled(entry, false);
    expect(entry).toEqual(copy);
  });
});

describe('resource filters', () => {
  it('reads only arrays of strings, and replaces or removes them', () => {
    expect(filtersOf('npm:pkg')).toBeNull();
    expect(filtersOf({ source: 'x' })).toBeNull();
    expect(filtersOf({ source: 'x', skills: ['a'], themes: 'nope', prompts: [1] })).toEqual({ skills: ['a'] });
    expect(withFilters('npm:pkg', { skills: [] })).toEqual({ source: 'npm:pkg', skills: [] });
    expect(withFilters({ source: 'npm:pkg', skills: ['a'], note: 'x' }, { prompts: ['p'] })).toEqual({ source: 'npm:pkg', note: 'x', prompts: ['p'] });
    expect(withFilters({ source: 'npm:pkg', skills: ['a'] }, {})).toBe('npm:pkg');
  });
});

describe('extension overrides', () => {
  const base = '/agent';
  const file = '/agent/extensions/greet.js';

  it('reads the entries pi config writes', () => {
    expect(isEnabledByOverrides(file, [], base)).toBe(true);
    expect(isEnabledByOverrides(file, ['-extensions/greet.js'], base)).toBe(false);
    expect(isEnabledByOverrides(file, ['-./extensions/greet.js'], base)).toBe(false);
    expect(isEnabledByOverrides(file, ['-/agent/extensions/greet.js'], base)).toBe(false);
    expect(isEnabledByOverrides(file, ['-extensions/other.js'], base)).toBe(true);
    expect(isEnabledByOverrides(file, ['!extensions/*.js'], base)).toBe(false);
    expect(isEnabledByOverrides(file, ['!greet.js'], base)).toBe(false);
    expect(isEnabledByOverrides(file, ['!extensions/*.js', '+extensions/greet.js'], base)).toBe(true);
    expect(isEnabledByOverrides(file, ['+extensions/greet.js', '-extensions/greet.js'], base)).toBe(false);
    expect(isEnabledByOverrides(file, ['extensions/other.js'], base)).toBe(true);
    expect(isEnabledByOverrides('/agent/extensions/deep/x.js', ['!extensions/*.js'], base)).toBe(true);
    expect(isEnabledByOverrides('/agent/extensions/deep/x.js', ['!extensions/**'], base)).toBe(false);
  });

  it('matches a crafted glob in linear time instead of backtracking', () => {
    // As a regular expression this takes minutes: a project's own settings file is not trusted input.
    const pattern = `!${'*a'.repeat(30)}*b`;
    const longName = `/agent/extensions/${'a'.repeat(300)}.js`;
    const startedAt = Date.now();
    expect(isEnabledByOverrides(longName, [pattern], base)).toBe(true);
    expect(isEnabledByOverrides(`/agent/extensions/${'a'.repeat(40)}b`, [pattern], base)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
    // Beyond the bounds a pattern does not match.
    expect(isEnabledByOverrides(file, [`!${'x'.repeat(400)}`], base)).toBe(true);
    expect(isEnabledByOverrides(file, [`!${'*'.repeat(400)}`], base)).toBe(true);
    expect(isEnabledByOverrides(file, ['!*/**/*.js'], base)).toBe(false);
    expect(isEnabledByOverrides(file, ['!ext?nsions/greet.js'], base)).toBe(false);
  });

  it('writes a switch the way pi config does and adds + only when a glob still excludes the file', () => {
    expect(withExtensionsEnabled(['keep.js'], [file], base, false)).toEqual(['keep.js', '-extensions/greet.js']);
    expect(withExtensionsEnabled(['keep.js', '-extensions/greet.js'], [file], base, true)).toEqual(['keep.js']);
    expect(withExtensionsEnabled(['!extensions/*.js', '-extensions/greet.js'], [file], base, true)).toEqual(['!extensions/*.js', '+extensions/greet.js']);
    expect(withExtensionsEnabled(['-extensions/greet.js'], [file], base, false)).toEqual(['-extensions/greet.js']);
  });

  it('drops the entries of a file that is gone and leaves the rest', () => {
    expect(withoutExtensionOverrides(['-extensions/greet.js', '+extensions/greet.js', '-extensions/other.js', '!extensions/*.js', 'extensions/greet.js'], [file], base))
      .toEqual(['-extensions/other.js', '!extensions/*.js', 'extensions/greet.js']);
  });
});

describe('readSettingsFile', () => {
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it('reads what Pi reads: JSON with or without a BOM, an empty file as no settings', async () => {
    expect(await readSettingsFile(fsPromises, path.join(root, 'absent.json'))).toMatchObject({ exists: false, data: {}, error: null });
    expect(await readSettingsFile(fsPromises, write('empty.json', ''))).toMatchObject({ exists: true, data: {}, error: null });
    expect(await readSettingsFile(fsPromises, write('bom.json', '﻿{"a":1}'))).toMatchObject({ data: { a: 1 }, error: null });
  });

  it('reports a file that cannot be used instead of throwing', async () => {
    expect((await readSettingsFile(fsPromises, write('broken.json', '{"a":'))).error).toMatch(/JSON|Unexpected|end/i);
    expect((await readSettingsFile(fsPromises, write('array.json', '[1]'))).error).toMatch(/object/);
    expect((await readSettingsFile(fsPromises, write('spaces.json', '  '))).error).toBeTruthy();
    fs.mkdirSync(path.join(root, 'folder.json'));
    expect((await readSettingsFile(fsPromises, path.join(root, 'folder.json'))).error).toMatch(/Cannot read/);
  });
});

describe('createSettingsWriter', () => {
  it('runs operations on one file one after another and different files side by side', async () => {
    const writer = createSettingsWriter({ fs: fsPromises });
    const order = [];
    const slow = writer.queue(path.join(root, 'a.json'), async () => { order.push('a1 start'); await new Promise((r) => setTimeout(r, 60)); order.push('a1 end'); });
    const second = writer.queue(path.join(root, 'a.json'), async () => { order.push('a2'); });
    const other = writer.queue(path.join(root, 'b.json'), async () => { order.push('b'); });
    await Promise.all([slow, second, other]);
    expect(order.indexOf('a1 end')).toBeLessThan(order.indexOf('a2'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a1 end'));
  });

  it('keeps going after an operation failed', async () => {
    const writer = createSettingsWriter({ fs: fsPromises });
    const file = path.join(root, 'c.json');
    await expect(writer.queue(file, async () => { throw new Error('first failed'); })).rejects.toThrow('first failed');
    await expect(writer.queue(file, async () => 'second')).resolves.toBe('second');
  });

  it('writes a new settings file, creating its folder, and writes nothing when nothing changed', async () => {
    const writer = createSettingsWriter({ fs: fsPromises });
    const file = path.join(root, 'fresh', '.pi', 'settings.json');

    expect(await writer.update(file, (data) => { data.packages = ['npm:x']; })).toEqual({ changed: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ packages: ['npm:x'] });
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);

    const before = fs.statSync(file).mtimeMs;
    expect(await writer.update(file, () => false)).toEqual({ changed: false });
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('refuses to write over a file it cannot parse, and releases the lock', async () => {
    const writer = createSettingsWriter({ fs: fsPromises });
    const file = path.join(root, 'bad.json');
    fs.writeFileSync(file, '{nope');

    await expect(writer.update(file, (data) => { data.x = 1; })).rejects.toMatchObject({ code: 'SETTINGS_INVALID' });

    expect(fs.readFileSync(file, 'utf8')).toBe('{nope');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('releases the lock and leaves the file alone when the edit throws', async () => {
    const writer = createSettingsWriter({ fs: fsPromises });
    const file = path.join(root, 'throws.json');
    fs.writeFileSync(file, '{"a":1}');
    await expect(writer.update(file, () => { throw new Error('refused'); })).rejects.toThrow('refused');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.startsWith('throws.json.'))).toEqual([]);
  });
});
