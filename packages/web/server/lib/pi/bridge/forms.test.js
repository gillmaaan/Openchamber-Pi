import { describe, expect, it } from 'vitest';

import { createFormManager, DISMISSED_MESSAGE } from './forms.js';

const DIRECTORY = '/work/project';
const COLOR = { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] };
const SIZES = { question: 'Which sizes?', header: 'Sizes', multiple: true, options: [{ label: 'S', description: 'small' }, { label: 'L', description: 'large' }] };

const setup = ({ sources = () => ({ messageID: 'msg_1' }), sourceWaitMs } = {}) => {
  const emitted = [];
  const hub = { emit: (event) => { emitted.push(event); return event; } };
  const forms = createFormManager({
    hub,
    getContext: (sessionID) => (sessionID === 'ses_a' ? { directory: DIRECTORY } : null),
    resolveSource: sources,
    ...(sourceWaitMs === undefined ? {} : { sourceWaitMs }),
  });
  return { forms, emitted };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ask = (forms, questions = [COLOR], extra = {}) => forms.ask({ sessionID: 'ses_a', toolCallId: 'call_2', questions, ...extra });

describe('asking', () => {
  it('emits form.created in the shape the question tool has in OpenCode', async () => {
    const { forms, emitted } = setup();
    void ask(forms);
    await flush();
    expect(emitted).toEqual([{
      type: 'form.created',
      location: { directory: DIRECTORY },
      data: {
        form: {
          id: expect.stringMatching(/^frm_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
          sessionID: 'ses_a',
          title: 'Questions',
          metadata: { kind: 'question', tool: { messageID: 'msg_1', id: 'call_2' } },
          fields: [{
            key: 'q0',
            title: 'Color',
            description: 'Which color?',
            type: 'string',
            options: [{ value: 'Red', label: 'Red', description: 'warm' }, { value: 'Blue', label: 'Blue', description: 'cool' }],
            custom: true,
          }],
        },
      },
    }]);
  });

  it('makes one field per question and a multiselect of a multiple one', async () => {
    const { forms, emitted } = setup();
    void ask(forms, [COLOR, SIZES]);
    await flush();
    expect(emitted[0].data.form.fields.map((field) => [field.key, field.type])).toEqual([['q0', 'string'], ['q1', 'multiselect']]);
  });

  it('leaves metadata.tool out when the source is not known', async () => {
    const { forms, emitted } = setup({ sources: () => undefined });
    void ask(forms);
    await flush();
    expect(emitted[0].data.form.metadata).toEqual({ kind: 'question' });
  });

  it('shows the form without metadata.tool when the lookup takes longer than it may', async () => {
    const { forms, emitted } = setup({ sources: () => new Promise(() => {}), sourceWaitMs: 30 });
    void ask(forms);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.form.metadata).toEqual({ kind: 'question' });
  });

  it('refuses questions it cannot show, and an unknown session', async () => {
    const { forms, emitted } = setup();
    await expect(ask(forms, [])).rejects.toMatchObject({ status: 400, tag: 'InvalidRequestError' });
    await expect(ask(forms, [{ question: 'Q', options: [] }])).rejects.toMatchObject({ tag: 'InvalidRequestError' });
    await expect(ask(forms, [{ question: 'Q', header: 'H', options: [{ description: 'no label' }] }])).rejects.toMatchObject({ tag: 'InvalidRequestError' });
    await expect(forms.ask({ sessionID: 'ses_missing', toolCallId: 'c', questions: [COLOR] })).rejects.toMatchObject({ tag: 'SessionNotFoundError' });
    expect(emitted).toEqual([]);
  });
});

describe('answering', () => {
  it('resolves the tool result text and emits form.replied', async () => {
    const { forms, emitted } = setup();
    const outcome = ask(forms);
    await flush();
    const { id } = emitted[0].data.form;
    forms.reply('ses_a', id, { q0: 'Purple' });
    expect(await outcome).toEqual({
      status: 'answered',
      answers: [['Purple']],
      answer: { q0: 'Purple' },
      text: 'User has answered your questions: "Which color?"="Purple". You can now continue with the user\'s answers in mind.',
    });
    expect(emitted[1]).toEqual({ type: 'form.replied', location: { directory: DIRECTORY }, data: { id, sessionID: 'ses_a', answer: { q0: 'Purple' } } });
  });

  it('joins several questions and several choices, and says Unanswered for a question left out', async () => {
    const { forms, emitted } = setup();
    const outcome = ask(forms, [COLOR, SIZES, { question: 'Why?', header: 'Why', options: [] }]);
    await flush();
    forms.reply('ses_a', emitted[0].data.form.id, { q1: ['S', 'L', 'XXL'], q0: 'Red' });
    const result = await outcome;
    expect(result.answers).toEqual([['Red'], ['S', 'L', 'XXL'], []]);
    expect(result.text).toBe('User has answered your questions: "Which color?"="Red", "Which sizes?"="S, L, XXL", "Why?"="Unanswered". You can now continue with the user\'s answers in mind.');
  });

  it('rejects an answer of the wrong type with the OpenCode message and keeps the form open', async () => {
    const { forms, emitted } = setup();
    const outcome = ask(forms, [COLOR, SIZES]);
    await flush();
    const { id } = emitted[0].data.form;
    expect(() => forms.reply('ses_a', id, { q0: 12345 })).toThrow(expect.objectContaining({ status: 400, tag: 'FormInvalidAnswerError', message: 'Expected string for form field: q0', extra: { id } }));
    expect(() => forms.reply('ses_a', id, { q1: 'S' })).toThrow('Expected array of strings for form field: q1');
    expect(() => forms.reply('ses_a', id, { q9: 'x' })).toThrow('Unexpected form field: q9');
    expect(() => forms.reply('ses_a', id, 'nope')).toThrow('Expected an object of answers');
    expect(forms.listPending()).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    forms.reply('ses_a', id, { q0: 'Red' });
    expect((await outcome).status).toBe('answered');
  });

  it('answers a second reply or a cancel of a settled form with FormAlreadySettledError, and an unknown id with FormNotFoundError', async () => {
    const { forms, emitted } = setup();
    void ask(forms);
    await flush();
    const { id } = emitted[0].data.form;
    forms.reply('ses_a', id, { q0: 'Purple' });
    expect(() => forms.reply('ses_a', id, { q0: 'Blue' })).toThrow(expect.objectContaining({ status: 409, tag: 'FormAlreadySettledError', extra: { id } }));
    expect(() => forms.cancel('ses_a', id)).toThrow(expect.objectContaining({ status: 409, tag: 'FormAlreadySettledError' }));
    expect(() => forms.reply('ses_a', 'frm_unknown', {})).toThrow(expect.objectContaining({ status: 404, tag: 'FormNotFoundError' }));
    expect(() => forms.reply('ses_b', id, {})).toThrow(expect.objectContaining({ tag: 'FormNotFoundError' }));
    expect(emitted.map((event) => event.type)).toEqual(['form.created', 'form.replied']);
  });
});

describe('cancelling', () => {
  it('dismisses the question with the message OpenCode uses and emits form.cancelled', async () => {
    const { forms, emitted } = setup();
    const outcome = ask(forms);
    await flush();
    const { id } = emitted[0].data.form;
    forms.cancel('ses_a', id);
    expect(await outcome).toEqual({ status: 'dismissed', message: DISMISSED_MESSAGE });
    expect(DISMISSED_MESSAGE).toBe('The user dismissed this question');
    expect(emitted[1]).toEqual({ type: 'form.cancelled', location: { directory: DIRECTORY }, data: { id, sessionID: 'ses_a' } });
    expect(forms.get('ses_a', id).state).toEqual({ status: 'cancelled' });
  });

  it('carries the message the user gave', async () => {
    const { forms, emitted } = setup();
    const outcome = ask(forms);
    await flush();
    forms.cancel('ses_a', emitted[0].data.form.id, { message: 'Not now' });
    expect(await outcome).toEqual({ status: 'dismissed', message: 'Not now' });
  });

  it('drops a form whose call was aborted and tells clients the card is gone', async () => {
    const { forms, emitted } = setup();
    const controller = new AbortController();
    const outcome = ask(forms, [COLOR], { signal: controller.signal });
    await flush();
    const { id } = emitted[0].data.form;
    controller.abort();
    expect(await outcome).toMatchObject({ status: 'dismissed' });
    expect(forms.listPending()).toEqual([]);
    expect(emitted[1]).toMatchObject({ type: 'form.cancelled', data: { id, sessionID: 'ses_a' } });
    expect(() => forms.reply('ses_a', id, { q0: 'Red' })).toThrow(expect.objectContaining({ tag: 'FormAlreadySettledError' }));
  });

  it('shows nothing for a call that is already aborted', async () => {
    const { forms, emitted } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await ask(forms, [COLOR], { signal: controller.signal })).toMatchObject({ status: 'dismissed' });
    expect(emitted).toEqual([]);
  });
});

describe('reading', () => {
  it('lists pending forms by directory and session and reports each form\'s state', async () => {
    const { forms, emitted } = setup();
    void ask(forms);
    void ask(forms, [SIZES], { toolCallId: 'call_3' });
    await flush();
    expect(forms.listPending({ directory: DIRECTORY })).toHaveLength(2);
    expect(forms.listPending({ directory: '/elsewhere' })).toEqual([]);
    expect(forms.listPending({ sessionID: 'ses_a' })).toHaveLength(2);

    const first = emitted[0].data.form;
    expect(forms.get('ses_a', first.id)).toEqual({ ...first, state: { status: 'pending' } });
    forms.reply('ses_a', first.id, { q0: 'Purple' });
    expect(forms.get('ses_a', first.id)).toEqual({ ...first, state: { status: 'answered', answer: { q0: 'Purple' } } });
    expect(forms.listPending()).toHaveLength(1);
    expect(forms.get('ses_a', 'frm_unknown')).toBeNull();
  });
});
