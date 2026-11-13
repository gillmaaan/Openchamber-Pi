// Session records as OpenCode serves them (`SessionInfo`), assembled from three
// sources: Pi's session file (what the transcript knows: cwd, name, usage, last
// model), the sidecar store (what only OpenChamber knows: archived, viewed,
// metadata, the agent), and drafts, sessions that exist before Pi writes a file.

import { decodeCursor, pageCursor } from './cursor.js';
import { invalidRequest } from './errors.js';
import { paginate } from './paginate.js';
import { resolveProject } from './project.js';

const TITLE_FROM_PROMPT_LENGTH = 80;
const PROJECT_CACHE_TTL_MS = 10_000;
const PROJECT_CACHE_SIZE = 500;
const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const titleFromPrompt = (text) => {
  const line = String(text ?? '').trim().split('\n')[0]?.trim() ?? '';
  if (!line) return undefined;
  return line.length > TITLE_FROM_PROMPT_LENGTH ? `${line.slice(0, TITLE_FROM_PROMPT_LENGTH - 1)}…` : line;
};

const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {object} deps
 * @param {{ list: () => Promise<object[]>, get: (id: string) => Promise<object|null> }} deps.fileIndex
 * @param {{ get: (id: string) => object|null, drafts: () => Array<{id: string, directory: string, createdAt: number}> }} deps.metaStore
 * @param {(usage: object) => { tokens: object, cost: number }} deps.toWireUsage  Pi usage sums to wire tokens and cost.
 * @param {(directory: string) => ReturnType<typeof resolveProject>} [deps.projectOf]
 */
