import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, pageCursor } from './cursor.js';
import { paginate } from './paginate.js';

const items = ['a', 'b', 'c', 'd', 'e'];
const compareTo = (item, anchor) => (item < anchor.id ? -1 : item > anchor.id ? 1 : 0);

describe('paginate', () => {
  it('returns the first page without a cursor', () => {
    expect(paginate(items, { limit: 2, cursor: null, compareToAnchor: compareTo })).toEqual(['a', 'b']);
  });

  it('continues past the anchor for next', () => {
    expect(paginate(items, { limit: 2, cursor: { direction: 'next', anchor: { id: 'b' } }, compareToAnchor: compareTo })).toEqual(['c', 'd']);
  });

  it('returns the items closest before the anchor, in list order, for previous', () => {
    expect(paginate(items, { limit: 2, cursor: { direction: 'previous', anchor: { id: 'd' } }, compareToAnchor: compareTo })).toEqual(['b', 'c']);
  });

  it('gives an empty page past the last item', () => {
    expect(paginate(items, { limit: 2, cursor: { direction: 'next', anchor: { id: 'e' } }, compareToAnchor: compareTo })).toEqual([]);
  });

  it('still finds its place when the anchor item has left the list', () => {
    expect(paginate(['a', 'c', 'e'], { limit: 5, cursor: { direction: 'next', anchor: { id: 'b' } }, compareToAnchor: compareTo })).toEqual(['c', 'e']);
    expect(paginate(['a', 'c', 'e'], { limit: 5, cursor: { direction: 'previous', anchor: { id: 'd' } }, compareToAnchor: compareTo })).toEqual(['a', 'c']);
  });
});

describe('cursor codec', () => {
  it('round-trips JSON as unpadded base64url', () => {
    const value = { id: 'msg_x', order: 'desc', direction: 'next' };
    const text = encodeCursor(value);
    expect(text).not.toMatch(/[=+/]/);
    expect(decodeCursor(text)).toEqual(value);
  });

  it('accepts the cursor the UI builds by hand for older messages', () => {
    const handMade = Buffer.from(JSON.stringify({ id: 'msg_1', order: 'desc', direction: 'next' })).toString('base64url');
    expect(decodeCursor(handMade)).toEqual({ id: 'msg_1', order: 'desc', direction: 'next' });
  });

  it.each(['garbage', '', 'bnVsbA', Buffer.from('[1]').toString('base64url')])('rejects %j as an invalid cursor', (text) => {
    expect(() => decodeCursor(text)).toThrowError(expect.objectContaining({ status: 400, tag: 'InvalidCursorError' }));
  });

  it('gives both keys null for an empty page and both set otherwise', () => {
    expect(pageCursor([], () => ({}))).toEqual({ previous: null, next: null });
    const page = pageCursor(['x', 'y'], (item, direction) => ({ id: item, direction }));
    expect(decodeCursor(page.previous)).toEqual({ id: 'x', direction: 'previous' });
    expect(decodeCursor(page.next)).toEqual({ id: 'y', direction: 'next' });
  });
});
