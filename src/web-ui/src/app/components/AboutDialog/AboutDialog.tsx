/**
 * About dialog component.
 * Shows product identity, build metadata, license, and the
 * persistent GitHub repository entry point.
 */

import {
  Button,
  FieldGroup,
  FieldRow,
  Icon,
  IconButton,
  StatusPill,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  formatBuildDate,
  formatDisplayedVersion,
  getAboutInfo,
} from '@/shared/utils/version';
import { createLogger } from '@/shared/utils/logger';
import { systemAPI } from '@/infrastructure/api';
import { isTauriRuntime } from '@/infrastructure/update/tauriEnv';
import { AboutBrandMark } from './AboutBrandMark';
import './AboutDialog.scss';

const log = createLogger('AboutDialog');
const GITHUB_REPOSITORY_URL = 'https://github.com/GCWing/OpenBitFun';

interface AboutDialogProps {
  /** Whether visible */
  isOpen: boolean;
  /** Close callback */
  onClose: () => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useI18n('common');
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  const [nativeVersion, setNativeVersion] = useState<string | null>(null);

  const aboutInfo = getAboutInfo();
  const { version, license } = aboutInfo;
  const nativeRuntime = isTauriRuntime();
  const displayedVersion = formatDisplayedVersion(
    version,
    nativeVersion,
    nativeRuntime,
    import.meta.env.DEV,
  );
  const licenseName = license.type === 'MIT' ? 'MIT License' : license.type;
  const licenseCopyright = license.text?.startsWith(`${licenseName} - `)
    ? license.text.slice(`${licenseName} - `.length)
    : license.text;
  const legalCopyright = licenseCopyright
    ? `${licenseCopyright.replace(/\.$/, '')}. ${t('about.allRightsReserved')}`
    : t('about.copyright');

  let releaseLabel = t('about.stableBuild');
  if (displayedVersion.endsWith('-dev')) {
    releaseLabel = t('about.developmentBuild');
  } else if (version.releaseChannel === 'beta') {
    releaseLabel = t('about.betaBuild');
  } else if (version.releaseChannel === 'nightly') {
    releaseLabel = t('about.nightlyBuild');
  }

  useEffect(() => {
    if (!isOpen || !nativeRuntime) return;
    let active = true;
    void systemAPI.getLocalAppVersion()
      .then(currentVersion => {
        if (active) setNativeVersion(currentVersion);
      })
      .catch(error => {
        log.warn('Failed to read the local version; using generated version metadata', error);
      });
    return () => {
      active = false;
    };
  }, [isOpen, nativeRuntime]);

  const handleGithubStar = useCallback(() => {
    systemAPI.openExternal(GITHUB_REPOSITORY_URL).catch(error => {
      log.error('Failed to open the GitHub repository', { url: GITHUB_REPOSITORY_URL, error });
    });
  }, []);

