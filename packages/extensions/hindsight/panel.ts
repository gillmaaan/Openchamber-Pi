import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountList, mountMenu, mountSearchField, mountSelect, mountTabs, mountTextField } from '@openchamber/sdk/ui';
import { count, HindsightError, parsePage, parseViewBank, parseViewEntry, record, text, type Bank, type Entry, type Page, type Resource, type Settings, type Stats } from './model.ts';
import { messagesFor, type MessageKey } from './messages.ts';

type View = { kind: 'list' } | { kind: 'detail'; entry: Entry; resource: Resource }
  | { kind: 'edit'; entry: Entry; draft: string; context: string }
  | { kind: 'settings'; draft: Settings }
  | { kind: 'confirm'; entry: Entry; resource: Resource; action: 'archive' | 'restore' | 'remove' };

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing panel root');
const app = root;
let messages = messagesFor('en');
let locale = 'en';
let mounted = false;
let banks: Bank[] = [];
let bankTotal = 0;
let bank = '';
let resource: Resource = 'memories';
let memoryState: 'valid' | 'invalidated' = 'valid';
let page: Page<Entry> | null = null;
let stats: Stats | null = null;
let view: View = { kind: 'list' };
let query = '';
let submittedQuery = '';
let offset = 0;
let loading = false;
let mutating = false;
let error: MessageKey | null = null;
let generation = 0;
let bankGeneration = 0;
let disposables: { dispose(): void }[] = [];
const t = (key: MessageKey): string => messages[key];
const format = (n: number): string => new Intl.NumberFormat(locale).format(n);
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = ''): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
};
const note = (parent: Element, content: string, warning = false) => {
  const p = node('p', warning ? 'notice' : 'muted', content);
  parent.append(p);
};
const button = (parent: Element, label: MessageKey, onClick: () => void, destructive = false) => {
  const control = mountButton(parent, { label: t(label), size: 'sm', variant: destructive ? 'destructive' : 'outline', disabled: loading || mutating, onClick });
  disposables.push(control);
  return control;
};
const endpoint = (kind: string, id?: string, bankId = bank): string => `/banks/${encodeURIComponent(bankId)}/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`;

