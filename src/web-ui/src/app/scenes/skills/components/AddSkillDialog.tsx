import {
  Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader,
  DialogHeading, DialogTitle, Field, Icon, IconButton, Input, Select,
} from '@openbitfun/ui';
import { useEffect, useRef } from 'react';
import { FolderOpen } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { SkillLevel } from '@/infrastructure/config/types';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useInstalledSkills } from '../hooks/useInstalledSkills';
import './AddSkillDialog.scss';

interface AddSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: () => void | Promise<void>;
}

export function AddSkillDialog({ open, onOpenChange, onAdded, installed }: AddSkillDialogProps & {
  installed: ReturnType<typeof useInstalledSkills>;
}) {
  const { t } = useI18n('scenes/skills');
  const completionGeneration = useRef(0);
  useEffect(() => () => { completionGeneration.current += 1; }, [open, installed.catalogContextKey]);

  const handleAddSkill = async () => {
    const generation = completionGeneration.current;
    const added = await installed.handleAdd();
    if (added && generation === completionGeneration.current) {
      onOpenChange(false);
      await onAdded?.();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          installed.resetForm();
          onOpenChange(false);
        }
      }}
      size="sm"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('form.title')}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody>
        <div className="openbitfun-skills-scene__modal-form" data-openbitfun-scene="skills" data-openbitfun-part="addForm">
          <Field label={t('form.level.label')} controlWidth="fill">
            <Select
              options={[
                { label: t('form.level.user'), value: 'user' },
                {
                  label: `${t('form.level.project')}${installed.hasWorkspace && !installed.isRemoteWorkspace ? '' : t('form.level.projectDisabled')}`,
                  value: 'project',
                  disabled: !installed.hasWorkspace || installed.isRemoteWorkspace,
                },
              ]}
              value={installed.formLevel}
              onValueChange={(value) => installed.setFormLevel(value as SkillLevel)}
              size="md"
            />
          </Field>

          {installed.formLevel === 'project' && installed.hasWorkspace ? (
            <div className="openbitfun-skills-scene__form-hint">
              {t('form.level.selectedProjectPath', { path: installed.workspacePath })}
            </div>
          ) : null}

          <div className="openbitfun-skills-scene__path-input">
            <Field label={t('form.path.label')} controlWidth="fill">
              <Input
                placeholder={t('form.path.placeholder')}
                value={installed.formPath}
                onChange={(e) => installed.setFormPath(e.target.value)}
              />
            </Field>
            <IconButton
              size="md"
              onClick={installed.handleBrowse}
              aria-label={t('form.path.browseTooltip')}
              title={t('form.path.browseTooltip')}
              icon={<Icon glyph={FolderOpen} size="sm" />}
            />
          </div>
          <div className="openbitfun-skills-scene__path-hint">
            {t('form.path.hint')}
          </div>

          {installed.isValidating ? (
            <div className="openbitfun-skills-scene__validating">{t('form.validating')}</div>
          ) : null}

          {installed.validationResult ? (
            <div
              className={[
                'openbitfun-skills-scene__validation',
                installed.validationResult.valid ? 'is-valid' : 'is-invalid',
              ].filter(Boolean).join(' ')}
            >
              {installed.validationResult.valid ? (
                <>
                  <div className="openbitfun-skills-scene__validation-name">
                    {installed.validationResult.name}
                  </div>
                  <div className="openbitfun-skills-scene__validation-desc">
                    {installed.validationResult.description}
                  </div>
                </>
              ) : (
                <div className="openbitfun-skills-scene__validation-error">
                  {installed.validationResult.error}
                </div>
              )}
            </div>
          ) : null}

        </div>
      </DialogBody>
      <DialogFooter separator className="openbitfun-skills-scene__modal-form-actions">
        <Button
          variant="fill"
          size="sm"
          onClick={() => {
            installed.resetForm();
            onOpenChange(false);
          }}
        >
          {t('form.actions.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleAddSkill}
          disabled={!installed.validationResult?.valid || installed.isAdding}
        >
          {installed.isAdding ? t('form.actions.adding') : t('form.actions.add')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Shares the existing installation flow without mounting or navigating to the Skills scene. */
export function StandaloneAddSkillDialog(props: AddSkillDialogProps) {
  const { t } = useI18n('scenes/skills');
  const peer = usePeerDeviceModeOptional();
  const remoteConnectionActive = peer?.peerMode.active === true;
  const available = isTauriRuntime() && !remoteConnectionActive;
  const installed = useInstalledSkills({ searchQuery: '', activeFilter: 'all', enabled: props.open && available });

  if (!available) {
    return (
      <Dialog open={props.open} onOpenChange={props.onOpenChange} size="sm">
        <DialogHeader>
          <DialogHeading><DialogTitle>{t('form.title')}</DialogTitle></DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>{t(remoteConnectionActive ? 'list.remoteUnavailable' : 'list.desktopUnavailable')}</DialogBody>
      </Dialog>
    );
  }
  return <AddSkillDialog {...props} installed={installed} />;
}
