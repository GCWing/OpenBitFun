import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { Switch } from '@openbitfun/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const log = createLogger('ToolJsonRepairSettings');

const ToolJsonRepairSection: React.FC = () => {
  const { t } = useTranslation('settings/models');
  const notification = useNotification();
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const configured = await configManager.getConfig<boolean>('ai.allow_tool_json_repair');
    setEnabled(configured !== false);
  }, []);

  useEffect(() => {
    void load().catch((error) => {
      log.error('Failed to load tool JSON repair setting', error);
    });
    return configManager.watch('ai.allow_tool_json_repair', () => {
      void load();
    });
  }, [load]);

  const handleChange = async (nextEnabled: boolean) => {
    const previous = enabled;
    setEnabled(nextEnabled);
    setSaving(true);
    try {
      if (nextEnabled) {
        await configManager.resetConfig('ai.allow_tool_json_repair');
      } else {
        await configManager.setConfig('ai.allow_tool_json_repair', false);
      }
      notification.success(t('toolArgumentJsonRepair.saveSuccess'));
    } catch (error) {
      setEnabled(previous);
      log.error('Failed to save tool JSON repair setting', error);
      notification.error(t('messages.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigPageSection
      title={t('toolArgumentJsonRepair.title')}
      description={t('toolArgumentJsonRepair.description')}
    >
      <ConfigPageRow
        label={t('toolArgumentJsonRepair.label')}
        description={t('toolArgumentJsonRepair.hint')}
        align="center"
      >
        <Switch
          checked={enabled}
          onChange={(event) => void handleChange(event.target.checked)}
          disabled={saving}
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
};

export default ToolJsonRepairSection;
