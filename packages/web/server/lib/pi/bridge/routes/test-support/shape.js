// Comparing the shape of a response with a captured OpenCode response: the set
// of key paths (`data[].variants[].id`), not the values.

import { expect } from 'vitest';

/**
 * @param {unknown} value
 * @param {string[]} [records]  Paths whose keys are data, not schema (a map of
 *   models by id): their keys are folded into `*`.
 */
export const keyPaths = (value, records = []) => {
  const paths = new Set();
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      const next = `${at}[]`;
      paths.add(next);
      for (const element of node) walk(element, next);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const fold = records.includes(at);
      for (const [key, child] of Object.entries(node)) {
        const name = fold ? '*' : key;
        const next = at ? `${at}.${name}` : name;
        paths.add(next);
        walk(child, next);
      }
    }
  };
  walk(value, '');
  return [...paths].sort();
};

/**
 * The response has exactly the reference's key paths, apart from the ones the
 * test names as deliberate: `missing` are in the reference only, `extra` in the
 * response only.
 */
export const expectShape = (actual, reference, { records = [], missing = [], extra = [] } = {}) => {
  const actualPaths = new Set(keyPaths(actual, records));
  const referencePaths = new Set(keyPaths(reference, records));
  expect({
    missing: [...referencePaths].filter((path) => !actualPaths.has(path)).sort(),
    extra: [...actualPaths].filter((path) => !referencePaths.has(path)).sort(),
  }).toEqual({ missing: [...missing].sort(), extra: [...extra].sort() });
};
