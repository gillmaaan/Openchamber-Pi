import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { useI18n } from '@/lib/i18n';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { guestPageNavId } from '@/lib/sidebarNav';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';

/** A page the sidebar opens in the main area. It is a row, or an item under More. */
export type SidebarPage = {
  /** A built-in page name (`lib/sidebarNav.ts`), or `guest:<id>` for an extension's page. */
  id: string;
  label: string;
  renderIcon: (className: string) => React.ReactNode;
  /** Its page is open now. */
  open: boolean;
  /** Opens the page, or closes it when it is the one that is open. */
  onToggle: () => void;
  shortcut?: string;
};

/**
 * The pages the sidebar can open, most used first: the ones this surface
 * offers, then the pages extensions add. Each is a toggle: it is marked while
 * its page is open and closes it.
 */
export function useSidebarPages({ showSourceBoard, showStats }: { showSourceBoard: boolean; showStats: boolean }): SidebarPage[] {
  const { t } = useI18n();
  const guestPages = useGuestPages();
  const enterpriseMode = useEnterpriseMode();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const overviewAvailable = useUIStore((state) => state.overviewFeatureAvailable);
  const isOverviewOpen = useUIStore((state) => state.isOverviewOpen);
  const isSourceBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
  const isScheduledOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveOpen = useUIStore((state) => state.isArchivePageOpen);
  const isUsageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  const isIntegrationsCatalogOpen = useUIStore((state) => state.isIntegrationsCatalogOpen);
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);
  const ui = useUIStore.getState;

  const icon = (name: IconName) => (className: string) => <Icon name={name} className={className} />;
  const pages: SidebarPage[] = [];
  if (showSourceBoard && overviewAvailable) {
    pages.push({ id: 'overview', label: t('overview.title'), renderIcon: icon('compass-3'), open: isOverviewOpen, onToggle: () => ui().setOverviewOpen(!isOverviewOpen) });
  }
  if (showSourceBoard) {
    pages.push({
      id: 'source-board',
      label: t('sourceBoard.title'),
      renderIcon: icon('git-pull-request'),
      open: isSourceBoardOpen,
      onToggle: () => ui().setSourceBoardOpen(!isSourceBoardOpen),
      shortcut: formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_source_board', shortcutOverrides), '') || undefined,
    });
  }
  pages.push(
    { id: 'scheduled', label: t('sessions.sidebar.header.actions.scheduledTasks'), renderIcon: icon('calendar-schedule'), open: isScheduledOpen, onToggle: () => ui().setScheduledTasksDialogOpen(!isScheduledOpen) },
    { id: 'archive', label: t('sessions.sidebar.nav.archive'), renderIcon: icon('archive'), open: isArchiveOpen, onToggle: () => ui().setArchivePageOpen(!isArchiveOpen) },
  );
  if (showStats) {
    pages.push({ id: 'stats', label: t('usageStats.openAction'), renderIcon: icon('bar-chart'), open: isUsageOpen, onToggle: () => ui().setUsageStatsPageOpen(!isUsageOpen) });
  }
  // The bundled catalog offers outside services; enterprise mode waits for
  // administrator-curated sources instead.
  if (!enterpriseMode) {
    pages.push({ id: 'integrations', label: t('integrationsCatalog.sidebar.open'), renderIcon: icon('store-2'), open: isIntegrationsCatalogOpen, onToggle: () => ui().setIntegrationsCatalogOpen(!isIntegrationsCatalogOpen) });
  }
  for (const guest of guestPages) {
    const open = openGuestPageId === guest.id;
    pages.push({
      id: guestPageNavId(guest.id),
      label: guest.pageTitle ?? guest.name,
      renderIcon: (className) => (
        <GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset)} className={className} />
      ),
      open,
      onToggle: () => ui().setOpenGuestPage(open ? null : guest.id),
    });
  }
  return pages;
}
