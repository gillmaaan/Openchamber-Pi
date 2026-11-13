import { describe, expect, it } from 'vitest';

import { cleanTitle, createTitles, TITLE_SYSTEM_PROMPT } from './titles.js';

describe('cleanTitle', () => {
  it.each([
    ['Login timeout bug.', 'Login timeout bug'],
    ['"Dark mode"', 'Dark mode'],
    ['## Plan mode bug', 'Plan mode bug'],
    ['Title: Production server errors', 'Production server errors'],
    ['\n\n  Vorspann\nzweite Zeile', 'Vorspann'],
    ['Вхід через GitHub。', 'Вхід через GitHub'],
    ['', ''],
  ])('turns %j into %j', (input, expected) => {
    expect(cleanTitle(input)).toBe(expected);
  });

  it('cuts a long answer to a title length', () => {
    const title = cleanTitle('word '.repeat(40));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('createTitles', () => {
  const setup = ({ generate, meta = {} } = {}) => {
    const renamed = [];
    const requests = [];
    const titles = createTitles({
      generateText: async (request) => { requests.push(request); return generate ? generate(request) : 'Login timeout'; },
      metaStore: { get: (id) => meta[id] ?? null },
      rename: async (id, body) => { renamed.push([id, body.title]); },
    });
    return { titles, renamed, requests };
  };

  it('asks for a title with the style prompt and the first message, then renames the session', async () => {
    const { titles, renamed, requests } = setup();
    await titles.nameSession({ sessionID: 'ses_a', directory: '/p', text: 'the login times out after a minute' });
    expect(renamed).toEqual([['ses_a', 'Login timeout']]);
    expect(requests[0].prompt.startsWith(TITLE_SYSTEM_PROMPT)).toBe(true);
    expect(requests[0].prompt).toContain('<message>\nthe login times out after a minute\n</message>');
    expect(requests[0].directory).toBe('/p');
  });

  it('leaves the session alone when the model says nothing usable or fails', async () => {
    const empty = setup({ generate: () => '   ' });
    await empty.titles.nameSession({ sessionID: 'ses_a', directory: '/p', text: 'hello' });
    expect(empty.renamed).toEqual([]);

    const failing = setup({ generate: () => { throw new Error('provider down'); } });
    await expect(failing.titles.nameSession({ sessionID: 'ses_a', directory: '/p', text: 'hello' })).resolves.toBeUndefined();
    expect(failing.renamed).toEqual([]);
  });

  it('keeps a title the user set while the model was working', async () => {
    const meta = {};
    const { titles, renamed } = setup({ meta, generate: () => { meta.ses_a = { title: 'Mine' }; return 'Generated'; } });
    await titles.nameSession({ sessionID: 'ses_a', directory: '/p', text: 'hello' });
    expect(renamed).toEqual([]);
  });

  it('does not start a second request for a session already being named, and names nothing for an empty message', async () => {
    let release;
    const { titles, requests } = setup({ generate: () => new Promise((resolve) => { release = () => resolve('Title'); }) });
    const first = titles.nameSession({ sessionID: 'ses_a', directory: '/p', text: 'hello' });
    await titles.nameSession({ sessionID: 'ses_a', directory: '/p', text: 'again' });
    await titles.nameSession({ sessionID: 'ses_b', directory: '/p', text: '  ' });
    expect(requests).toHaveLength(1);
    release();
    await first;
  });
});
