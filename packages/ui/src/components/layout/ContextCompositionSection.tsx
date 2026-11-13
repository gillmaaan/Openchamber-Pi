import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  fetchContextComposition,
  type ContextComposition,
  type ContextCompositionCategory,
  type ContextCompositionItem,
} from '@/lib/contextComposition';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type LoadState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; composition: ContextComposition }
  | { phase: 'failed' };

const CATEGORY_LABEL_KEYS = {
  system: 'contextSidebar.composition.category.system',
  instructions: 'contextSidebar.composition.category.instructions',
  skills: 'contextSidebar.composition.category.skills',
  builtinTools: 'contextSidebar.composition.category.builtinTools',
  customTools: 'contextSidebar.composition.category.customTools',
} as const;

/** The parts of the system prompt Pi renders itself; a section somebody added carries its own label. */
const PART_LABEL_KEYS = {
  preamble: 'contextSidebar.composition.part.preamble',
  toolList: 'contextSidebar.composition.part.toolList',
  rules: 'contextSidebar.composition.part.rules',
  docs: 'contextSidebar.composition.part.docs',
  workingDirectory: 'contextSidebar.composition.part.workingDirectory',
  other: 'contextSidebar.composition.part.other',
} as const;

const formatTokens = (tokens: number): string => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: tokens >= 10_000 ? 'compact' : 'standard',
  maximumFractionDigits: 1,
}).format(tokens);

const formatShare = (tokens: number, base: number): string => {
  if (base <= 0) return '';
  const share = (tokens / base) * 100;
  return `${share < 0.1 && tokens > 0 ? '<0.1' : share.toFixed(share < 10 ? 1 : 0)}%`;
};

const ItemRow: React.FC<{
  item: ContextCompositionItem;
  label: string;
  base: number;
  expanded: boolean;
  onToggle: (id: string) => void;
}> = ({ item, label, base, expanded, onToggle }) => (
  <div>
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-[var(--interactive-hover)]"
      aria-expanded={expanded}
      onClick={() => onToggle(item.id)}
    >
      <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
      <span className="min-w-0 truncate typography-micro text-foreground" dir="auto" title={label}>{label}</span>
      {item.detail ? <span className="min-w-0 truncate typography-micro text-muted-foreground" dir="auto">{item.detail}</span> : null}
      <span className="ms-auto shrink-0 typography-micro tabular-nums text-muted-foreground">{formatTokens(item.tokens)}</span>
      <span className="w-10 shrink-0 text-end typography-micro tabular-nums text-muted-foreground">{formatShare(item.tokens, base)}</span>
    </button>
    {expanded ? (
      <ScrollableOverlay outerClassName="mx-2 mb-1 max-h-[22rem] rounded-md bg-[var(--surface-background)]" className="p-2.5" disableHorizontal>
        <pre dir="auto" className="whitespace-pre-wrap break-words font-mono typography-micro text-foreground/90">{item.text}</pre>
      </ScrollableOverlay>
    ) : null}
  </div>
);

