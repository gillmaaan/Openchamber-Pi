export type Resource = 'memories' | 'documents' | 'pages';
export type Bank = { id: string; name: string; count: number };
export type Entry = { id: string; title: string; text: string; context: string; tags: string[]; type: string; state: string; documentId: string | null };
export type Page<T> = { items: T[]; total: number; offset: number; estimated: boolean };
export type Stats = { memories: number; documents: number; pending: number; failed: number };
export type Settings = { reflect_mission: string; retain_mission: string };
export type ErrorCode = 'configMissing' | 'configInvalid' | 'unauthorized' | 'unavailable' | 'upstream' | 'invalidResponse' | 'invalidRequest' | 'tooLarge';

export class HindsightError extends Error {
  constructor(public readonly code: ErrorCode, public readonly status = 502) { super(code); }
}

export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HindsightError('invalidResponse');
  return value as Record<string, unknown>;
};
export const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new HindsightError('invalidResponse');
  return value;
};
const optionalText = (value: unknown): string => value == null ? '' : text(value);
export const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HindsightError('invalidResponse');
  return value;
};
const tags = (value: unknown): string[] => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HindsightError('invalidResponse');
  return value.map(text);
};

export const parseViewBank = (value: unknown): Bank => {
  const v = record(value);
  return { id: text(v.id), name: text(v.name), count: count(v.count) };
};
export const parseViewEntry = (value: unknown): Entry => {
  const v = record(value);
  return { id: text(v.id), title: text(v.title), text: text(v.text), context: text(v.context), tags: tags(v.tags), type: text(v.type), state: text(v.state), documentId: v.documentId == null ? null : text(v.documentId) };
};

export const parseBank = (value: unknown): Bank => {
  const v = record(value);
  return { id: text(v.bank_id), name: optionalText(v.name) || text(v.bank_id), count: count(v.fact_count ?? 0) };
};
export const parseEntry = (resource: Resource, value: unknown): Entry => {
  const v = record(value);
  const id = text(v.id);
  return {
    id,
    title: resource === 'pages' ? text(v.name) : resource === 'documents' ? id : text(v.text),
    text: resource === 'documents' ? optionalText(v.original_text) : resource === 'pages' ? optionalText(v.content) : text(v.text),
    context: resource === 'pages' ? optionalText(v.source_query) : optionalText(v.context),
    tags: tags(v.tags),
    type: resource === 'memories' ? optionalText(v.fact_type ?? v.type) : resource,
    state: optionalText(v.state) || 'valid',
    documentId: v.document_id == null ? null : text(v.document_id),
  };
};
export const parsePage = <T>(value: unknown, parse: (value: unknown) => T, key = 'items'): Page<T> => {
  const v = record(value);
  if (!Array.isArray(v[key])) throw new HindsightError('invalidResponse');
  return { items: v[key].map(parse), total: count(v.total), offset: count(v.offset), estimated: v.total_is_estimate === true };
};
export const parseStats = (value: unknown): Stats => {
  const v = record(value);
  return { memories: count(v.total_nodes), documents: count(v.total_documents), pending: count(v.pending_operations), failed: count(v.failed_operations) };
};
export const parseSettings = (value: unknown): Settings => {
  const v = record(record(value).config);
  return { reflect_mission: optionalText(v.reflect_mission), retain_mission: optionalText(v.retain_mission) };
};
