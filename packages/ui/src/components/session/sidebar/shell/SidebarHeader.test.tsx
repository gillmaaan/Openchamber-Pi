import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

// React reads the DOM once when react-dom loads (input-event support among it),
// so the globals go in before react-dom and the components that import it.
const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  MouseEvent: browser.MouseEvent,
  InputEvent: browser.InputEvent,
  KeyboardEvent: browser.KeyboardEvent,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { SidebarHeader } = await import('./SidebarHeader');
const { closeSectionsManager, useSidebarSectionsUiStore } = await import('../sections/sectionActions');
const { useSessionDisplayStore } = await import('@/stores/useSessionDisplayStore');
const { useUIStore } = await import('@/stores/useUIStore');

type HeaderProps = React.ComponentProps<typeof SidebarHeader>;

const baseProps: HeaderProps = {
  hideDirectoryControls: false,
  showProjectDisplayControls: true,
  showSectionControls: true,
  handleOpenDirectoryDialog: () => undefined,
  onNewChat: () => undefined,
  sidebarMode: 'code',
  showModeSwitch: true,
  onSidebarModeChange: () => undefined,
  showSourceBoard: true,
  isSessionSearchOpen: false,
  openSessionSearch: () => undefined,
  closeSessionSearch: () => undefined,
  sessionSearchInputRef: React.createRef<HTMLInputElement | null>(),
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  searchScope: 'everything',
  setSearchScope: () => undefined,
  searchStatus: { kind: 'idle' },
  searchMatchCount: null,
  collapseAll: () => undefined,
  expandAll: () => undefined,
  showStats: true,
};
// The field replaces the Search row while it is open.
const openField: HeaderProps = { ...baseProps, isSessionSearchOpen: true };

function StatefulHeader({ initialQuery = '', ...props }: HeaderProps & { initialQuery?: string }) {
  const [query, setQuery] = React.useState(initialQuery);
  return <SidebarHeader {...props} sessionSearchQuery={query} setSessionSearchQuery={setQuery} />;
}

let host: HTMLDivElement;
let root: Root;

const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider><TooltipProvider>{node}</TooltipProvider></I18nProvider>));
const renderFull = (props: Partial<HeaderProps> = {}) => render(<SidebarHeader {...baseProps} {...props} />);
const input = () => document.querySelector('input')!;
const buttonLabels = () => [...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
const searchInTrigger = () => document.querySelector<HTMLButtonElement>('[data-search-in-trigger]');
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim());
const rowLabels = () => [...document.querySelectorAll('button')]
  .filter((button) => button.querySelector('span.flex-1'))
  .map((button) => button.querySelector('span.flex-1')?.textContent);
const rowButton = (label: string) => [...document.querySelectorAll('button')].find((button) => button.querySelector('span.flex-1')?.textContent === label);
const type = async (text: string) => {
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input(), text);
    input().dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
};
const press = (key: string) => act(async () => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
});

