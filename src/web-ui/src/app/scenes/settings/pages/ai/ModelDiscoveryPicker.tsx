import { useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeaderActions,
  DialogHeading,
  DialogTitle,
  Icon,
  IconButton,
  ScrollArea,
  SearchField,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';

export interface ModelDiscoveryOption {
  label: string;
  value: string;
  description?: string;
  source?: string;
}

interface ModelDiscoveryPickerProps {
  options: readonly ModelDiscoveryOption[];
  value: readonly string[];
  open: boolean;
  loading: boolean;
  fetched: boolean;
  hint: string | null;
  error: boolean;
  invalid: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
  onValueChange: (value: string[]) => void;
}

export function ModelDiscoveryPicker({
  options,
  value,
  open,
  loading,
  fetched,
  hint,
  error,
  invalid,
  onOpenChange,
  onRefresh,
  onValueChange,
}: ModelDiscoveryPickerProps) {
  const { t, formatNumber } = useI18n('settings/models');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const count = formatNumber(options.length);
  const resultLabel = options.length > 0
    ? t(fetched ? 'providerSelection.fetchedModels' : 'providerSelection.presetModels', { count })
    : t('form.modelSelection');
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = options.filter(option => (
    !normalizedQuery
    || `${option.label} ${option.value}`.toLowerCase().includes(normalizedQuery)
  ));
  const selected = new Set(value.map(name => name.trim().toLowerCase()));

  return (
    <div className="openbitfun-model-settings__model-picker-row">
      <Button
        variant="primary"
        size="xs"
        data-testid="settings-model-select"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-invalid={invalid || undefined}
        onClick={() => onOpenChange(!open)}
      >
        {t('providerSelection.quickAdd')}
      </Button>
      <Dialog
        id={id}
        size="sm"
        open={open}
        onOpenChange={onOpenChange}
        initialFocusRef={searchRef}
        className="openbitfun-model-settings__model-discovery-dialog"
        data-testid="settings-model-discovery-dialog"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('providerSelection.quickAdd')}</DialogTitle>
            <DialogDescription>{resultLabel}</DialogDescription>
          </DialogHeading>
          <DialogHeaderActions>
            <IconButton
              size="sm"
              variant="quiet"
              icon={<Icon name="refresh" size="sm" />}
              aria-label={t('providerSelection.refreshModels')}
              title={t('providerSelection.refreshModels')}
              data-testid="settings-model-refresh-btn"
              loading={loading}
              onClick={onRefresh}
            />
            <DialogClose />
          </DialogHeaderActions>
        </DialogHeader>
        <DialogBody className="openbitfun-model-settings__model-discovery-body">
          {options.length > 0 && (
            <SearchField
              ref={searchRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label={t('providerSelection.searchModels')}
              placeholder={t('providerSelection.searchModels')}
              size="sm"
            />
          )}
          {hint && (
            <small role="status" className={`openbitfun-model-settings__model-fetch-hint ${error ? 'openbitfun-model-settings__json-status--error' : ''}`}>
              {hint}
            </small>
          )}
          <ScrollArea className="openbitfun-model-settings__model-discovery-results" aria-busy={loading}>
            <div className="openbitfun-model-settings__model-discovery-list">
              {visibleOptions.map(option => {
                const modelName = String(option.value);
                const lookupKey = modelName.trim().toLowerCase();
                const isSelected = selected.has(lookupKey);
                return (
                  <Button
                    key={modelName}
                    variant="outline"
                    size="xs"
                    aria-pressed={isSelected}
                    title={option.description}
                    data-testid="settings-model-option"
                    data-model-id={modelName}
                    data-model-name={modelName}
                    data-model-source={option.source}
                    leadingIcon={<Icon name={isSelected ? 'selected' : 'plus'} size="xs" />}
                    onClick={() => onValueChange(isSelected
                      ? value.filter(name => name.trim().toLowerCase() !== lookupKey)
                      : [...value, modelName])}
                  >
                    {option.label}
                  </Button>
                );
              })}
              {visibleOptions.length === 0 && !loading && (options.length > 0 || !hint) && (
                <small role="status" className="openbitfun-model-settings__model-fetch-hint">
                  {t(options.length > 0 ? 'pool.noMatches' : 'providerSelection.noPresetModels')}
                </small>
              )}
            </div>
          </ScrollArea>
        </DialogBody>
        <DialogFooter appearance="floating">
          <Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
            {t('actions.done')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
