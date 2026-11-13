import { describe, expect, it } from 'vitest';

import { ascendingId, ascendingIdTime, createIdMinter, descendingId } from './ids.js';

describe('wire ids', () => {
  it('has the prefix, 12 hex characters and 14 base62 characters', () => {
    expect(ascendingId('msg')).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(descendingId('ses')).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it('reproduces the layout of a real OpenCode event id', () => {
    // Captured from OpenCode 2.2.6: the 12 hex digits are the low 36 bits of the
    // millisecond clock followed by a 12-bit counter.
    const minter = createIdMinter({ now: () => 0x1a1c32f9046, random: () => 'AAAAAAAAAAAAAA' });
    expect(minter.ascending('evt')).toBe('evt_1c32f9046001AAAAAAAAAAAAAA');
    expect(ascendingIdTime('evt_1c32f9046001AAAAAAAAAAAAAA')).toBe(0x1c32f9046);
  });

  it('sorts ascending ids oldest first, including within one millisecond', () => {
    let clock = 1_000;
    const minter = createIdMinter({ now: () => clock });
    const ids = [minter.ascending('msg'), minter.ascending('msg')];
    clock += 1;
    ids.push(minter.ascending('msg'));
    expect([...ids].sort()).toEqual(ids);
  });

  it('sorts session ids newest first', () => {
    let clock = 1_000;
    const minter = createIdMinter({ now: () => clock });
    const older = minter.descending('ses');
    clock += 5;
    const newer = minter.descending('ses');
    expect(newer < older).toBe(true);
  });

  it('draws random characters from the whole alphabet without bias toward the first ones', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i += 1) for (const ch of ascendingId('evt').slice(-14)) seen.add(ch);
    expect(seen.size).toBeGreaterThan(55);
  });

  it('returns null for the time of something that is not an id', () => {
    expect(ascendingIdTime('nope')).toBeNull();
  });
});
