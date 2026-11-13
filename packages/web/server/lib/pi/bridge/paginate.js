// Cursor paging over a list that is already in its final order.
//
// A cursor names an item (its anchor) and a direction. `next` continues past
// the anchor in the list's own order, `previous` goes back from it; both stay
// valid when the anchor has since left the list, because the position is found
// by comparing, not by looking the item up.

/**
 * @template T
 * @param {T[]} items  In the order the caller serves them.
 * @param {object} options
 * @param {number} options.limit
 * @param {{ direction: 'next'|'previous', anchor: object } | null} options.cursor
 * @param {(item: T, anchor: object) => number} options.compareToAnchor
 *   Negative when `item` comes before the anchor in the list's order, positive after.
 */
export const paginate = (items, { limit, cursor, compareToAnchor }) => {
  if (!cursor) return items.slice(0, limit);

  if (cursor.direction === 'previous') {
    const before = items.filter((item) => compareToAnchor(item, cursor.anchor) < 0);
    return before.slice(Math.max(0, before.length - limit));
  }
  const after = items.filter((item) => compareToAnchor(item, cursor.anchor) > 0);
  return after.slice(0, limit);
};
