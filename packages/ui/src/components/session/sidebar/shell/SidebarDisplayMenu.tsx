import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import type { SidebarMode } from '@/lib/sidebarNav';
import { resolveSidebarGrouping, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { markAllSessionsViewed } from '@/sync/notification-store';
import { useHasUnreadSession } from '@/sync/session-unread';
import { openSectionsManager } from '../sections/sectionActions';

type MenuProps = {
  /** The sidebar's mode: projects, their order and their grouping belong to the Code list. */
  sidebarMode: SidebarMode;
  showProjectDisplayControls: boolean;
  showSectionControls: boolean;
  collapseAll: () => void;
  expandAll: () => void;
};

/**
 * Clears every unread mark at once. It mounts only with the open menu, so the
 * sidebar does not watch the whole session list for it.
 */
function MarkAllReadItem(): React.ReactNode {
  const { t } = useI18n();
  const hasUnread = useHasUnreadSession();
  return (
    <DropdownMenuItem disabled={!hasUnread} onClick={markAllSessionsViewed} className="flex items-center gap-2">
      <Icon name="check-double" className="h-4 w-4" />
      <span>{t('sessions.sidebar.header.actions.markAllRead')}</span>
    </DropdownMenuItem>
  );
}

/**
 * The menu's lines. They mount with the open menu, so a closed sidebar watches
 * none of the display settings they read.
 */
function DisplayMenuSections({ sidebarMode, showProjectDisplayControls, showSectionControls, collapseAll, expandAll }: MenuProps): React.ReactNode {
  const { t } = useI18n();
  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);
  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const setDetailedZoneRows = useSessionDisplayStore((state) => state.setDetailedZoneRows);
  const worktreeNameByBranch = useSessionDisplayStore((state) => state.worktreeNameByBranch);
  const setWorktreeNameByBranch = useSessionDisplayStore((state) => state.setWorktreeNameByBranch);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const sidebarGrouping = useSessionDisplayStore(resolveSidebarGrouping);
  const setSidebarGrouping = useSessionDisplayStore((state) => state.setSidebarGrouping);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  // Projects, their order and their grouping belong to the Code list; VS Code always groups under its workspace.
  const projectControls = showProjectDisplayControls && sidebarMode === 'code';
  const timeGrouping = projectControls && sidebarGrouping === 'time';
  // The list by time shows every project, whatever the project display says.
  const isSingleProjectMode = projectControls && projectDisplayMode === 'single' && !timeGrouping;

  // One choice per line, rarely touched orders behind submenus that name the
  // current choice, so the menu stays short: the sidebar's own layout and
  // selection first, then the view, its orders, and collapse. Choosing a view
  // setting keeps the menu open, so several can be set in one go; the actions
  // close it.
  const checkMark = <Icon name="check" className="h-4 w-4 text-primary" />;
  const choiceSubmenu = <T extends string>(
    { labelKey, icon }: { labelKey: I18nKey; icon: IconName },
    options: readonly (readonly [T, I18nKey])[],
    current: T,
    onSelect: (value: T) => void,
  ) => {
    const currentLabelKey = options.find(([value]) => value === current)?.[1];
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <Icon name={icon} className="h-4 w-4" />
          <span className="flex-1">{t(labelKey)}</span>
          {currentLabelKey ? <span className="ms-4 text-muted-foreground">{t(currentLabelKey)}</span> : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[160px]">
          {options.map(([value, optionLabelKey]) => (
            <DropdownMenuItem key={value} closeOnClick={false} onClick={() => onSelect(value)} className="flex items-center justify-between">
              <span>{t(optionLabelKey)}</span>
              {current === value ? checkMark : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };
  const toggleItem = ({ labelKey, icon }: { labelKey: I18nKey; icon: IconName }, checked: boolean, onToggle: () => void) => (
    <DropdownMenuItem closeOnClick={false} onClick={onToggle} className="flex items-center gap-2">
      <Icon name={icon} className="h-4 w-4" />
      <span className="flex-1">{t(labelKey)}</span>
      {checked ? checkMark : null}
    </DropdownMenuItem>
  );
  // The sidebar manager and Select sessions each open a surface or a mode of
  // the list, so they share the first group; the manager, the way into the
  // sidebar's rows and sections, leads it.
  const sections: React.ReactNode[] = [
    <>
      {showSectionControls ? (
        <DropdownMenuItem onClick={openSectionsManager} className="flex items-center gap-2">
          <Icon name="stack" className="h-4 w-4" />
          <span>{t('sessions.sidebar.customize.open')}</span>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={toggleSelectionMode} className="flex items-center gap-2">
        <Icon name="checkbox-multiple" className="h-4 w-4" />
        <span>{selectionModeEnabled
          ? t('sessions.sidebar.header.actions.exitSelection')
          : t('sessions.sidebar.header.actions.selectSessions')}</span>
      </DropdownMenuItem>
    </>,
  ];
  // One view: works under their projects, or every project's works in one
  // list by time, which has no project headers to sort.
  if (projectControls) {
    // The grouping's icon follows the choice, so the menu says which one the list is in.
    sections.push(choiceSubmenu({ labelKey: 'sessions.sidebar.header.listGrouping.label', icon: sidebarGrouping === 'time' ? 'time' : 'folders' }, [
      ['project', 'sessions.sidebar.header.listGrouping.project'],
      ['time', 'sessions.sidebar.header.listGrouping.time'],
    ] as const, sidebarGrouping, (grouping) => {
      setSidebarGrouping(grouping);
      void updateDesktopSettings({ sidebarGrouping: grouping });
    }));
  }
  // Grouped by time the list has no project headers to sort and shows every
  // project, so this group is empty then and takes no separator.
  if (projectControls && !timeGrouping) sections.push(<>
    {choiceSubmenu({ labelKey: 'sessions.sidebar.header.actions.sortProjects', icon: 'arrow-up-down' }, [
      ['manual', 'sessions.sidebar.header.projectSort.manual'],
      ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
      ['z-a', 'sessions.sidebar.header.projectSort.zToA'],
      ['date-added', 'sessions.sidebar.header.projectSort.dateAdded'],
      ['recent', 'sessions.sidebar.header.projectSort.recent'],
    ] as const, projectSortOrder, (order) => {
      setProjectSortOrder(order);
      void updateDesktopSettings({ sidebarProjectSortOrder: order });
    })}
    {choiceSubmenu({ labelKey: 'sessions.sidebar.header.projectDisplay.label', icon: 'folder-open' }, [
      ['all', 'sessions.sidebar.header.projectDisplay.all'],
      ['single', 'sessions.sidebar.header.projectDisplay.single'],
    ] as const, projectDisplayMode, (mode) => {
      setProjectDisplayMode(mode);
      void updateDesktopSettings({ sidebarProjectDisplayMode: mode });
    })}
  </>);
  if (showSectionControls && sidebarMode === 'code') {
    sections.push(<>
      {/* Rows that mix projects keep one line unless asked. */}
      {toggleItem({ labelKey: 'sessions.sidebar.header.displayMode.detailedZoneRows', icon: 'list-check-2' }, detailedZoneRows, () => {
        setDetailedZoneRows(!detailedZoneRows);
        void updateDesktopSettings({ sidebarDetailedZoneRows: !detailedZoneRows });
      })}
      {toggleItem({ labelKey: 'sessions.sidebar.header.displayMode.worktreeNameByBranch', icon: 'git-branch' }, worktreeNameByBranch, () => {
        setWorktreeNameByBranch(!worktreeNameByBranch);
        void updateDesktopSettings({ sidebarWorktreeNameByBranch: !worktreeNameByBranch });
      })}
    </>);
  }
  if (!isSingleProjectMode) {
    sections.push(<>
      <DropdownMenuItem onClick={collapseAll} className="flex items-center gap-2">
        <Icon name="contract-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={expandAll} className="flex items-center gap-2">
        <Icon name="expand-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
      </DropdownMenuItem>
    </>);
  }
  sections.push(<MarkAllReadItem />);

  return sections.map((section, index) => (
    <React.Fragment key={index}>
      {index > 0 ? <DropdownMenuSeparator /> : null}
      {section}
    </React.Fragment>
  ));
}

/**
 * The sidebar's display menu: its layout and selection, the view and its
 * orders, collapse. `trigger` is what opens it: Code mode's row in the header,
 * or Cowork mode's icon in the Chats caption.
 */
export function SidebarDisplayMenu({ trigger, ...menu }: MenuProps & { trigger: React.ReactElement }): React.ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DisplayMenuSections {...menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