beforeEach(() => {
  closeSectionsManager();
  useUIStore.setState({ messageSearchEnabled: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('SidebarHeader', () => {
  test('full variant has the mode switch, the display menu and labelled rows, and hides the search input until opened', async () => {
    await renderFull();

    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('[aria-label="Sidebar mode"]')).not.toBeNull();
    expect(rowButton('Customize')).toBeDefined();
    expect(rowButton('Search sessions')?.textContent).toBe('Search sessions');
    expect(rowButton('Add project')).toBeDefined();
  });

  test('Code lists Add project, Search and the pages it shows as rows, with the rest under one More row', async () => {
    await renderFull();
    expect(rowLabels()).toEqual(['Add project', 'Search sessions', 'Issues and PRs', 'Scheduled tasks', 'Archive', 'More', 'Customize']);
  });

  test('Cowork (the chats) starts with New, then Search and its own pages, and has no Customize row', async () => {
    await renderFull({ sidebarMode: 'chat' });
    // The display menu opens from the Chats caption's icon in this mode.
    expect(rowLabels()).toEqual(['New', 'Search sessions', 'Scheduled tasks', 'Archive', 'More']);
    expect(rowButton('Add project')).toBeUndefined();
  });

  test('New starts a chat and Add project opens the directory dialog', async () => {
    let chats = 0;
    let directories = 0;
    await renderFull({ sidebarMode: 'chat', onNewChat: () => { chats += 1; } });
    await act(async () => rowButton('New')!.click());
    expect([chats, directories]).toEqual([1, 0]);
    await renderFull({ handleOpenDirectoryDialog: () => { directories += 1; } });
    await act(async () => rowButton('Add project')!.click());
    expect([chats, directories]).toEqual([1, 1]);
  });

  test('the mode switch reports the other mode and marks the current one', async () => {
    const chosen: string[] = [];
    await renderFull({ onSidebarModeChange: (mode) => { chosen.push(mode); } });
    const group = document.querySelector('[aria-label="Sidebar mode"]')!;
    const [chat, code] = [...group.querySelectorAll('button')];
    expect(chat.textContent).toBe('Cowork');
    expect(code.getAttribute('aria-pressed')).toBe('true');
    await act(async () => chat.click());
    expect(chosen).toEqual(['chat']);
  });

  test('without Chats there is no switch', async () => {
    await renderFull({ showModeSwitch: false });
    expect(document.querySelector('[aria-label="Sidebar mode"]')).toBeNull();
  });

  test('the Search row opens the field in its place, and the field closes itself on Escape', async () => {
    let opened = 0;
    let closed = 0;
    const renderSearch = (isSessionSearchOpen: boolean) => renderFull({ isSessionSearchOpen, openSessionSearch: () => { opened += 1; }, closeSessionSearch: () => { closed += 1; } });
    await renderSearch(false);
    await act(async () => rowButton('Search sessions')!.click());
    expect([opened, closed]).toEqual([1, 0]);
    await renderSearch(true);
    expect(rowButton('Search sessions')).toBeUndefined();
    await press('Escape');
    expect([opened, closed]).toEqual([1, 1]);
  });

  test('the field shows its own controls only while there is text', async () => {
    await render(<SidebarHeader {...openField} searchStatus={{ kind: 'loading' }} />);
    expect(searchInTrigger()).toBeNull();
    expect(document.querySelector('[data-search-status]')).toBeNull();
    expect(document.querySelector('[aria-label="Clear search"]')).toBeNull();

    await render(<SidebarHeader {...openField} sessionSearchQuery="token" searchStatus={{ kind: 'loading' }} />);
    expect(searchInTrigger()).not.toBeNull();
    // A search under way shows no mark: it would only flicker while typing.
    expect(document.querySelector('[data-search-status]')).toBeNull();
    expect(document.querySelector('[aria-label="Clear search"]')).not.toBeNull();
    expect(document.querySelector('[data-session-search-input]')?.contains(searchInTrigger())).toBe(true);
  });

  test('a search that went fine shows no status mark, a failed one shows the error', async () => {
    await render(<SidebarHeader {...openField} sessionSearchQuery="token" searchStatus={{ kind: 'ready', indexing: null, lifecycleComplete: true, hasMore: false }} />);
    expect(document.querySelector('[data-search-status]')).toBeNull();

    await render(<SidebarHeader {...openField} sessionSearchQuery="token" searchStatus={{ kind: 'failed' }} />);
    expect(document.querySelector('[data-search-status]')?.getAttribute('data-search-status')).toBe('error');
  });

  test('the menu in the field names where the search looks and picks another place', async () => {
    const picked: string[] = [];
    await render(<SidebarHeader {...openField} sessionSearchQuery="token" searchScope="titles" setSearchScope={(scope) => picked.push(scope)} />);
    expect(searchInTrigger()?.getAttribute('aria-label')).toContain('Titles');

    await act(async () => searchInTrigger()!.click());
    const options = [...document.querySelectorAll<HTMLElement>('[data-search-in-option]')];
    expect(options.map((option) => option.getAttribute('data-search-in-option'))).toEqual(['everything', 'titles', 'user', 'assistant']);
    await act(async () => options[2]!.click());
    expect(picked).toEqual(['user']);
  });

  for (const query of ['token', 'another topic']) test(`save as section seeds the search words from ${query}`, async () => {
    let closed = 0;
    await render(<SidebarHeader {...openField} sessionSearchQuery={query} closeSessionSearch={() => { closed += 1; }} />);
    expect(input().value).toBe(query);
    const savedSections = useSessionDisplayStore.getState().sections;
    await act(async () => searchInTrigger()!.click());
    const save = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'Save as section');
    expect(save).toBeDefined();
    await act(async () => {
      save!.click();
      const editor = useSidebarSectionsUiStore.getState();
      expect(editor.managerOpen).toBe(true);
      expect(editor.draftIsNew).toBe(true);
      expect(editor.draft?.name).toBe(query);
      expect(editor.draft?.filter.text).toEqual([query]);
      expect(useSessionDisplayStore.getState().sections).toBe(savedSections);
      closeSectionsManager();
    });
    expect(closed).toBe(1);
  });

  test('an id lookup cannot seed a section, and Cowork has no sections to seed', async () => {
    await render(<SidebarHeader {...openField} sessionSearchQuery="ses_123" />);
    await act(async () => searchInTrigger()!.click());
    expect(document.querySelectorAll('[data-search-in-option]').length).toBeGreaterThan(0);
    expect(menuItems()).not.toContain('Save as section');
    expect(useSidebarSectionsUiStore.getState().draft).toBeNull();

    await render(<SidebarHeader {...openField} sidebarMode="chat" sessionSearchQuery="token" />);
    await act(async () => searchInTrigger()!.click());
    expect(menuItems()).not.toContain('Save as section');
  });

  test('with only titles to search the menu is the search actions, and gone when there are none', async () => {
    useUIStore.setState({ messageSearchEnabled: false });
    await render(<SidebarHeader {...openField} sessionSearchQuery="token" />);
    await act(async () => searchInTrigger()!.click());
    expect(document.querySelectorAll('[data-search-in-option]')).toHaveLength(0);
    expect(menuItems()).toEqual(['Save as section']);

    await render(<SidebarHeader {...openField} sessionSearchQuery="ses_123" />);
    expect(searchInTrigger()).toBeNull();
  });

  test('typing commits after the debounce, and Enter commits at once', async () => {
    const submitted: string[] = [];
    await render(<SidebarHeader {...openField} setSessionSearchQuery={(value) => submitted.push(value)} />);

    await type('abc');
    expect(submitted).toEqual([]);
    await press('Enter');
    expect(submitted).toEqual(['abc']);
  });

  test('the clear button and Escape empty the field; Escape on an empty field drops the search', async () => {
    let closed = 0;
    await render(<StatefulHeader {...openField} initialQuery="draft" closeSessionSearch={() => { closed += 1; }} />);
    expect(input().value).toBe('draft');

    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click());
    expect(input().value).toBe('');
    expect(searchInTrigger()).toBeNull();

    await type('again');
    await press('Enter');
    expect(searchInTrigger()).not.toBeNull();
    await press('Escape');
    expect(input().value).toBe('');
    expect(closed).toBe(0);

    await press('Escape');
    expect(closed).toBe(1);
  });

  test('the compact header is the search field alone, with the match count inside it', async () => {
    await render(<SidebarHeader {...baseProps} hideDirectoryControls />);
    expect(document.querySelectorAll('input')).toHaveLength(1);
    expect(input().getAttribute('placeholder')).toBe('Search sessions...');
    expect(buttonLabels()).toEqual([]);

    const field = () => document.querySelector('[data-session-search-input]')!;
    for (const [count, label] of [[0, '0 matches'], [1, '1 match'], [3, '3 matches']] as const) {
      await render(<SidebarHeader {...baseProps} hideDirectoryControls sessionSearchQuery="token" searchMatchCount={count} />);
      expect(field().querySelector(`[aria-label="${label}"]`)?.textContent).toBe(String(count));
    }
    // A total not known yet shows no number.
    await render(<SidebarHeader {...baseProps} hideDirectoryControls sessionSearchQuery="token" searchMatchCount={null} />);
    expect(field().querySelector('[aria-label$="matches"]')).toBeNull();
    expect(searchInTrigger()).not.toBeNull();
  });
});
