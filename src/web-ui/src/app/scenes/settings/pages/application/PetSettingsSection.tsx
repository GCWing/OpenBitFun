import '@/app/scenes/settings/pages/shared/RuntimeSettings.scss';
import {
  ConfigLoadingState,
  ConfigPageRow,
  ConfigPageSection,
  ConfigPageSectionStack,
  ConfigRetryState
} from '@/infrastructure/config/components/common';
import {
  DEFAULT_AGENT_COMPANION_PET,
  deleteAgentCompanionPetPackage,
  importAgentCompanionPetPackage,
  listAgentCompanionPets,
  releaseAgentCompanionPetPreviewBlobs,
  selectAgentCompanionPetPackage,
  type AgentCompanionPetPackage,
} from '@/infrastructure/config/services/AgentCompanionPetService';
import { getPetSpriteLayout } from '@/infrastructure/config/services/agentCompanionPetSprite';
import { aiExperienceConfigService, type AIExperienceSettings } from '@/infrastructure/config/services/AIExperienceConfigService';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { useI18n } from '@/infrastructure/i18n';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  Button,
  Disclosure,
  Icon,
  IconButton,
  OverflowText,
  Switch,
  Tooltip
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';
const log = createLogger('PetSettingsSection');

const IS_TAURI_DESKTOP = typeof window !== 'undefined' && '__TAURI__' in window;

function getPetPreviewStyle(pet: AgentCompanionPetPackage): React.CSSProperties {
  return {
    imageRendering: pet.source === 'preset' && pet.id === 'bitblob' ? 'auto' : undefined,
    '--openbitfun-pet-preview-src': `url("${pet.previewSrc}")`,
    backgroundSize: `800% ${getPetSpriteLayout(pet.spriteVersionNumber).rows * 100}%`,
  } as React.CSSProperties;
}

