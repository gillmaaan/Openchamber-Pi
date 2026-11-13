import { describe, expect, it, vi } from 'vitest';

import { createSubagents } from './subagents.js';

const setup = (parentID) => {
  const service = {
    requireRecord: vi.fn(async () => ({ id: 'ses_child', parentID, outcome: 'succeeded' })),
    waitForIdle: vi.fn(async () => {}),
  };
  const prompting = { interrupt: vi.fn(async () => {}) };
  const chat = { messages: vi.fn(async () => ({ data: [{ type: 'assistant', content: [{ type: 'text', text: 'Child answer' }] }] })) };
  return { service, prompting, chat, subagents: createSubagents({ service, prompting, chat, listSubagents: () => ['general'] }) };
};

describe('subagent answer ownership', () => {
  it('lets the parent wait for its own child and read the answer', async () => {
    const { subagents, service, chat } = setup('ses_parent');
    const result = await subagents.wait({ sessionID: 'ses_child', parentSessionID: 'ses_parent' });
    expect(result).toMatchObject({ status: 'completed', text: expect.stringContaining('Child answer') });
    expect(service.waitForIdle).toHaveBeenCalledWith('ses_child', undefined);
    expect(chat.messages).toHaveBeenCalledOnce();
  });

  it.each(['ses_other', undefined])('refuses an unrelated session with parent %s before reading or interrupting it', async (parentID) => {
    const { subagents, service, prompting, chat } = setup(parentID);
    const controller = new AbortController();
    const waiting = subagents.wait({ sessionID: 'ses_child', parentSessionID: 'ses_parent', signal: controller.signal });
    await expect(waiting).rejects.toMatchObject({ status: 403, tag: 'ForbiddenError' });
    controller.abort();
    expect(service.waitForIdle).not.toHaveBeenCalled();
    expect(chat.messages).not.toHaveBeenCalled();
    expect(prompting.interrupt).not.toHaveBeenCalled();
  });
});