  const copyToClipboard = async (text: string, itemId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedItem(itemId);
      window.setTimeout(() => setCopiedItem(null), 2000);
    } catch (error) {
      log.error('Failed to copy to clipboard', error);
    }
  };

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
        size="xl"
        className="openbitfun-about-dialog"
        aria-label={t('about.dialogTitle')}
        data-testid="about-dialog-modal"
      >
        <DialogClose className="openbitfun-about-dialog__close" />
        <DialogBody className="openbitfun-about-dialog__modal-content" inset="none">
          <div
            className="openbitfun-about-dialog__content"
            data-openbitfun-component="about-dialog"
            data-openbitfun-part="root"
          >
            <div className="openbitfun-about-dialog__body">
              <div
                className="openbitfun-about-dialog__brand"
                data-openbitfun-component="about-dialog"
                data-openbitfun-part="hero"
                aria-hidden="true"
              >
                <div className="openbitfun-about-dialog__artwork">
                  <AboutBrandMark active={isOpen} />
                </div>
                <p className="openbitfun-about-dialog__brand-statement">
                  {t('about.brandStatement')}
                </p>
              </div>

              <section
                className="openbitfun-about-dialog__metadata"
                data-openbitfun-component="about-dialog"
                data-openbitfun-part="content"
                aria-label={t('about.details')}
              >
                <header className="openbitfun-about-dialog__brand-copy">
                  <DialogTitle
                    className="openbitfun-about-dialog__title"
                    data-openbitfun-component="about-dialog"
                    data-openbitfun-part="title"
                  >
                    {version.name}
                  </DialogTitle>
                  <p className="openbitfun-about-dialog__tagline">{t('about.tagline')}</p>
                </header>

                <FieldGroup className="openbitfun-about-dialog__details" appearance="plain" dividers={false}>
                  <FieldRow padding="none">
                    <dl className="openbitfun-about-dialog__info-row" data-openbitfun-component="about-dialog" data-openbitfun-part="infoRow">
                      <dt className="openbitfun-about-dialog__info-label" data-openbitfun-component="about-dialog" data-openbitfun-part="infoLabel">
                        <span>{t('about.versionLabel')}</span>
                      </dt>
                      <dd className="openbitfun-about-dialog__info-value-group">
                        <span
                          className="openbitfun-about-dialog__info-value"
                          data-openbitfun-component="about-dialog"
                          data-openbitfun-part="infoValue"
                          data-testid="about-version-value"
                        >
                          {displayedVersion}
                        </span>
                        <span
                          className="openbitfun-about-dialog__channel-badge"
                          data-openbitfun-component="about-dialog"
                          data-openbitfun-part="channelBadge"
                        >
                          <StatusPill tone="neutral">{releaseLabel}</StatusPill>
                        </span>
                      </dd>
                    </dl>
                  </FieldRow>

                  <FieldRow padding="none">
                    <dl className="openbitfun-about-dialog__info-row" data-openbitfun-component="about-dialog" data-openbitfun-part="infoRow">
                      <dt className="openbitfun-about-dialog__info-label" data-openbitfun-component="about-dialog" data-openbitfun-part="infoLabel">
                        <span>{t('about.buildDate')}</span>
                      </dt>
                      <dd className="openbitfun-about-dialog__info-value-group">
                        <span className="openbitfun-about-dialog__info-value" data-openbitfun-component="about-dialog" data-openbitfun-part="infoValue">
                          {formatBuildDate(version.buildDate)}
                        </span>
                      </dd>
                    </dl>
                  </FieldRow>

                  <FieldRow padding="none">
                    <dl className="openbitfun-about-dialog__info-row" data-openbitfun-component="about-dialog" data-openbitfun-part="infoRow">
                      <dt className="openbitfun-about-dialog__info-label" data-openbitfun-component="about-dialog" data-openbitfun-part="infoLabel">
                        <span>{t('about.commit')}</span>
                      </dt>
                      <dd className="openbitfun-about-dialog__info-value-group">
                        <span
                          className="openbitfun-about-dialog__info-value openbitfun-about-dialog__info-value--mono"
                          data-openbitfun-component="about-dialog"
                          data-openbitfun-part="infoValue"
                        >
                          {version.gitCommit ?? t('about.notAvailable')}
                        </span>
                        {version.gitCommit ? (
                          <span
                            className="openbitfun-about-dialog__copy-action"
                            data-openbitfun-component="about-dialog"
                            data-openbitfun-part="copyButton"
                          >
                            <Tooltip content={t('about.copy')}>
                              <IconButton
                                size="xs"
                                variant="quiet"
                                icon={<Icon name={copiedItem === 'commit' ? 'check-line' : 'duplicate'} size="sm" />}
                                onClick={() => void copyToClipboard(version.gitCommit ?? '', 'commit')}
                                aria-label={t('about.copyCommit')}
                              />
                            </Tooltip>
                          </span>
                        ) : null}
                      </dd>
                    </dl>
                  </FieldRow>

                  <FieldRow padding="none">
                    <dl className="openbitfun-about-dialog__info-row" data-openbitfun-component="about-dialog" data-openbitfun-part="infoRow">
                      <dt className="openbitfun-about-dialog__info-label" data-openbitfun-component="about-dialog" data-openbitfun-part="infoLabel">
                        <span>{t('about.branch')}</span>
                      </dt>
                      <dd className="openbitfun-about-dialog__info-value-group">
                        <span
                          className="openbitfun-about-dialog__info-value"
                          data-openbitfun-component="about-dialog"
                          data-openbitfun-part="infoValue"
                          data-testid="about-branch-value"
                          title={version.gitBranch}
                        >
                          {version.gitBranch ?? t('about.notAvailable')}
                        </span>
                      </dd>
                    </dl>
                  </FieldRow>

                  <FieldRow padding="none">
                    <dl className="openbitfun-about-dialog__info-row" data-openbitfun-component="about-dialog" data-openbitfun-part="infoRow">
                      <dt className="openbitfun-about-dialog__info-label" data-openbitfun-component="about-dialog" data-openbitfun-part="infoLabel">
                        <span>{t('about.license')}</span>
                      </dt>
                      <dd className="openbitfun-about-dialog__info-value-group">
                        <span
                          className="openbitfun-about-dialog__info-value"
                          data-openbitfun-component="about-dialog"
                          data-openbitfun-part="license"
                          data-testid="about-license-value"
                        >
                          {licenseName}
                        </span>
                      </dd>
                    </dl>
                  </FieldRow>
                </FieldGroup>

              </section>
            </div>

            <footer
              className="openbitfun-about-dialog__footer"
              data-openbitfun-component="about-dialog"
              data-openbitfun-part="footer"
            >
              <div
                className="openbitfun-about-dialog__star-callout"
                data-openbitfun-component="about-dialog"
                data-openbitfun-part="starCallout"
                role="group"
                aria-labelledby="openbitfun-about-star-title"
              >
                <div className="openbitfun-about-dialog__star-copy">
                  <h3 id="openbitfun-about-star-title" className="openbitfun-about-dialog__star-title">
                    {t('about.githubStarTitle')}
                  </h3>
                  <p className="openbitfun-about-dialog__star-description">
                    {t('about.githubStarDescription')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="openbitfun-about-dialog__star-button"
                  leadingIcon={<Icon name="star" size="sm" aria-hidden="true" />}
                  onClick={handleGithubStar}
                  data-testid="about-github-star"
                >
                  {t('about.githubStarAction')}
                </Button>
              </div>
              <p
                className="openbitfun-about-dialog__copyright"
                data-openbitfun-component="about-dialog"
                data-openbitfun-part="copyright"
              >
                {legalCopyright}
              </p>
            </footer>
          </div>
        </DialogBody>
      </Dialog>

    </>
  );
};

export default AboutDialog;
