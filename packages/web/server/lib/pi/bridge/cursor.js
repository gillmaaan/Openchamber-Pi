// Opaque cursors are base64url (no padding) JSON, as OpenCode serves them. The
// UI builds one by hand for older messages (`messageCursor.ts`), so the shape
// is part of the contract, not an internal detail.

import { invalidCursor } from './errors.js';

export const encodeCursor = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export const decodeCursor = (text) => {
  if (typeof text !== 'string' || text.length === 0) throw invalidCursor();
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidCursor();
  return parsed;
};

/**
 * One page of an ordered list.
 *
 * `items` are sorted already. `anchorOf(item)` gives the cursor payload for an
 * item. An empty page has both cursor keys null; a non-empty page has both set
 * (`next` continues in the direction of the order, `previous` goes back).
 */
export const pageCursor = (items, anchorOf) => {
  if (items.length === 0) return { previous: null, next: null };
  return {
    previous: encodeCursor(anchorOf(items[0], 'previous')),
    next: encodeCursor(anchorOf(items.at(-1), 'next')),
  };
};
