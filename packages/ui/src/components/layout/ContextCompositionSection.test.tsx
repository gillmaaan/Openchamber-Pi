import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const createBrowser = () => {
  const browser = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
    Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  });
  return browser;
};
let browser = createBrowser();

const requested: string[] = [];
let answer: () => Response = () => Response.json({}, { status: 503 });
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  requested.push(String(input instanceof Request ? input.url : input));
  return answer();
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ContextCompositionSection } = await import('./ContextCompositionSection');

const COMPOSITION = {
  data: {
    totalTokens: 7400,
    categories: [
      { id: 'system', tokens: 930, items: [
        { id: 'rules', label: '', tokens: 400, text: '<rules>\n- Be concise\n</rules>' },
        { id: 'section:custom-notes', label: 'custom-notes', tokens: 530, text: 'Notes' },
      ] },
      { id: 'instructions', tokens: 0, items: [] },
      { id: 'builtinTools', tokens: 5400, items: [
        { id: 'tool:find', label: 'find', tokens: 137, text: 'Search for files by glob pattern.' },
      ] },
      { id: 'customTools', tokens: 1070, items: [
        { id: 'tool:openchamber_web', label: 'openchamber_web', tokens: 1070, detail: 'openchamber-managed-tools.mjs', text: 'Drive the browser.' },
      ] },
    ],
  },
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  browser.close();
  browser = createBrowser();
  requested.length = 0;
  answer = () => Response.json(COMPOSITION);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  browser.close();
});
afterAll(() => { fetchSpy.mockRestore(); });

const render = async (sessionId = 'ses_1') => {
  await act(async () => { root.render(<I18nProvider><ContextCompositionSection sessionId={sessionId} contextLimit={200000} /></I18nProvider>); });
};
const buttonWith = (text: string) => [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));
const click = async (text: string) => {
  const button = buttonWith(text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => { button.click(); });
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

test('asks the agent only once the section is opened', async () => {
  await render();
  await settle();
  expect(requested).toEqual([]);

  await click('Composition');
  await settle();
  expect(requested).toHaveLength(1);
  expect(requested[0]).toContain('/api/session/ses_1/context-composition');
  expect(container.textContent).toContain('≈ 7,400');
});

test('lists the categories with items, names the system parts, and opens an item down to its text', async () => {
  await render();
  await click('Composition');
  await settle();

  expect(container.textContent).toContain('System prompt');
  expect(container.textContent).toContain('Built-in tools');
  expect(container.textContent).toContain('Custom tools');
  // A category without items is not shown.
  expect(container.textContent).not.toContain('Instruction files');

  await click('System prompt');
  expect(container.textContent).toContain('Rules');
  expect(container.textContent).toContain('custom-notes');
  expect(container.textContent).not.toContain('Be concise');

  await click('Rules');
  expect(container.querySelector('pre')?.textContent).toContain('Be concise');

  await click('Custom tools');
  expect(container.textContent).toContain('openchamber_web');
  expect(container.textContent).toContain('openchamber-managed-tools.mjs');
  // 5400 of a 200000 window.
  expect(container.textContent).toContain('2.7%');
});

test('a failed read says so and offers to try again; it never shows an empty composition', async () => {
  answer = () => Response.json({ _tag: 'ServiceUnavailableError' }, { status: 503 });
  await render();
  await click('Composition');
  await settle();

  expect(container.textContent).toContain('The agent did not answer.');
  expect(container.textContent).not.toContain('Built-in tools');

  answer = () => Response.json(COMPOSITION);
  await click('Try again');
  await settle();
  expect(requested).toHaveLength(2);
  expect(container.textContent).toContain('Built-in tools');
});

test('another session starts from nothing and reads its own composition', async () => {
  await render('ses_1');
  await click('Composition');
  await settle();
  expect(container.textContent).toContain('Built-in tools');

  await render('ses_2');
  await settle();
  expect(requested.at(-1)).toContain('/api/session/ses_2/context-composition');
});
