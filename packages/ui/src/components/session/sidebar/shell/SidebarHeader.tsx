import React from 'react';
import { canAddSidebarSection, closeSectionsManager, editSection, useSidebarSectionsUiStore } from '../sections/sectionActions';
import { createSidebarSectionFromTemplate, SIDEBAR_SECTION_NAME_MAX, SIDEBAR_SECTION_TEXT_MAX } from '@/lib/sidebarSections';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';

const loadSectionsManager = () => import('../sections/SidebarSectionsManager').then((module) => module.SidebarSectionsManager);
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useI18n } from '@/lib/i18n';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import { arrangeSidebarNav, isGuestPageNavId, type SidebarMode } from '@/lib/sidebarNav';
import { SidebarDisplayMenu } from './SidebarDisplayMenu';
import { SidebarModeSwitch } from './SidebarModeSwitch';
import { SidebarNavRow } from './SidebarNavRow';
import { useSidebarPages } from './useSidebarPages';

type Props = {
  hideDirectoryControls: boolean;
  showProjectDisplayControls: boolean;
  showSectionControls: boolean;
  handleOpenDirectoryDialog: () => void;
  /** Starts a chat that belongs to no project. */
  onNewChat: () => void;
  /** The list the sidebar shows: the chats that belong to no project, or the projects. */
  sidebarMode: SidebarMode;
  /** Chat is offered only while the Chats section is on. */
  showModeSwitch: boolean;
  onSidebarModeChange: (mode: SidebarMode) => void;
  /** Whether the issues and pull requests board is offered. */
  showSourceBoard: boolean;
  isSessionSearchOpen: boolean;
  openSessionSearch: () => void;
  /** Hides the field and drops its query. */
  closeSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  collapseAll: () => void;
  expandAll: () => void;
  /** The usage stats page, which the app's own runtimes offer. */
  showStats: boolean;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  // The header spans the sidebar: the sections manager opens beside its end
  // edge, so the section being edited shows in the list as it stands.
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  // The manager and its editor load the first time they open.
  const sectionsManagerOpen = useSidebarSectionsUiStore((state) => state.managerOpen);
  const sidebarSections = useSessionDisplayStore((state) => state.sections);
  const SectionsManager = useOnDemandComponent(props.showSectionControls && sectionsManagerOpen, loadSectionsManager, closeSectionsManager);
  const {
    hideDirectoryControls,
    showProjectDisplayControls,
    showSectionControls,
    handleOpenDirectoryDialog,
    onNewChat,
    sidebarMode,
    showModeSwitch,
    onSidebarModeChange,
    showSourceBoard,
    isSessionSearchOpen,
    openSessionSearch,
    closeSessionSearch,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    collapseAll,
    expandAll,
    showStats,
  } = props;

  const pages = useSidebarPages({ showSourceBoard, showStats });
  const shownRows = useSessionDisplayStore((state) => state.sidebarNav[sidebarMode]);
  const { rows: pageRows, more: morePages } = arrangeSidebarNav(pages, shownRows);

  // What the search found, kept as a section: the query becomes its words to
  // find and its name, in the editor, with the search closed so the sidebar
  // shows the section being made. An id lookup finds one session, not a topic.
  const searchText = sessionSearchQuery.trim();
  const canSaveSearch = showSectionControls && sidebarMode === 'code' && searchText !== '' && !searchText.toLowerCase().startsWith('ses_')
    && canAddSidebarSection(sidebarSections);
  const saveSearchAsSection = () => {
    const section = createSidebarSectionFromTemplate('blank', searchText.slice(0, SIDEBAR_SECTION_NAME_MAX));
    editSection({ ...section, filter: { ...section.filter, text: [searchText.slice(0, SIDEBAR_SECTION_TEXT_MAX)] } }, true);
    closeSessionSearch();
  };

  if (hideDirectoryControls) {
    // VS Code: the sidebar is always a single workspace, so project/directory
    // controls stay hidden, but session search is still useful. Show a compact,
    // always-visible search input at the top of the sessions list.
    return (
      <div className="select-none flex-shrink-0 px-2.5 py-1.5">
        <SessionSearchInput
          inputRef={sessionSearchInputRef}
          value={sessionSearchQuery}
          onSearch={setSessionSearchQuery}
          onClose={closeSessionSearch}
          placeholder={t('sessions.sidebar.header.search.placeholder')}
          clearLabel={t('sessions.sidebar.header.search.clear')}
          leadingHint={hasSessionSearchQuery
            ? (searchMatchCount === 1
              ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
              : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
            : undefined}
          trailingHint={t('sessions.sidebar.header.search.escapeHint')}
        />
      </div>
    );
  }

  const iconClass = 'size-[17px]';
  const checkMark = <Icon name="check" className="h-4 w-4 text-primary" />;
  const morePageOpen = morePages.some((page) => page.open);
  const morePagesBuiltin = morePages.filter((page) => !isGuestPageNavId(page.id));
  const morePagesGuest = morePages.filter((page) => isGuestPageNavId(page.id));
  const renderMoreItem = (page: (typeof morePages)[number]) => (
    <DropdownMenuItem key={page.id} onClick={page.onToggle} className="flex items-center gap-2">
      {page.renderIcon('h-4 w-4')}
      <span className="flex-1">{page.label}</span>
      {page.open ? checkMark : null}
      {page.shortcut ? <span className="ms-auto ps-3 typography-meta text-muted-foreground"><span dir="ltr">{page.shortcut}</span></span> : null}
    </DropdownMenuItem>
  );

  return (
    <div ref={headerRef} className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex flex-col gap-0.5">
        {/* The mode switch has the first line to itself, as wide as a row's
            highlight in the list below. The list starts at the header's 10px
            and ends 14px before the sidebar's edge (its 8px padding and the
            6px scrollbar gutter), where the header's own padding is 10px, so
            4px more are left off the end. */}
        {showModeSwitch ? (
          <div className="pb-5 pe-1 pt-0.5">
            <SidebarModeSwitch mode={sidebarMode} onChange={onSidebarModeChange} wide />
          </div>
        ) : null}

        {showSectionControls && SectionsManager ? (
          <SectionsManager anchor={headerRef} pages={pages} sidebarMode={sidebarMode} showModeSwitch={showModeSwitch} />
        ) : null}

        {/* The menu of the mode in labelled lines, the ones used all the time
            first: what starts something, then the search, then the pages the
            user arranged. Pages left out are under More. */}
        <div className="flex flex-col gap-1 pb-3">
          {sidebarMode === 'chat' ? (
            <SidebarNavRow
              strong
              icon={<Icon name="add" className={iconClass} />}
              label={t('sessions.sidebar.nav.new')}
              onClick={onNewChat}
            />
          ) : (
            <SidebarNavRow
              strong
              icon={<Icon name="folder-add" className={iconClass} />}
              label={t('sessions.sidebar.header.actions.addProject')}
              onClick={handleOpenDirectoryDialog}
            />
          )}

          {isSessionSearchOpen ? (
            <div className="py-0.5">
              <SessionSearchInput
                inputRef={sessionSearchInputRef}
                value={sessionSearchQuery}
                onSearch={setSessionSearchQuery}
                onClose={closeSessionSearch}
                placeholder={t('sessions.sidebar.header.search.placeholder')}
                clearLabel={t('sessions.sidebar.header.search.clear')}
                leadingHint={hasSessionSearchQuery
                  ? (searchMatchCount === 1
                    ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
                    : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
                  : undefined}
                trailingHint={canSaveSearch ? (
                  <button type="button" onClick={saveSearchAsSection} className="text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                    {t('sessions.sidebar.sections.saveSearch')}
                  </button>
                ) : t('sessions.sidebar.header.search.escapeHint')}
              />
            </div>
          ) : (
            <SidebarNavRow
              icon={<Icon name="search" className={iconClass} />}
              label={t('sessions.sidebar.header.actions.searchSessions')}
              aria-expanded={false}
              onClick={openSessionSearch}
            />
          )}

          {pageRows.map((page) => (
            <SidebarNavRow
              key={page.id}
              icon={page.renderIcon(iconClass)}
              label={page.label}
              pressed={page.open}
              onClick={page.onToggle}
            />
          ))}

          {morePages.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* A page from the menu is open: the row says where it came from. */}
                <SidebarNavRow
                  icon={<Icon name="more" className={iconClass} />}
                  label={t('sessions.sidebar.header.actions.more')}
                  pressed={morePageOpen}
                />
              </DropdownMenuTrigger>
              {/* Every page lives here, so a short window scrolls the list instead of cutting it. */}
              <DropdownMenuContent align="start" className="min-w-[200px] overflow-y-auto">
                {morePagesBuiltin.map(renderMoreItem)}
                {morePagesGuest.length > 0 ? <>
                  {morePagesBuiltin.length > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>{t('sessions.sidebar.header.actions.extensionPages')}</DropdownMenuLabel>
                  {morePagesGuest.map(renderMoreItem)}
                </> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Cowork mode has it as an icon at the end of the Chats caption. */}
          {sidebarMode === 'code' ? (
            <SidebarDisplayMenu
              sidebarMode={sidebarMode}
              showProjectDisplayControls={showProjectDisplayControls}
              showSectionControls={showSectionControls}
              collapseAll={collapseAll}
              expandAll={expandAll}
              trigger={(
                <SidebarNavRow
                  icon={<Icon name="equalizer-2" className={iconClass} />}
                  label={t('sessions.sidebar.header.displayMode.label')}
                />
              )}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
