import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  SettingsSection,
  SettingsInset,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { restartOpenCodeWithFeedback } from '@/lib/restartOpenCode';
import { useI18n } from '@/lib/i18n';

/**
 * The agent runtime's one manual control. The agent is Pi, bundled with
 * OpenChamber: there is no binary to choose and no update to announce, and
 * configuration edits reach it through the Pi children themselves. A restart
 * recreates the bridge, which ends running turns.
 */
export const OpenCodeCliSettings: React.FC = () => {
  const { t } = useI18n();
  const [isRestarting, setIsRestarting] = React.useState(false);

  const handleRestart = React.useCallback(async () => {
    setIsRestarting(true);
    try {
      await restartOpenCodeWithFeedback(t);
    } finally {
      setIsRestarting(false);
    }
  }, [t]);

  return (
    <SettingsSection title={t('settings.openchamber.opencodeCli.title')}>
      <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
        <div className="flex flex-wrap justify-start gap-2 py-1.5" data-settings-item="sessions.opencode-restart">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleRestart}
            disabled={isRestarting}
            className="shrink-0 !font-normal"
          >
            {isRestarting
              ? t('settings.openchamber.opencodeCli.actions.restartingOpenCode')
              : t('settings.openchamber.opencodeCli.actions.restart')}
          </Button>
        </div>
      </SettingsInset>
    </SettingsSection>
  );
};