const PetSettingsSection: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
  const { t } = useI18n('settings/runtime');

  const notification = useNotification();

  const [isLoading, setIsLoading] = useState(true);

  const [loadError, setLoadError] = useState(false);

  const hasLoadedPageDataRef = useRef(false);

  const [settings, setSettings] = useState<AIExperienceSettings | null>(null);

  const [companionPets, setCompanionPets] = useState<AgentCompanionPetPackage[]>([]);

  const [companionPetListExpanded, setCompanionPetListExpanded] = useState(false);

  const [companionPetImporting, setCompanionPetImporting] = useState(false);

  const [companionPetDeletingPath, setCompanionPetDeletingPath] = useState<string | null>(null);

  const reloadCompanionPets = useCallback(async () => {
    setCompanionPets(await listAgentCompanionPets());
  }, []);

  const updateSetting = async <K extends keyof AIExperienceSettings>(
    key: K,
    value: AIExperienceSettings[K]
  ) => {
    if (!settings) return;
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    try {
      await aiExperienceConfigService.saveSettings({ [key]: value });
      notification.success(t('messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save AI features settings', error);
      notification.error(t('messages.saveFailed'));
      setSettings(settings);
    }
  };

  const handleImportCompanionPet = async () => {
    if (!IS_TAURI_DESKTOP) return;
    setCompanionPetImporting(true);
    try {
      const selected = await selectAgentCompanionPetPackage(t('features.pet.importDialogTitle'));
      if (!selected) return;
      const imported = await importAgentCompanionPetPackage(selected);
      await reloadCompanionPets();
      await updateSetting('agent_companion_pet', {
        id: imported.id,
        displayName: imported.displayName,
        description: imported.description,
        source: imported.source,
        packagePath: imported.packagePath,
        spritesheetPath: imported.spritesheetPath,
        spritesheetMimeType: imported.spritesheetMimeType,
        spriteVersionNumber: imported.spriteVersionNumber,
      });
    } catch (error) {
      log.error('Failed to import Agent companion pet', error);
      notification.error(t('features.pet.importFailed'));
    } finally {
      setCompanionPetImporting(false);
    }
  };

  const handleDeleteCompanionPet = async (event: React.MouseEvent, pet: AgentCompanionPetPackage) => {
    event.preventDefault();
    event.stopPropagation();
    if (!IS_TAURI_DESKTOP || pet.source !== 'user' || !settings) return;
    const confirmed = await confirmDanger(
      t('features.pet.deleteConfirmTitle'),
      t('features.pet.deleteConfirmBody'),
      { confirmText: t('features.pet.delete') },
    );
    if (!confirmed) return;
    setCompanionPetDeletingPath(pet.packagePath);
    try {
      await deleteAgentCompanionPetPackage(pet.packagePath);
      releaseAgentCompanionPetPreviewBlobs(pet.packagePath, pet.spritesheetPath);
      await reloadCompanionPets();
      if (settings.agent_companion_pet?.packagePath === pet.packagePath) {
        const next = { ...settings, agent_companion_pet: DEFAULT_AGENT_COMPANION_PET };
        setSettings(next);
        await aiExperienceConfigService.saveSettings({ agent_companion_pet: DEFAULT_AGENT_COMPANION_PET });
      }
      notification.success(t('features.pet.deleteSuccess'));
    } catch (error) {
      log.error('Failed to delete Agent companion pet', error);
      notification.error(t('features.pet.deleteFailed'));
    } finally {
      setCompanionPetDeletingPath(null);
    }
  };

  const selectedCompanionPetValue = settings?.agent_companion_pet?.packagePath
    ?? DEFAULT_AGENT_COMPANION_PET.packagePath;

  const selectedCompanionPet = companionPets.find(pet => pet.packagePath === selectedCompanionPetValue);
  const selectedCompanionPetReference = selectedCompanionPet
    ?? settings?.agent_companion_pet
    ?? DEFAULT_AGENT_COMPANION_PET;
  const companionPetStack = companionPets
    .filter(pet => pet.packagePath !== selectedCompanionPetValue)
    .slice(0, 3);
  const getPetLabel = (pet: Pick<AgentCompanionPetPackage, 'source' | 'id' | 'displayName'>) => (
    pet.source === 'preset' && pet.id === 'blue-golden'
      ? t('features.pet.presets.blueGolden.name')
      : pet.displayName
  );

  const handleCompanionPetChange = async (value: string | number | (string | number)[]) => {
    const selectedValue = String(Array.isArray(value) ? value[0] : value);
    const pet = companionPets.find(item => item.packagePath === selectedValue);
    if (!pet) return;
    await updateSetting('agent_companion_pet', {
      id: pet.id,
      displayName: pet.displayName,
      description: pet.description,
      source: pet.source,
      packagePath: pet.packagePath,
      spritesheetPath: pet.spritesheetPath,
      spritesheetMimeType: pet.spritesheetMimeType,
      spriteVersionNumber: pet.spriteVersionNumber,
    });
  };

  const loadPageData = useCallback(async () => {
    const isInitialLoad = !hasLoadedPageDataRef.current;
    if (isInitialLoad) { setIsLoading(true); setLoadError(false); }
    try {
      const [loadedSettings] = await Promise.all([
        aiExperienceConfigService.getSettingsAsync(),
        reloadCompanionPets(),
      ]);
      setSettings(loadedSettings);

      hasLoadedPageDataRef.current = true;
    } catch (error) {
      log.error('Failed to load settings page data', { error });
      if (isInitialLoad) setLoadError(true);
    } finally {
      if (isInitialLoad) setIsLoading(false);
    }
  }, [reloadCompanionPets]);
  useEffect(() => {
    if (!isActive) return;
    void loadPageData();
  }, [loadPageData, isActive]);

  useEffect(() => {
    if (!isActive) setCompanionPetListExpanded(false);
  }, [isActive]);

  const sectionAnchor = useSettingsSectionAnchor('pet', !isLoading);

  return (
    <div id={sectionAnchor} className="openbitfun-runtime-settings" data-openbitfun-component="runtime-settings" data-openbitfun-part="root" data-openbitfun-view="pet">
      <ConfigPageSectionStack>
        {loadError ? (
          <ConfigRetryState message={t('loading.failed')} retryLabel={t('loading.retry')} onRetry={() => void loadPageData()} />
        ) : isLoading || !settings ? (
          <ConfigLoadingState label={t('loading.text')} />
        ) : (
          <ConfigPageSection
            title={t('features.pet.title')}
            description={t('features.pet.subtitle')}
          >
            <ConfigPageRow label={t('features.pet.enable')} align="center">
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <Switch
                  checked={settings.enable_agent_companion}
                  onChange={(e) => updateSetting('enable_agent_companion', e.target.checked)}
                />
              </div>
            </ConfigPageRow>

            <div
              className="openbitfun-runtime-settings__pet-picker"
              data-openbitfun-component="runtime-settings"
              data-openbitfun-part="petPicker"
            >
              <div
                className="openbitfun-runtime-settings__pet-chooser"
                data-openbitfun-component="runtime-settings"
                data-openbitfun-part="petChooser"
              >
                <Disclosure
                  contentInnerClassName="openbitfun-runtime-settings__pet-expanded-content"
                  summary={t('features.pet.petLabel')}
                  open={isActive && companionPetListExpanded}
                  onOpenChange={setCompanionPetListExpanded}
                  renderHeader={triggerProps => (
                    <button
                      {...triggerProps}
                      data-overflow-trigger
                      className="openbitfun-runtime-settings__pet-summary"
                      data-openbitfun-component="runtime-settings"
                      data-openbitfun-part="petSummary"
                      aria-label={`${t('features.pet.petLabel')}: ${getPetLabel(selectedCompanionPetReference)}`}
                    >
                      <span className="openbitfun-runtime-settings__pet-current-preview" aria-hidden>
                        {selectedCompanionPet?.previewSrc ? (
                          <span
                            className="openbitfun-runtime-settings__pet-preview-sprite"
                            style={getPetPreviewStyle(selectedCompanionPet)}
                          />
                        ) : <Icon name="image" size="lg" />}
                      </span>
                      <span className="openbitfun-runtime-settings__pet-current-copy">
                        <OverflowText className="openbitfun-runtime-settings__pet-caption">
                          {selectedCompanionPet?.previewSrc
                            ? t('features.pet.current')
                            : t('features.pet.previewUnavailable')}
                        </OverflowText>
                        <strong><OverflowText>{getPetLabel(selectedCompanionPetReference)}</OverflowText></strong>
                      </span>
                      {companionPetStack.length > 0 && (
                        <span
                          className="openbitfun-runtime-settings__pet-stack"
                          data-openbitfun-component="runtime-settings"
                          data-openbitfun-part="petStack"
                          aria-hidden
                        >
                          {companionPetStack.map(pet => (
                            <span key={pet.packagePath} className="openbitfun-runtime-settings__pet-stack-card">
                              <span
                                className="openbitfun-runtime-settings__pet-preview-sprite"
                                style={getPetPreviewStyle(pet)}
                              />
                            </span>
                          ))}
                        </span>
                      )}
                      <Icon name="chevron-down" size="sm" className="openbitfun-runtime-settings__pet-summary-chevron" />
                    </button>
                  )}
                >
                  <div
                    className="openbitfun-runtime-settings__pet-actions"
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="petActions"
                  >
                    <span className="openbitfun-runtime-settings__pet-hint">{t('features.pet.petDescription')}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleImportCompanionPet()}
                      disabled={!IS_TAURI_DESKTOP || companionPetImporting}
                      title={t('features.pet.importHint')}
                    >
                      {companionPetImporting ? t('features.pet.importing') : t('features.pet.import')}
                    </Button>
                  </div>
                  <div
                    className="openbitfun-runtime-settings__pet-gallery"
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="petList"
                    role="radiogroup"
                    aria-label={t('features.pet.petLabel')}
                  >
                    {companionPets.map((pet) => {
                      const label = getPetLabel(pet);
                      const sourceLabel = pet.source === 'preset'
                        ? t('features.pet.groupPreset')
                        : t('features.pet.groupImported');
                      const isUserPet = pet.source === 'user';
                      const isDeleting = companionPetDeletingPath === pet.packagePath;
                      const isSelected = pet.packagePath === selectedCompanionPetValue;
                      const isDisabled = isDeleting;

                      return (
                        <article
                          key={pet.packagePath}
                          className="openbitfun-runtime-settings__pet-card"
                          data-testid="companion-pet-card"
                          data-pet-id={pet.id}
                          data-openbitfun-component="runtime-settings"
                          data-openbitfun-part="petOption"
                          data-openbitfun-state={isSelected ? 'selected' : undefined}
                        >
                          <button data-overflow-trigger
                            type="button"
                            className="openbitfun-runtime-settings__pet-card-select"
                            data-openbitfun-component="runtime-settings"
                            data-openbitfun-part="petTrigger"
                            data-openbitfun-state={isSelected ? 'selected' : undefined}
                            role="radio"
                            aria-checked={isSelected}
                            aria-label={label}
                            disabled={isDisabled}
                            onClick={() => void handleCompanionPetChange(pet.packagePath)}
                          >
                            <span className="openbitfun-runtime-settings__pet-card-preview" aria-hidden>
                              <span
                                className="openbitfun-runtime-settings__pet-preview-sprite"
                                style={getPetPreviewStyle(pet)}
                              />
                              {isSelected && (
                                <span className="openbitfun-runtime-settings__pet-selected-mark">
                                  <Icon name="check-line" size="xs" />
                                </span>
                              )}
                            </span>
                            <span
                              className="openbitfun-runtime-settings__pet-card-body"
                              data-openbitfun-component="runtime-settings"
                              data-openbitfun-part="petOptionMain"
                            >
                              <strong><OverflowText>{label}</OverflowText></strong>
                              <OverflowText data-openbitfun-component="runtime-settings" data-openbitfun-part="petGroup">
                                {sourceLabel}
                              </OverflowText>
                            </span>
                          </button>
                          {isUserPet && IS_TAURI_DESKTOP && (
                            <Tooltip content={t('features.pet.delete')}>
                              <IconButton
                                type="button"
                                size="sm"
                                tone="danger"
                                className="openbitfun-runtime-settings__pet-card-delete"
                                disabled={isDeleting}
                                aria-label={`${t('features.pet.delete')}: ${label}`}
                                onClick={(event) => void handleDeleteCompanionPet(event, pet)}
                                icon={<Icon name="delete" size="sm" />}
                              />
                            </Tooltip>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </Disclosure>
              </div>
            </div>
          </ConfigPageSection>
        )}
      </ConfigPageSectionStack>
    </div>
  );
};

export default PetSettingsSection;
