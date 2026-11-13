import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SidebarHeader } from './SidebarHeader';

const baseProps = {
  hideDirectoryControls: false,
  showProjectDisplayControls: true,
  showSectionControls: true,
  handleOpenDirectoryDialog: () => undefined,
  onNewChat: () => undefined,
  sidebarMode: 'code' as const,
  showModeSwitch: true,
  onSidebarModeChange: () => undefined,
  showSourceBoard: true,
  isSessionSearchOpen: false,
  openSessionSearch: () => undefined,
  closeSessionSearch: () => undefined,
  sessionSearchInputRef: React.createRef<HTMLInputElement | null>(),
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  hasSessionSearchQuery: false,
  searchMatchCount: 0,
  collapseAll: () => undefined,
  expandAll: () => undefined,
  showStats: true,
};

function StatefulHeader({
  initialQuery = '',
  ...props
}: Omit<React.ComponentProps<typeof SidebarHeader>, 'sessionSearchQuery' | 'setSessionSearchQuery' | 'hasSessionSearchQuery'> & { initialQuery?: string }) {
  const [query, setQuery] = React.useState(initialQuery);
  return (
    <SidebarHeader
      {...props}
      sessionSearchQuery={query}
      setSessionSearchQuery={setQuery}
      hasSessionSearchQuery={query.trim().toLowerCase().length > 0}
    />
  );
}

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
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
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('SidebarHeader', () => {
  test('compact variant renders a persistent search input and no directory controls', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <StatefulHeader {...baseProps} hideDirectoryControls />
        </TooltipProvider>
      </I18nProvider>,
    ));

    const inputs = document.querySelectorAll('input');
    expect(inputs.length).toBe(1);
    expect(inputs[0]?.getAttribute('placeholder')).toBe('Search sessions...');

    expect(document.querySelector('[aria-label="Search sessions"]')).toBeNull();
    expect(document.querySelector('[aria-label="Add project"]')).toBeNull();
    expect(document.querySelector('[aria-label="Customize"]')).toBeNull();
  });

  test('compact variant clears the search query with the clear button', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <StatefulHeader {...baseProps} hideDirectoryControls initialQuery="draft" />
        </TooltipProvider>
      </I18nProvider>,
    ));

    const input = document.querySelector('input')!;
    expect(input.value).toBe('draft');

    const clearButton = document.querySelector<HTMLButtonElement>('[aria-label="Clear search"]');
    expect(clearButton).not.toBeNull();
    await act(async () => clearButton!.click());
    expect(input.value).toBe('');
  });

  test('compact variant applies the query on Enter, not on every keystroke', async () => {
    const submitted: string[] = [];
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarHeader {...baseProps} hideDirectoryControls setSessionSearchQuery={(value) => submitted.push(value)} />
        </TooltipProvider>
      </I18nProvider>,
    ));

    const input = document.querySelector('input')!;
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'abc');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    expect(submitted).toEqual([]);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(submitted).toEqual(['abc']);
  });

  const renderFull = (props: Partial<React.ComponentProps<typeof SidebarHeader>> = {}) => act(async () => root.render(
    <I18nProvider>
      <TooltipProvider>
        <SidebarHeader {...baseProps} {...props} />
      </TooltipProvider>
    </I18nProvider>,
  ));
  const rowLabels = () => [...document.querySelectorAll('button')]
    .filter((button) => button.querySelector('span.flex-1'))
    .map((button) => button.querySelector('span.flex-1')?.textContent);
  const rowButton = (label: string) => [...document.querySelectorAll('button')].find((button) => button.querySelector('span.flex-1')?.textContent === label);

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
    const render = (isSessionSearchOpen: boolean) => renderFull({ isSessionSearchOpen, openSessionSearch: () => { opened += 1; }, closeSessionSearch: () => { closed += 1; } });
    await render(false);
    await act(async () => rowButton('Search sessions')!.click());
    expect([opened, closed]).toEqual([1, 0]);
    await render(true);
    expect(rowButton('Search sessions')).toBeUndefined();
    const input = document.querySelector<HTMLInputElement>('input')!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect([opened, closed]).toEqual([1, 1]);
  });
});
