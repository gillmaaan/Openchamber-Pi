// Ids in OpenCode's wire format (`@opencode/schema` Identifier): a prefix, a
// 6-byte time prefix in hex, then 14 random base62 characters. The time prefix
// counts up with time for ascending ids (messages, events) and is bitwise
// inverted for descending ones (sessions, which list newest first), so lexical
// order is time order either way. The UI mints ids in the same format
// (`packages/ui/src/lib/opencode/ids.ts`); both must sort together.

import { randomBytes } from 'node:crypto';

const RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 14;
const TIME_MASK = (1n << 48n) - 1n;

const randomBase62 = (length) => {
  // Rejecting bytes above the largest multiple of 62 below 256 keeps every character equally likely.
  const limit = 256 - (256 % RANDOM_CHARS.length);
  let result = '';
  while (result.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      result += RANDOM_CHARS[byte % RANDOM_CHARS.length];
      if (result.length === length) break;
    }
  }
  return result;
};

/** A generator whose counter is its own, so tests control the clock. */
export const createIdMinter = ({ now = () => Date.now(), random = randomBase62 } = {}) => {
  let lastTimestamp = 0;
  let counter = 0;

  const mint = (prefix, descending) => {
    const timestamp = now();
    if (timestamp !== lastTimestamp) {
      lastTimestamp = timestamp;
      counter = 0;
    }
    counter += 1;
    const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
    const sortable = (descending ? ~current : current) & TIME_MASK;
    return `${prefix}_${sortable.toString(16).padStart(12, '0')}${random(RANDOM_LENGTH)}`;
  };

  return {
    /** msg, evt, and the other ids that sort oldest first. */
    ascending: (prefix) => mint(prefix, false),
    /** ses: newest first. */
    descending: (prefix) => mint(prefix, true),
  };
};

const shared = createIdMinter();

export const ascendingId = (prefix) => shared.ascending(prefix);
export const descendingId = (prefix) => shared.descending(prefix);

/** The millisecond timestamp (low 36 bits) an ascending id was minted at. */
export const ascendingIdTime = (id) => {
  const hex = /^[a-z]+_([0-9a-f]{12})/.exec(id)?.[1];
  if (!hex) return null;
  return Number((BigInt(`0x${hex}`) >> 12n) & ((1n << 36n) - 1n));
};