export const createSessionRecords = ({ fileIndex, metaStore, toWireUsage, projectOf = resolveProject }) => {
  const projectCache = new Map();
  const project = (directory) => {
    const cached = projectCache.get(directory);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = projectOf(directory);
    projectCache.set(directory, { value, expires: Date.now() + PROJECT_CACHE_TTL_MS });
    if (projectCache.size > PROJECT_CACHE_SIZE) projectCache.delete(projectCache.keys().next().value);
    return value;
  };

  // A model switched through the API wins over the one Pi last recorded.
  const modelOf = (meta, source) => {
    if (meta.model) return { id: meta.model.id, providerID: meta.model.providerID, variant: meta.model.variant ?? 'default' };
    if (source.model) return { id: source.model.modelId, providerID: source.model.provider, variant: source.thinkingLevel ?? 'default' };
    return undefined;
  };

  /** One record from a source (a Pi file's summary or a draft) and its sidecar entry. */
  const record = (source) => {
    const meta = metaStore.get(source.id) ?? {};
    const projectInfo = project(source.directory);
    const { tokens, cost } = source.usage ? toWireUsage(source.usage) : { tokens: ZERO_TOKENS, cost: 0 };
    const title = meta.title ?? source.name ?? titleFromPrompt(source.firstUserText);
    const model = modelOf(meta, source);
    return {
      id: source.id,
      ...(meta.parentID ? { parentID: meta.parentID } : {}),
      ...(meta.fork ? { fork: meta.fork } : {}),
      ...(meta.revert ? { revert: meta.revert } : {}),
      projectID: projectInfo.id,
      ...(meta.agent ? { agent: meta.agent } : {}),
      ...(model ? { model } : {}),
      cost,
      tokens,
      ...(meta.outcome ? { outcome: meta.outcome } : {}),
      time: {
        created: source.createdAt,
        updated: Math.max(source.updatedAt, meta.updatedAt ?? 0),
        ...(meta.busyAt ? { busy: meta.busyAt } : {}),
        ...(meta.idleAt ? { idle: meta.idleAt } : {}),
        ...(meta.viewedAt ? { viewed: meta.viewedAt } : {}),
        ...(meta.archivedAt ? { archived: meta.archivedAt } : {}),
      },
      ...(title ? { title } : {}),
      location: { directory: source.directory },
      ...(projectInfo.subpath ? { subpath: projectInfo.subpath } : {}),
      ...(meta.metadata ? { metadata: meta.metadata } : {}),
      ...(meta.permissions ? { permissions: meta.permissions } : {}),
    };
  };

  const fileSource = (file) => ({
    id: file.id,
    directory: file.cwd,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    name: file.name,
    firstUserText: file.firstUserText,
    usage: file.usage,
    model: file.model,
    thinkingLevel: file.thinkingLevel,
  });

  const draftSource = (draft) => ({ id: draft.id, directory: draft.directory, createdAt: draft.createdAt, updatedAt: draft.createdAt });

  const get = async (id) => {
    const file = await fileIndex.get(id);
    if (file) return record(fileSource(file));
    const draft = metaStore.drafts().find((candidate) => candidate.id === id);
    return draft ? record(draftSource(draft)) : null;
  };

  /** Every session: Pi files first, then drafts that have no file yet. */
  const loadAll = async () => {
    const files = await fileIndex.list();
    const known = new Set(files.map((file) => file.id));
    const records = files.map((file) => ({ record: record(fileSource(file)), searchable: file.firstUserText ?? '' }));
    for (const draft of metaStore.drafts()) {
      if (!known.has(draft.id)) records.push({ record: record(draftSource(draft)), searchable: '' });
    }
    return records;
  };

  const matches = ({ record: candidate, searchable }, filters) => {
    if (filters.directory && candidate.location.directory !== filters.directory) return false;
    if (filters.project && candidate.projectID !== filters.project) return false;
    if (filters.subpath !== undefined && (candidate.subpath ?? '') !== filters.subpath) return false;
    if (filters.archived === 'true' && !candidate.time.archived) return false;
    if (filters.archived === 'false' && candidate.time.archived) return false;
    if (filters.parentID === 'null' && candidate.parentID) return false;
    if (filters.parentID && filters.parentID !== 'null' && candidate.parentID !== filters.parentID) return false;
    if (filters.search && !`${candidate.title ?? ''}\n${searchable}`.toLowerCase().includes(filters.search.toLowerCase())) return false;
    return true;
  };

  const readFilters = (query, decoded) => decoded?.filters ?? {
    directory: query.get('directory') || undefined,
    project: query.get('project') || undefined,
    subpath: query.get('subpath') ?? undefined,
    archived: query.get('archived') || undefined,
    parentID: query.get('parentID') || undefined,
    search: query.get('search') || undefined,
  };

  /** One page of the global list, newest change first unless `order=asc`. `query` is the request's URLSearchParams. */
  const list = async (query) => {
    const limitText = query.get('limit');
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw invalidRequest('Expected a value greater than 0\n  at ["limit"]', { kind: 'Query' });
    }
    const order = query.get('order') ?? 'desc';
    if (order !== 'asc' && order !== 'desc') throw invalidRequest('Expected "asc" | "desc"\n  at ["order"]', { kind: 'Query' });

    const cursorText = query.get('cursor');
    const decoded = cursorText ? decodeCursor(cursorText) : null;
    // Later pages send only `cursor` and `limit`; the filters travel inside it.
    const filters = readFilters(query, decoded);
    const direction = order === 'asc' ? 1 : -1;
    const byOrder = (a, b) => direction * (a.time.updated - b.time.updated || compareIds(a.id, b.id));

    const sorted = (await loadAll())
      .filter((entry) => matches(entry, filters))
      .map((entry) => entry.record)
      .sort(byOrder);
    const compareToAnchor = (item, anchor) => direction * (item.time.updated - anchor.time || compareIds(item.id, anchor.id));
    const page = paginate(sorted, {
      limit,
      cursor: decoded?.anchor ? { direction: decoded.anchor.direction, anchor: decoded.anchor } : null,
      compareToAnchor,
    });

    const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
    const cursor = pageCursor(page, (item, anchorDirection) => ({
      ...(Object.keys(activeFilters).length ? { filters: activeFilters } : {}),
      anchor: { id: item.id, time: item.time.updated, direction: anchorDirection },
    }));
    return { data: page, cursor };
  };

  return { get, list };
};