const request = async (method: 'GET' | 'PATCH' | 'DELETE', path: string, body?: unknown, params?: Record<string, string>): Promise<unknown> => {
  let result;
  try { result = await host.serviceRequest({ method, path, ...(params ? { query: params } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new HindsightError('unavailable'); }
  let value: unknown;
  try { value = JSON.parse(result.body); } catch { throw new HindsightError('invalidResponse'); }
  if (result.status >= 400) {
    const code = record(value).code;
    const known = ['configMissing', 'configInvalid', 'unauthorized', 'unavailable', 'upstream', 'invalidResponse', 'invalidRequest', 'tooLarge'] as const;
    throw new HindsightError(known.find((key) => key === code) ?? 'upstream');
  }
  return value;
};
const failureKey = (failure: unknown): MessageKey => failure instanceof HindsightError ? failure.code : 'invalidResponse';

const read = async <T>(fetchValue: () => Promise<T>, apply: (value: T) => void) => {
  const current = ++generation;
  loading = true; error = null; paint();
  try {
    const value = await fetchValue();
    if (current !== generation) return;
    apply(value);
  } catch (failure) { if (current === generation) error = failureKey(failure); }
  finally { if (current === generation) { loading = false; paint(); } }
};
const loadList = () => read(
  async () => parsePage(await request('GET', endpoint(resource), undefined, { q: resource === 'pages' ? '' : submittedQuery, offset: String(offset), state: memoryState }), parseViewEntry),
  (value) => { page = value; },
);
const loadStats = async () => {
  const selected = bank;
  const current = bankGeneration;
  try {
    const v = record(await request('GET', endpoint('stats')));
    const result = { memories: count(v.memories), documents: count(v.documents), pending: count(v.pending), failed: count(v.failed) };
    if (selected !== bank || current !== bankGeneration) return;
    stats = result;
    if (view.kind === 'list') paint();
  } catch { /* Statistics do not block complete memory and document lists. */ }
};
const selectBank = (id: string) => {
  if (mutating) return;
  bankGeneration++; bank = id; stats = null; page = null; offset = 0; query = ''; submittedQuery = ''; view = { kind: 'list' };
  void loadList(); void loadStats();
};
const loadBanks = (append = false) => read(async () => {
  await request('GET', '/connection');
  return parsePage(await request('GET', '/banks', undefined, { offset: String(append ? banks.length : 0) }), parseViewBank);
}, (value) => {
  banks = append ? [...banks, ...value.items] : value.items;
  bankTotal = value.total;
  if (!bank && banks[0]) queueMicrotask(() => selectBank(banks[0].id));
});
const openEntry = (id: string, kind = resource) => read(async () => parseViewEntry(await request('GET', endpoint(kind, id))), (entry) => { view = { kind: 'detail', entry, resource: kind }; });
const openSettings = () => read(async () => {
  const v = record(await request('GET', endpoint('settings')));
  return { reflect_mission: text(v.reflect_mission), retain_mission: text(v.retain_mission) };
}, (draft) => { view = { kind: 'settings', draft }; });
const changeResource = (id: string) => {
  if (mutating || (id !== 'memories' && id !== 'documents' && id !== 'pages' && id !== 'archived')) return;
  resource = id === 'archived' ? 'memories' : id;
  memoryState = id === 'archived' ? 'invalidated' : 'valid';
  view = { kind: 'list' }; page = null; offset = 0; query = ''; submittedQuery = '';
  void loadList();
};
const refresh = () => {
  if (!bank) { void loadBanks(); return; }
  if (view.kind === 'detail') void openEntry(view.entry.id, view.resource);
  else { void loadList(); void loadStats(); }
};

const mutate = async (method: 'PATCH' | 'DELETE', path: string, body: unknown, after: () => Promise<void>) => {
  if (mutating) return;
  mutating = true; error = null; paint();
  try {
    await request(method, path, body);
    await after();
    void loadStats();
  } catch (failure) { error = failureKey(failure); }
  finally { mutating = false; paint(); }
};
const saveMemory = (editing: Extract<View, { kind: 'edit' }>) => {
  void mutate('PATCH', endpoint('memories', editing.entry.id), { text: editing.draft, context: editing.context }, async () => {
    view = { kind: 'list' }; page = null;
    await loadList();
  });
};
const confirmMutation = (confirmation: Extract<View, { kind: 'confirm' }>) => {
  const deleting = confirmation.action === 'remove';
  void mutate(deleting ? 'DELETE' : 'PATCH', endpoint(confirmation.resource, confirmation.entry.id), deleting ? undefined : { state: confirmation.action === 'archive' ? 'invalidated' : 'valid' }, async () => {
    view = { kind: 'list' }; page = null; offset = 0;
    await loadList();
  });
};

function paint() {
  for (const handle of disposables) handle.dispose();
  disposables = [];
  app.replaceChildren();
  const locked = mutating || view.kind === 'edit' || view.kind === 'settings' || view.kind === 'confirm';
  const toolbar = node('div', 'toolbar'); app.append(toolbar);
  disposables.push(mountSelect(toolbar, {
    label: t('bank'), value: bank || null, searchable: true, searchPlaceholder: t('search'), disabled: locked || loading,
    options: banks.map((item) => ({ id: item.id, label: item.name, hint: item.name === item.id ? undefined : item.id })),
    onChange: selectBank,
  }));
  disposables.push(mountMenu(toolbar, {
    label: t('settings'), variant: 'ghost', size: 'sm',
    items: [{ id: 'refresh', label: t('refresh'), disabled: locked || loading }, { id: 'settings', label: t('settings'), disabled: locked || loading || !bank }],
    onSelect: (action) => { if (!locked) { if (action === 'settings') void openSettings(); else refresh(); } },
  }));
  if (banks.length < bankTotal) button(app, 'moreBanks', () => { void loadBanks(true); });
  const status = node('p', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.textContent = error ? t(error) : loading || mutating ? t('loading') : '';
  status.title = status.textContent; status.dataset.error = error ? 'true' : 'false'; app.append(status);
  if (!bank) return;

  if (view.kind === 'list') {
    const navigation = node('div', 'navigation'); app.append(navigation);
    disposables.push(mountTabs(navigation, { activeId: resource === 'memories' && memoryState === 'invalidated' ? 'archived' : resource, items: (['memories', 'documents', 'pages', 'archived'] as const).map((id) => ({ id, label: t(id) })), onChange: changeResource }));
    if (mutating) navigation.inert = true;
    const searchRow = node('form', 'search-row'); app.append(searchRow);
    disposables.push(mountSearchField(searchRow, { value: query, placeholder: t('searchHint'), onChange: (value) => { query = value; } }));
    button(searchRow, 'search', () => { submittedQuery = query; offset = 0; page = null; void loadList(); });
    searchRow.addEventListener('submit', (event) => { event.preventDefault(); if (!loading && !mutating && resource !== 'pages') { submittedQuery = query; offset = 0; page = null; void loadList(); } });
    searchRow.inert = loading || mutating || resource === 'pages';
    searchRow.hidden = resource === 'pages';
    if (stats) {
      note(app, `${t('memories')} ${format(stats.memories)} · ${t('documents')} ${format(stats.documents)}`);
      if (stats.pending || stats.failed) note(app, `${t('pending')} ${format(stats.pending)} · ${t('failed')} ${format(stats.failed)}`);
    }
    if (!page) return;
    const list = node('div', 'entries'); app.append(list);
    disposables.push(mountList(list, { items: page.items.map((item) => ({ id: item.id, title: item.title || item.id, meta: item.type === 'memories' || item.type === 'documents' || item.type === 'pages' ? undefined : item.type, subtitle: item.state === 'invalidated' ? t('archived') : undefined })), emptyText: t('empty'), ariaLabel: t(resource), onSelect: (id) => { if (!mutating) void openEntry(id); } }));
    const pagination = node('div', 'pagination'); app.append(pagination);
    const prev = button(pagination, 'previous', () => { offset = Math.max(0, offset - 50); void loadList(); });
    prev.update({ disabled: loading || mutating || offset === 0 });
    const range = page.items.length ? `${format(page.offset + 1)}–${format(page.offset + page.items.length)}` : '0';
    const total = node('span', 'muted', `${range} / ${page.estimated ? '≥ ' : ''}${format(page.total)}`); total.dir = 'auto'; pagination.append(total);
    const next = button(pagination, 'next', () => { offset += 50; void loadList(); });
    next.update({ disabled: loading || mutating || page.offset + page.items.length >= page.total || page.items.length === 0 });
    return;
  }

  const content = node('div', 'detail'); app.append(content);
  if (view.kind === 'settings') {
    const current = view;
    note(content, t('settingsWarning'), true);
    disposables.push(mountTextField(content, { label: t('reflectMission'), value: current.draft.reflect_mission, multiline: true, rows: 8, disabled: mutating, onChange: (value) => { current.draft.reflect_mission = value; } }));
    disposables.push(mountTextField(content, { label: t('retainMission'), value: current.draft.retain_mission, multiline: true, rows: 8, disabled: mutating, onChange: (value) => { current.draft.retain_mission = value; } }));
    const actions = node('div', 'actions'); content.append(actions);
    button(actions, 'save', () => { void mutate('PATCH', endpoint('settings'), current.draft, async () => { view = { kind: 'list' }; await loadList(); }); });
    button(actions, 'cancel', () => { view = { kind: 'list' }; paint(); });
    return;
  }
  const current = view;
  const title = node('p', 'entry-title', current.entry.title || current.entry.id); title.dir = 'auto'; title.title = title.textContent ?? ''; content.append(title);
  if (current.kind === 'confirm') {
    note(content, t(current.action === 'remove' ? 'deleteWarning' : 'archiveWarning'), true);
    const actions = node('div', 'actions'); content.append(actions);
    button(actions, 'confirm', () => confirmMutation(current), current.action !== 'restore');
    button(actions, 'cancel', () => { view = { kind: 'detail', entry: current.entry, resource: current.resource }; paint(); });
    return;
  }
  if (current.kind === 'edit') {
    note(content, t('editWarning'), true);
    disposables.push(mountTextField(content, { label: t('memories'), value: current.draft, multiline: true, rows: 12, disabled: mutating, onChange: (value) => { current.draft = value; } }));
    disposables.push(mountTextField(content, { label: t('context'), value: current.context, multiline: true, rows: 4, disabled: mutating, onChange: (value) => { current.context = value; } }));
    const actions = node('div', 'actions'); content.append(actions);
    button(actions, 'save', () => saveMemory(current));
    button(actions, 'cancel', () => { view = { kind: 'detail', entry: current.entry, resource: 'memories' }; paint(); });
    return;
  }
  const actions = node('div', 'actions'); content.append(actions);
  button(actions, 'back', () => { view = { kind: 'list' }; paint(); });
  const curatable = current.resource === 'memories' && ['world', 'experience'].includes(current.entry.type);
  if (curatable) {
    button(actions, 'edit', () => { view = { kind: 'edit', entry: current.entry, draft: current.entry.text, context: current.entry.context }; paint(); });
    button(actions, current.entry.state === 'invalidated' ? 'restore' : 'archive', () => { view = { kind: 'confirm', entry: current.entry, resource: current.resource, action: current.entry.state === 'invalidated' ? 'restore' : 'archive' }; paint(); });
  }
  if (current.resource === 'documents') button(actions, 'remove', () => { view = { kind: 'confirm', entry: current.entry, resource: current.resource, action: 'remove' }; paint(); }, true);
  if (current.entry.tags.length) note(content, `${t('tags')} · ${current.entry.tags.join(', ')}`);
  const body = node('pre', 'body', current.entry.text || t('notStored')); body.dir = 'auto'; content.append(body);
  if (current.entry.context) {
    note(content, t('context'));
    const context = node('pre', 'body', current.entry.context); context.dir = 'auto'; content.append(context);
  }
  if (current.entry.documentId) {
    const id = current.entry.documentId;
    button(content, 'source', () => { void openEntry(id, 'documents'); });
    const source = node('p', 'muted path', id); source.dir = 'ltr'; content.append(source);
  }
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  const changedLocale = locale !== context.locale;
  locale = context.locale;
  messages = messagesFor(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr';
  if (mounted) { if (changedLocale) paint(); return; }
  mounted = true;
  paint();
  void loadBanks();
});
