import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { SidebarMode } from '@/lib/sidebarNav';

/**
 * Cowork (the chats) or Code (the projects): which of the two lists the sidebar shows.
 * `wide` fills the width its parent gives it, whatever width the sidebar has.
 */
export const SidebarModeSwitch: React.FC<{ mode: SidebarMode; onChange: (mode: SidebarMode) => void; wide?: boolean }> = ({ mode, onChange, wide = false }) => {
  const { t } = useI18n();
  return (
    <SettingsChipGroup
      aria-label={t('sessions.sidebar.mode.label')}
      value={mode}
      onChange={onChange}
      className={wide ? 'flex w-full flex-nowrap' : undefined}
      chipClassName={wide ? 'min-w-0 flex-1' : undefined}
      options={[
        { value: 'chat', label: <><Icon name="list-check-2" />{t('sessions.sidebar.mode.chat')}</> },
        { value: 'code', label: <><Icon name="code-sslash" />{t('sessions.sidebar.mode.code')}</> },
      ]}
    />
  );
};