const CategoryBlock: React.FC<{
  category: ContextCompositionCategory;
  base: number;
  expanded: boolean;
  onToggle: (id: string) => void;
  expandedItems: ReadonlySet<string>;
  onToggleItem: (id: string) => void;
}> = ({ category, base, expanded, onToggle, expandedItems, onToggleItem }) => {
  const { t } = useI18n();
  const itemLabel = (item: ContextCompositionItem): string => {
    if (category.id !== 'system') return item.label;
    if (item.label) return item.label;
    const key = (PART_LABEL_KEYS as Record<string, (typeof PART_LABEL_KEYS)[keyof typeof PART_LABEL_KEYS]>)[item.id];
    return key ? t(key) : item.id;
  };
  return (
    <div className="rounded-lg bg-[var(--surface-elevated)]/70">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-start hover:bg-[var(--interactive-hover)]"
        aria-expanded={expanded}
        onClick={() => onToggle(category.id)}
      >
        <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
        <span className="typography-ui-label text-foreground">{t(CATEGORY_LABEL_KEYS[category.id])}</span>
        <span className="typography-micro tabular-nums text-muted-foreground">{category.items.length}</span>
        <span className="ms-auto shrink-0 typography-micro tabular-nums text-muted-foreground">{formatTokens(category.tokens)}</span>
        <span className="w-10 shrink-0 text-end typography-micro tabular-nums text-muted-foreground">{formatShare(category.tokens, base)}</span>
      </button>
      {expanded ? (
        <div className="px-1 pb-1.5">
          {category.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              label={itemLabel(item)}
              base={base}
              expanded={expandedItems.has(item.id)}
              onToggle={onToggleItem}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * What the agent sends before the conversation, by category and item, read
 * from the agent when the section is opened. Closed, it costs nothing: the
 * agent is not asked until the reader wants the breakdown.
 */
export const ContextCompositionSection: React.FC<{
  sessionId: string;
  /** The model's window, the base of the shares; falls back to the composition's own total. */
  contextLimit: number | null;
}> = ({ sessionId, contextLimit }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<LoadState>({ phase: 'idle' });
  const [expandedCategories, setExpandedCategories] = React.useState<ReadonlySet<string>>(new Set());
  const [expandedItems, setExpandedItems] = React.useState<ReadonlySet<string>>(new Set());
  const requestRef = React.useRef<AbortController | null>(null);

  const load = React.useCallback(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState((previous) => (previous.phase === 'ready' ? previous : { phase: 'loading' }));
    fetchContextComposition(sessionId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setState(result.status === 'ok' ? { phase: 'ready', composition: result.composition } : { phase: 'failed' });
      },
      () => { /* aborted by a newer load or by leaving */ },
    );
  }, [sessionId]);

  // Another session has another composition; the open state stays with the reader.
  React.useEffect(() => {
    requestRef.current?.abort();
    setState({ phase: 'idle' });
    setExpandedCategories(new Set());
    setExpandedItems(new Set());
  }, [sessionId]);

  React.useEffect(() => {
    if (open && state.phase === 'idle') load();
  }, [open, state.phase, load]);

  React.useEffect(() => () => requestRef.current?.abort(), []);

  const toggleIn = (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>) => (id: string) => {
    setter((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const composition = state.phase === 'ready' ? state.composition : null;
  const base = contextLimit && contextLimit > 0 ? contextLimit : (composition?.totalTokens ?? 0);

  return (
    <div className="mb-6">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-start hover:bg-[var(--interactive-hover)]"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
          <span className="typography-micro text-muted-foreground">{t('contextSidebar.composition.title')}</span>
          {composition ? <span className="typography-micro tabular-nums text-muted-foreground">≈ {formatTokens(composition.totalTokens)}</span> : null}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex text-muted-foreground" tabIndex={0} aria-label={t('contextSidebar.composition.info')}>
              <Icon name="information" className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="max-w-72">{t('contextSidebar.composition.info')}</TooltipContent>
        </Tooltip>
        {open && composition ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="ms-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
                aria-label={t('contextSidebar.composition.refresh')}
                onClick={load}
              >
                <Icon name="refresh" className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('contextSidebar.composition.refresh')}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {open ? (
        <div className={cn('mt-2 space-y-1')}>
          {state.phase === 'loading' || state.phase === 'idle' ? (
            <div className="px-2 py-1 typography-micro text-muted-foreground">{t('contextSidebar.composition.loading')}</div>
          ) : null}
          {state.phase === 'failed' ? (
            <div className="flex items-center gap-2 px-2 py-1 typography-micro text-muted-foreground">
              <span>{t('contextSidebar.composition.failed')}</span>
              <button type="button" className="cursor-pointer text-foreground hover:underline" onClick={load}>
                {t('contextSidebar.composition.retry')}
              </button>
            </div>
          ) : null}
          {composition?.categories.filter((category) => category.items.length > 0).map((category) => (
            <CategoryBlock
              key={category.id}
              category={category}
              base={base}
              expanded={expandedCategories.has(category.id)}
              onToggle={toggleIn(setExpandedCategories)}
              expandedItems={expandedItems}
              onToggleItem={toggleIn(setExpandedItems)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};
