import { describe, expect, it } from 'vitest';

import { composeContext, createContextCompositions } from './context-composition.js';

const PROMPT = [
  'You are a coding assistant.',
  '',
  '<tools>',
  '- read: Read file contents',
  '</tools>',
  '',
  '<rules>',
  '- Be concise',
  '</rules>',
  '',
  '<project_context>',
  'Project-specific instructions and guidelines:',
  '',
  '<project_instructions path="/work/AGENTS.md">',
  'Project rule: be terse.',
  '</project_instructions>',
  '</project_context>',
  '',
  '<skills>',
  'The following skills provide specialized instructions.',
  '<available_skills>',
  '  <skill>',
  '    <name>demo</name>',
  '    <description>Demo skill.</description>',
  '    <location>/work/.pi/skills/demo/SKILL.md</location>',
  '  </skill>',
  '</available_skills>',
  '</skills>',
  '',
  '<openchamber-context>',
  'Notes from OpenChamber.',
  '</openchamber-context>',
  '',
  '<cwd>',
  '/work',
  '</cwd>',
].join('\n');

const TOOLS = [
  { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } }, source: { source: 'builtin', path: 'builtin:read' } },
  { name: 'openchamber_web', description: 'Drive the browser.', parameters: { type: 'object' }, source: { source: 'extension', path: '/data/pi/openchamber-managed-tools.mjs' } },
  { name: 'mcp__radius__query', description: 'Query.', parameters: {}, source: { source: 'mcp', path: 'mcp:radius' } },
];

const byId = (composition, id) => composition.categories.find((entry) => entry.id === id);

describe('composeContext', () => {
  it('splits the prompt into system parts, instruction files and skills, and the tools into built-in and custom', () => {
    const composition = composeContext({ systemPrompt: PROMPT, tools: TOOLS });

    expect(byId(composition, 'system').items.map((item) => item.id).sort()).toEqual(['other', 'preamble', 'rules', 'section:openchamber-context', 'toolList', 'workingDirectory'].sort());
    expect(byId(composition, 'instructions').items).toEqual([expect.objectContaining({ label: '/work/AGENTS.md', text: 'Project rule: be terse.' })]);
    expect(byId(composition, 'skills').items).toEqual([expect.objectContaining({ label: 'demo', text: expect.stringContaining('<location>') })]);
    expect(byId(composition, 'builtinTools').items.map((item) => item.label)).toEqual(['read']);
    expect(byId(composition, 'customTools').items.map((item) => [item.label, item.detail]).sort()).toEqual([
      ['mcp__radius__query', 'MCP: radius'],
      ['openchamber_web', 'openchamber-managed-tools.mjs'],
    ]);
  });

  it('counts every character of the prompt once, at four characters a token', () => {
    const composition = composeContext({ systemPrompt: PROMPT, tools: [] });
    const promptTokens = byId(composition, 'system').tokens + byId(composition, 'instructions').tokens + byId(composition, 'skills').tokens;
    // Newlines between sections are not counted, so the parts are at most the whole and close to it.
    expect(promptTokens).toBeLessThanOrEqual(Math.ceil(PROMPT.length / 4));
    expect(promptTokens).toBeGreaterThan(Math.ceil(PROMPT.length / 4) - 12);
    expect(composition.totalTokens).toBe(promptTokens);
  });

  it('sorts items by size and sums a category from its items', () => {
    const composition = composeContext({ systemPrompt: '', tools: [
      { name: 'small', description: 'a', source: { source: 'builtin' } },
      { name: 'large', description: 'a'.repeat(400), source: { source: 'builtin' } },
    ] });
    const tools = byId(composition, 'builtinTools');
    expect(tools.items.map((item) => item.label)).toEqual(['large', 'small']);
    expect(tools.tokens).toBe(tools.items[0].tokens + tools.items[1].tokens);
  });

  it('keeps an unclosed tag as plain text and refuses a report it cannot read', () => {
    const composition = composeContext({ systemPrompt: 'Intro\n<tools>\nnever closed', tools: [] });
    expect(byId(composition, 'system').items.map((item) => item.id)).toEqual(['preamble']);
    expect(() => composeContext({ systemPrompt: 5, tools: [] })).toThrow('shape');
    expect(() => composeContext(null)).toThrow('shape');
  });
});

describe('createContextCompositions', () => {
  const session = { id: 'ses_1', cwd: '/work' };

  it('asks the child with a command and composes what it sends back', async () => {
    const sent = [];
    const host = {
      request: async (target, type, fields) => {
        sent.push({ target, type, fields });
        const id = fields.message.split(' ')[1];
        queueMicrotask(() => contexts.deliver('ses_1', id, { systemPrompt: 'Hello', tools: [] }));
        return { disposition: 'handled' };
      },
      abort: async () => true,
    };
    const contexts = createContextCompositions({ host, newId: () => 'req1' });

    const composition = await contexts.read(session);

    expect(sent).toEqual([{ target: session, type: 'prompt', fields: { message: '/openchamber-context req1' } }]);
    expect(byId(composition, 'system').items).toEqual([expect.objectContaining({ id: 'preamble', text: 'Hello' })]);
  });

  it('refuses an answer for another session or an unknown id', () => {
    const host = { request: () => new Promise(() => {}), abort: async () => true };
    const contexts = createContextCompositions({ host, newId: () => 'req2' });
    void contexts.read(session).catch(() => {});
    expect(contexts.deliver('ses_other', 'req2', {})).toBe(false);
    expect(contexts.deliver('ses_1', 'nope', {})).toBe(false);
  });

  it('times out when the child never answers, and aborts when the text became a prompt', async () => {
    const silent = createContextCompositions({ host: { request: async () => ({ disposition: 'handled' }), abort: async () => true }, timeoutMs: 20 });
    await expect(silent.read(session)).rejects.toMatchObject({ status: 503 });

    const aborted = [];
    const prompted = createContextCompositions({
      host: { request: async () => ({ disposition: 'started' }), abort: async (id) => { aborted.push(id); return true; } },
    });
    await expect(prompted.read(session)).rejects.toMatchObject({ status: 503 });
    expect(aborted).toEqual(['ses_1']);
  });
});
