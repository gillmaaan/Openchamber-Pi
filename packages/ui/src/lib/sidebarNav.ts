import { z } from 'zod';

/** The sidebar's two modes: Chat lists the chats that belong to no project, Code the projects. */
export const SIDEBAR_MODES = ['chat', 'code'] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];

/** An extension's page is `guest:<id>`; the built-in pages are `overview`, `source-board`, `scheduled`, `archive`, `stats` and `integrations`. */
const GUEST_PAGE_PREFIX = 'guest:';
export const guestPageNavId = (guestId: string): string => `${GUEST_PAGE_PREFIX}${guestId}`;
export const isGuestPageNavId = (id: string): boolean => id.startsWith(GUEST_PAGE_PREFIX);

export const SIDEBAR_NAV_MAX = 64;

export type SidebarNav = Record<SidebarMode, string[]>;

/**
 * The pages each mode shows as a row, in order. A page that is not listed is
 * under More, so a page a new version or a new extension adds is reachable
 * before anyone has arranged it.
 */
const DEFAULT_SIDEBAR_NAV: Readonly<Record<SidebarMode, readonly string[]>> = {
  chat: ['scheduled', 'archive'],
  code: ['overview', 'source-board', 'scheduled', 'archive'],
};

export const defaultSidebarNav = (): SidebarNav => ({
  chat: [...DEFAULT_SIDEBAR_NAV.chat],
  code: [...DEFAULT_SIDEBAR_NAV.code],
});

const navIdsSchema = z.array(z.string().min(1).max(160)).max(SIDEBAR_NAV_MAX);

/** A stored value read per mode: one that does not parse falls back to that mode's default, the other keeps its own. */
export const normalizeSidebarNav = (value: unknown): SidebarNav => {
  const stored = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const defaults = defaultSidebarNav();
  const read = (mode: SidebarMode): string[] => {
    const parsed = navIdsSchema.safeParse(stored[mode]);
    return parsed.success ? [...new Set(parsed.data)] : defaults[mode];
  };
  return { chat: read('chat'), code: read('code') };
};

/**
 * What the sidebar shows: Chat only where the Chats section is on, and only
 * where the sidebar has modes at all (not VS Code, not the phone).
 */
export const resolveSidebarMode = ({ enabled, stored, chatsShown }: { enabled: boolean; stored: SidebarMode; chatsShown: boolean }): SidebarMode | undefined => {
  if (!enabled) return undefined;
  return chatsShown ? stored : 'code';
};

/** The pages that are rows, in the arranged order, and the rest, in the pages' own order. */
export const arrangeSidebarNav = <T extends { id: string }>(pages: readonly T[], shown: readonly string[]): { rows: T[]; more: T[] } => {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const placed = new Set<string>();
  const rows: T[] = [];
  for (const id of shown) {
    const page = byId.get(id);
    if (!page || placed.has(id)) continue;
    placed.add(id);
    rows.push(page);
  }
  return { rows, more: pages.filter((page) => !placed.has(page.id)) };
};

/** A page becomes a row at the end, or goes back under More. */
export const setSidebarNavShown = (shown: readonly string[], id: string, visible: boolean): string[] => {
  const without = shown.filter((entry) => entry !== id);
  return visible ? [...without, id].slice(0, SIDEBAR_NAV_MAX) : without;
};

/**
 * Moves one page in the full list the manager draws (rows first, then the
 * hidden pages) and keeps only the rows, in their new order.
 */
export const reorderSidebarNav = (shown: readonly string[], order: readonly string[], activeId: string, overId: string): string[] => {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0) return [...shown];
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  const rows = new Set(shown);
  return next.filter((id) => rows.has(id));
};
