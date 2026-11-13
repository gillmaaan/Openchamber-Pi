import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { AgentConfig } from '@/stores/useAgentsStore';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const createBrowser = () => {
  const browser = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
    Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  });
  return browser;
};
let browser = createBrowser();
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  return Response.json(url.includes('/config/mcp') ? [] : { home: '/test' });
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useAgentsStore } = await import('@/stores/useAgentsStore');
plugin({
  name: 'agent-settings-provider-logos',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});
const { AgentsPage } = await import('./AgentsPage');
const initialAgentsState = useAgentsStore.getState();
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  browser.close();
  browser = createBrowser();
  useAgentsStore.setState(initialAgentsState, true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useAgentsStore.setState(initialAgentsState, true);
  browser.close();
});
afterAll(() => { fetchSpy.mockRestore(); });

const renameDraft = async (name: string) => {
  const field = container.querySelector<HTMLInputElement>('[data-settings-item="agents.name"] input');
  if (!field) throw new Error('Missing agent name field');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing input setter');
  await act(async () => {
    setValue.call(field, name);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const clickCreate = async () => {
  const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent === 'Create');
  if (!button) throw new Error('Missing Create button');
  expect(button.disabled).toBe(false);
  await act(async () => { button.click(); });
};

test('creating a renamed draft selects the saved agent and leaves create mode', async () => {
  const writes: AgentConfig[] = [];
  useAgentsStore.setState({
    selectedAgentName: 'new-agent', agentDraft: { name: 'new-agent', scope: 'user', system: 'draft system' },
    createAgent: async (config) => {
      writes.push(config);
      useAgentsStore.setState({ agentsByDirectory: { __default__: [{
        id: config.name, name: config.name, displayName: config.name, mode: 'subagent',
        request: { settings: {}, headers: {}, body: {} }, hidden: false, permissions: [],
      }] } });
      return { ok: true };
    },
    fetchAgentEntity: async () => ({ source: 'json', scope: 'user', path: '/config.json', legacy: false,
      config: { system: 'draft system' } }),
    fetchAgentPermissions: async () => ({ global: [], agent: [], effective: [], source: 'json', path: '/config.json' }),
  });
  await act(async () => { root.render(<I18nProvider><AgentsPage /></I18nProvider>); });
  await renameDraft('renamed-agent');
  expect(writes).toEqual([]);
  await clickCreate();

  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ name: 'renamed-agent', scope: 'user', system: 'draft system' });
  expect(useAgentsStore.getState().selectedAgentName).toBe('renamed-agent');
  expect(useAgentsStore.getState().agentDraft).toBeNull();
  expect(container.querySelector('h1')?.textContent).toBe('renamed-agent');
  expect(container.querySelector('[data-settings-item="agents.name"]')).toBeNull();
  expect([...container.querySelectorAll('button')].some((entry) => entry.textContent === 'Create')).toBe(false);
  expect([...container.querySelectorAll('textarea')].some((entry) => entry.value === 'draft system')).toBe(true);
});

test('a late create completion preserves the newly selected draft', async () => {
  const writes: AgentConfig[] = [];
  let finishCreate: () => void = () => { throw new Error('Create has not started'); };
  useAgentsStore.setState({
    selectedAgentName: 'new-agent', agentDraft: { name: 'new-agent', scope: 'user' },
    createAgent: (config) => new Promise((resolve) => {
      writes.push(config);
      finishCreate = () => resolve({ ok: true });
    }),
  });
  await act(async () => { root.render(<I18nProvider><AgentsPage /></I18nProvider>); });
  await renameDraft('renamed-agent');
  await clickCreate();
  expect(writes.map((config) => config.name)).toEqual(['renamed-agent']);

  const nextDraft = { name: 'another-agent', scope: 'user' as const, system: 'another system' };
  await act(async () => {
    useAgentsStore.setState({ selectedAgentName: nextDraft.name, agentDraft: nextDraft });
  });
  expect(container.querySelector<HTMLInputElement>('[data-settings-item="agents.name"] input')?.value).toBe(nextDraft.name);
  await act(async () => { finishCreate(); });

  expect(useAgentsStore.getState().selectedAgentName).toBe(nextDraft.name);
  expect(useAgentsStore.getState().agentDraft).toEqual(nextDraft);
  expect(container.querySelector<HTMLInputElement>('[data-settings-item="agents.name"] input')?.value).toBe(nextDraft.name);
  expect([...container.querySelectorAll('textarea')].some((entry) => entry.value === nextDraft.system)).toBe(true);
  expect(writes).toHaveLength(1);
});

test('an agent catalog refresh during save preserves the newer blurred draft', async () => {
  let system = 'initial';
  const writes: Array<{ value: string; finish: () => void }> = [];
  const agent = { id: 'test', name: 'test', displayName: 'Test', mode: 'subagent' as const,
    request: { settings: {}, headers: {}, body: {} }, hidden: false, permissions: [] };
  useAgentsStore.setState({
    selectedAgentName: 'test', agentsByDirectory: { __default__: [agent] },
    getAgentByName: () => useAgentsStore.getState().agentsByDirectory.__default__?.[0] ?? null,
    fetchAgentEntity: async () => ({ source: 'json', scope: 'user', path: '/config.json', legacy: false, config: { system } }),
    fetchAgentPermissions: async () => ({ global: [], agent: [], effective: [], source: 'json', path: '/config.json' }),
    updateAgent: async (_name, config) => new Promise((resolve) => {
      writes.push({ value: config.system ?? '', finish: () => resolve({ ok: true }) });
    }),
  });
  await act(async () => { root.render(<I18nProvider><AgentsPage /></I18nProvider>); });
  const field = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].find((entry) => entry.value === 'initial');
  if (!field) throw new Error('Missing agent system field');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing textarea setter');
  const edit = async (value: string) => {
    await act(async () => { setValue.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  };
  await edit('older');
  await edit('newer');
  expect(writes.map((write) => write.value)).toEqual(['older']);
  await act(async () => {
    system = 'older';
    useAgentsStore.setState({ agentsByDirectory: { __default__: [{ ...agent, system }] } });
  });
  expect(field.value).toBe('newer');
  await act(async () => { writes[0].finish(); });
  expect(writes.map((write) => write.value)).toEqual(['older', 'newer']);
  await act(async () => {
    useAgentsStore.setState({ agentsByDirectory: { __default__: [{ ...agent, system }] } });
  });
  expect(field.value).toBe('newer');
  await act(async () => {
    useAgentsStore.setState({ selectedAgentName: 'other', agentsByDirectory: { __default__: [{ ...agent, name: 'other' }] } });
  });
  expect(field.value).toBe('older');
  await act(async () => { writes[1].finish(); });
});
