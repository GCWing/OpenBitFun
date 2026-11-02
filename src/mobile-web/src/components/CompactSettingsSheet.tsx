import {
  Globe as LucideGlobe,
  LayoutGrid as LucideLayoutGrid,
  Moon as LucideMoon,
  Sun as LucideSun,
  X as LucideX,
} from 'lucide-react';
import { deviceDisplayName, type RelayDeviceInfo } from '../services/RelayHttpClient';
import { isDeviceControllable } from '../services/accountDeviceSelection';
import AccountAvatar from './AccountAvatar';
import React from 'react';
import {
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileIconButton,
  MobileListRow,
  MobileSheet,
} from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import { MOBILE_LOCALES } from '../i18n/localeRegistry';

type SettingsDevice = RelayDeviceInfo;

interface CompactSettingsSheetProps {
  accountLabel: string | null;
  accountUserId?: string | null;
  accountAvatarUrl?: string;
  devices: SettingsDevice[];
  isDark: boolean;
  onClose: () => void;
  onDisconnectRequest: () => void;
  onSelectDevice: (device: SettingsDevice) => void;
  onToggleTheme: () => void;
  open: boolean;
  renderDeviceIcon: (device: SettingsDevice) => React.ReactNode;
  selectedDeviceId: string | null;
}

function ThemeToggleIcon({ isDark }: { isDark: boolean }) {
  return isDark ? (
    <LucideMoon width="20" height="20" stroke="currentColor" aria-hidden="true" />
  ) : (
    <LucideSun width="20" height="20" stroke="currentColor" aria-hidden="true" />
  );
}

export default function CompactSettingsSheet({
  accountLabel,
  accountUserId,
  accountAvatarUrl,
  devices,
  isDark,
  onClose,
  onDisconnectRequest,
  onSelectDevice,
  onToggleTheme,
  open,
  renderDeviceIcon,
  selectedDeviceId,
}: CompactSettingsSheetProps) {
  const { t, language, setLanguage } = useI18n();
  const sortedDevices = [...devices].sort((left, right) => Number(right.online) - Number(left.online));

  return (
    <MobileSheet
      className="harmony-sidebar__settings-sheet"
      headerAction={<MobileIconButton appearance="plain" onClick={onClose} aria-label={t('common.close')} icon={<LucideX width="20" height="20" stroke="currentColor" aria-hidden="true" />} />}
      onOpenChange={onClose}
      open={open}
      title={t('shared.features.settings')}
    >
      <div className="harmony-sidebar__settings-scroll">
        <h3>{t('settings.accountSection')}</h3>
        <MobileCard className="harmony-sidebar__account-card">
          <span className="harmony-sidebar__account-avatar" aria-hidden="true">
            <AccountAvatar url={accountAvatarUrl} />
          </span>
          <span className="harmony-sidebar__account-copy">
            <strong>{accountLabel ? t('settings.currentAccount') : t('settings.notSignedIn')}</strong>
            <small>{accountLabel || t('settings.connectedByQr')}</small>
            {accountUserId && <small>{t('settings.githubId', { id: accountUserId })}</small>}
          </span>
          {accountLabel && <MobileBadge className="harmony-sidebar__verified" tone="success">{t('settings.signedIn')}</MobileBadge>}
        </MobileCard>

        <h3>{t('settings.generalSection')}</h3>
        <MobileCard padding="none" className="harmony-sidebar__settings-card">
          <MobileButton appearance="plain" block className="harmony-sidebar__settings-row" role="switch" aria-checked={isDark} aria-label={t('settings.darkAppearance')} onClick={onToggleTheme}>
            <span className="harmony-sidebar__settings-row-icon"><ThemeToggleIcon isDark={isDark} /></span>
            <span className="harmony-sidebar__settings-label">{t('settings.appearance')}</span>
            <small>{t(isDark ? 'settings.dark' : 'settings.light')}</small>
            <span className="harmony-sidebar__theme-switch" data-checked={isDark} aria-hidden="true" />
          </MobileButton>
          <div className="harmony-sidebar__settings-row harmony-sidebar__settings-row--language">
            <span className="harmony-sidebar__settings-row-icon" aria-hidden="true"><LucideGlobe width="20" height="20" stroke="currentColor" aria-hidden="true" /></span>
            <span className="harmony-sidebar__settings-label">{t('settings.language')}</span>
            <div className="harmony-sidebar__settings-languages" role="group" aria-label={t('settings.language')}>
              {MOBILE_LOCALES.map((locale) => (
                <MobileButton
                  key={locale.id}
                  appearance="plain"
                  className="harmony-sidebar__settings-language"
                  aria-pressed={language === locale.id}
                  onClick={() => setLanguage(locale.id)}
                >
                  {locale.shortName}
                </MobileButton>
              ))}
            </div>
          </div>
        </MobileCard>

        <h3>{t('settings.modelSection')}</h3>
        <MobileCard padding="none" className="harmony-sidebar__settings-card">
          <div className="harmony-sidebar__settings-row">
            <span className="harmony-sidebar__settings-row-icon" aria-hidden="true"><LucideLayoutGrid width="20" height="20" stroke="currentColor" aria-hidden="true" /></span>
            <span className="harmony-sidebar__settings-label">{t('settings.defaultModel')}</span>
            <small>{t('settings.followDesktop')}</small>
          </div>
        </MobileCard>

        <h3>{t('settings.devicesSection')}</h3>
        <MobileCard padding="none" className="harmony-sidebar__settings-card harmony-sidebar__settings-card--devices">
          {sortedDevices.map((device) => {
            const current = device.device_id === selectedDeviceId;
            // A confirmed-incompatible device stays listed but is never a target.
            const controllable = isDeviceControllable(device);
            return (
              <MobileListRow
                appearance="plain"
                className={`harmony-sidebar__settings-device${current ? ' is-current' : ''}`}
                disabled={!device.online || !controllable}
                key={device.device_id}
                label={deviceDisplayName(device)}
                leading={<span className="harmony-sidebar__settings-device-icon">{renderDeviceIcon(device)}</span>}
                onClick={() => onSelectDevice(device)}
                selected={current}
                supportingText={!controllable
                  ? t('devices.clientIncompatible')
                  : current ? t('settings.currentDevice') : device.online ? t('devices.online') : t('devices.offline')}
                trailing={<span className={`harmony-sidebar__status${device.online ? ' is-online' : ''}`} />}
              />
            );
          })}
        </MobileCard>

        <h3>{t('settings.aboutSection')}</h3>
        <MobileCard padding="none" className="harmony-sidebar__settings-card">
          <div className="harmony-sidebar__settings-row harmony-sidebar__settings-row--static"><span>{t('shared.product.remote')}</span><small>{t('settings.platform')}</small></div>
        </MobileCard>

        <MobileButton appearance="danger" block className="harmony-sidebar__settings-disconnect" onClick={onDisconnectRequest}>
          {t('sessions.disconnect')}
        </MobileButton>
      </div>
    </MobileSheet>
  );
}
