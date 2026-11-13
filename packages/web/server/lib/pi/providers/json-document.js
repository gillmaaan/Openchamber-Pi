// A JSON file that holds an object, edited in place: `models.json` and
// `settings.json` of Pi's agent directory, plus the small files OpenChamber
// keeps beside them.
//
// Every write is a synchronous read, edit and replace of the whole file. There
// is no await between the read and the write, so two requests in this process
// cannot interleave and the later one always edits what the earlier one wrote.
// Keys the editor does not know stay where they are. A file that cannot be read
// or parsed is never replaced: the write is refused with the reason, because a
// replacement would erase whatever the user had in it.

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../../opencode/atomic-write.js';

export class JsonDocumentError extends Error {
  /** @param {'unreadable' | 'invalid'} code */
  constructor(code, message) {
    super(message);
    this.name = 'JsonDocumentError';
    this.code = code;
  }
}

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * @param {object} options
 * @param {() => string} options.getFilePath  Read at every call, so a changed agent directory applies.
 * @param {string} [options.schemaUrl]  Written as `$schema` when the file is created.
 * @param {(document: Record<string, unknown>) => string | null} [options.check]  A reason the shape is unusable, or null.
 * @param {number} [options.mode]  Permission bits of a file this editor creates (keys and tokens may land in it).
 */
export const createJsonDocument = ({ getFilePath, schemaUrl, check = () => null, mode = 0o600 }) => {
  /** @returns {{ file: string, exists: boolean, value: Record<string, unknown> }} */
  const read = () => {
    const file = getFilePath();
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return { file, exists: false, value: schemaUrl ? { $schema: schemaUrl } : {} };
      }
      throw new JsonDocumentError('unreadable', `Cannot read ${file}: ${error.message}`);
    }
    let value;
    try {
      value = JSON.parse(stripBom(text));
    } catch (error) {
      throw new JsonDocumentError('invalid', `Cannot parse ${file}: ${error.message}. Fix or remove the file, then try again.`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new JsonDocumentError('invalid', `${file} must hold a JSON object. Fix or remove the file, then try again.`);
    }
    const problem = check(value);
    if (problem) throw new JsonDocumentError('invalid', `${file}: ${problem}. Fix the file, then try again.`);
    return { file, exists: true, value };
  };

  /**
   * Edits the document. `edit` gets a copy to change in place and returns what
   * the caller wants back; nothing is written when it changed nothing.
   *
   * @template T
   * @param {(draft: Record<string, any>) => T} edit  Synchronous on purpose.
   * @returns {{ result: T, file: string, written: boolean }}
   */
  const update = (edit) => {
    const current = read();
    const draft = structuredClone(current.value);
    const result = edit(draft);
    const next = `${JSON.stringify(draft, null, 2)}\n`;
    if (JSON.stringify(draft) === JSON.stringify(current.value)) return { result, file: current.file, written: false };
    fs.mkdirSync(path.dirname(current.file), { recursive: true });
    writeFileAtomic(current.file, next);
    if (!current.exists && process.platform !== 'win32') fs.chmodSync(current.file, mode);
    return { result, file: current.file, written: true };
  };

  return { read, update };
};
