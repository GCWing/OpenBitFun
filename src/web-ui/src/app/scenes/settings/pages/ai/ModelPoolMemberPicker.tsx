import { useEffect, useId, useRef, useState } from 'react';
import {
  Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading,
  DialogTitle, Icon, ScrollArea, SearchField,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { useModelSelectPresentation } from '@/infrastructure/config/components/ModelSelectPresentation';
import { filterSelectableTextChatModels } from '@/infrastructure/config/services/modelCategory';

export function ModelPoolMemberPicker({ models, value, disabled, onValueChange }: {
  models: readonly AIModelConfig[];
  value: readonly string[];
  disabled: boolean;
  onValueChange: (value: string[]) => void;
}) {
  const { t } = useI18n('settings/models');
  const { buildModelOption } = useModelSelectPresentation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const options = filterSelectableTextChatModels(models).map(buildModelOption);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = options.filter(option => (
    `${option.label} ${option.value} ${typeof option.description === 'string' ? option.description : ''}`
      .toLowerCase().includes(normalizedQuery)
  ));
  const selected = new Set(value);

  return <>
    <Button variant="primary" size="xs" disabled={disabled}
      data-testid="settings-model-pool-add" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>
      {t('pools.add')}
    </Button>
    <Dialog id={id} open={open} onOpenChange={setOpen} size="sm" initialFocusRef={searchRef}
      className="openbitfun-model-pools__picker" data-testid="settings-model-pool-member-dialog">
      <DialogHeader>
        <DialogHeading><DialogTitle>{t('pools.add')}</DialogTitle></DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="openbitfun-model-pools__picker-body">
        <SearchField ref={searchRef} value={query} onChange={event => setQuery(event.target.value)}
          aria-label={t('pool.search')} placeholder={t('pool.search')} size="sm" />
        <ScrollArea className="openbitfun-model-pools__picker-results">
          <div className="openbitfun-model-pools__picker-options"
            data-openbitfun-component="model-settings" data-openbitfun-part="poolPickerOptions">
            {visibleOptions.map(option => {
              const modelId = String(option.value);
              const isSelected = selected.has(modelId);
              return <Button key={modelId} variant={isSelected ? 'fill' : 'outline'} size="xs" disabled={disabled}
                aria-pressed={isSelected} title={typeof option.description === 'string' ? option.description : undefined}
                data-testid="settings-model-pool-member-option" data-model-id={modelId}
                leadingIcon={<Icon name={isSelected ? 'check-line' : 'plus'} size="xs" tone={isSelected ? 'success' : undefined} />}
                onClick={() => onValueChange(isSelected
                  ? value.filter(member => member !== modelId) : [...value, modelId])}>
                {option.label}
              </Button>;
            })}
            {visibleOptions.length === 0 && <p role="status">{t(options.length > 0 ? 'pool.noMatches' : 'pool.empty')}</p>}
          </div>
        </ScrollArea>
      </DialogBody>
      <DialogFooter appearance="floating">
        <Button variant="primary" size="sm" onClick={() => setOpen(false)}>{t('actions.done')}</Button>
      </DialogFooter>
    </Dialog>
  </>;
}
