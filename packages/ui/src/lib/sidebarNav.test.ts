import { describe, expect, test } from 'bun:test';

import {
  arrangeSidebarNav,
  defaultSidebarNav,
  normalizeSidebarNav,
  reorderSidebarNav,
  resolveSidebarMode,
  SIDEBAR_NAV_MAX,
  setSidebarNavShown,
} from './sidebarNav';

const pages = ['overview', 'source-board', 'scheduled', 'archive', 'stats', 'integrations', 'guest:notes'].map((id) => ({ id }));

describe('sidebar navigation rows', () => {
  test('each mode starts with its own rows and the rest sits under More', () => {
    const nav = defaultSidebarNav();
    expect(arrangeSidebarNav(pages, nav.chat).rows.map((page) => page.id)).toEqual(['scheduled', 'archive']);
    expect(arrangeSidebarNav(pages, nav.code).rows.map((page) => page.id)).toEqual(['overview', 'source-board', 'scheduled', 'archive']);
    expect(arrangeSidebarNav(pages, nav.chat).more.map((page) => page.id)).toEqual(['overview', 'source-board', 'stats', 'integrations', 'guest:notes']);
  });

  test('rows follow the arranged order, skip pages that are gone and never repeat one', () => {
    const { rows, more } = arrangeSidebarNav(pages, ['archive', 'removed-extension', 'overview', 'archive']);
    expect(rows.map((page) => page.id)).toEqual(['archive', 'overview']);
    expect(more.map((page) => page.id)).toEqual(['source-board', 'scheduled', 'stats', 'integrations', 'guest:notes']);
  });

  test('a page added later is under More until it is arranged', () => {
    expect(arrangeSidebarNav([...pages, { id: 'guest:new' }], defaultSidebarNav().code).more.map((page) => page.id)).toContain('guest:new');
  });

  test('showing a page appends it, hiding drops it, and neither touches the other rows', () => {
    expect(setSidebarNavShown(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
    expect(setSidebarNavShown(['a', 'b', 'c'], 'a', true)).toEqual(['b', 'c', 'a']);
    expect(setSidebarNavShown(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
    expect(setSidebarNavShown(['a'], 'missing', false)).toEqual(['a']);
  });

  test('showing a page cannot grow the list past the limit', () => {
    const full = Array.from({ length: SIDEBAR_NAV_MAX }, (_, index) => `page-${index}`);
    expect(setSidebarNavShown(full, 'one-more', true)).toHaveLength(SIDEBAR_NAV_MAX);
  });

  test('moving a page in the full list keeps only the rows, in the new order', () => {
    const order = ['a', 'b', 'c', 'x', 'y'];
    expect(reorderSidebarNav(['a', 'b', 'c'], order, 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorderSidebarNav(['a', 'b', 'c'], order, 'a', 'y')).toEqual(['b', 'c', 'a']);
    expect(reorderSidebarNav(['a', 'b', 'c'], order, 'a', 'unknown')).toEqual(['a', 'b', 'c']);
  });

  test('a stored value is read per mode, de-duplicated, and a broken one falls back to its default', () => {
    expect(normalizeSidebarNav({ chat: ['archive', 'archive'], code: ['stats'] })).toEqual({ chat: ['archive'], code: ['stats'] });
    expect(normalizeSidebarNav({ chat: ['archive'] })).toEqual({ chat: ['archive'], code: defaultSidebarNav().code });
    expect(normalizeSidebarNav({ chat: 'archive', code: [1, 2] })).toEqual(defaultSidebarNav());
    expect(normalizeSidebarNav(null)).toEqual(defaultSidebarNav());
    expect(normalizeSidebarNav({ code: Array.from({ length: SIDEBAR_NAV_MAX + 1 }, (_, index) => `p${index}`) }).code).toEqual(defaultSidebarNav().code);
  });

  test('default rows are copies, so changing one mode never changes the defaults', () => {
    const first = defaultSidebarNav();
    first.chat.push('stats');
    expect(defaultSidebarNav().chat).toEqual(['scheduled', 'archive']);
  });
});

describe('sidebar mode', () => {
  test('modes exist only where the sidebar has them, and Chat only while the Chats section is on', () => {
    expect(resolveSidebarMode({ enabled: false, stored: 'chat', chatsShown: true })).toBeUndefined();
    expect(resolveSidebarMode({ enabled: true, stored: 'chat', chatsShown: true })).toBe('chat');
    expect(resolveSidebarMode({ enabled: true, stored: 'code', chatsShown: true })).toBe('code');
    expect(resolveSidebarMode({ enabled: true, stored: 'chat', chatsShown: false })).toBe('code');
  });
});
