import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon, MenuItem, MenuList, MenuSection, OverflowText, ScrollArea, SearchField, Switch, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { filterSelectableTextChatModels } from '@/infrastructure/config/services/modelCategory';
import { getProviderDisplayName, getProviderGroupKey } from '@/infrastructure/config/services/modelConfigs';
import './NativeModelSelectionPanel.scss';

export type ModelRole = 'primary' | 'economy';

interface Props {
  disabled: boolean;
  models: AIModelConfig[];
  primary?: AIModelConfig;
  economy?: AIModelConfig;
  routing: { mode: 'manual' | 'smart'; available?: boolean; ready: boolean; supported: boolean; issue?: string | null };
  onModeChange: (mode: 'manual' | 'smart') => Promise<boolean>;
  onRoutingSettings: () => void;
  onConfigureModel: (role: ModelRole, modelId: string) => Promise<boolean>;
  onSettings: () => void;
}

/** Smart-specific items share the original model selector's compact menu. */
export function NativeModelSelectionPanel(props: Props) {
  const { t } = useI18n('flow-chat');
  const [pickingRole, setPickingRole] = useState<ModelRole | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const economyRef = useRef<HTMLButtonElement>(null);
  const returnRole = useRef<ModelRole | null>(null);
  const smartEnabled = props.routing.available === true && props.routing.supported && props.routing.ready && props.routing.mode === 'smart';
  const roleLabel = (role: ModelRole) => t(role === 'primary' ? 'modelSelector.primaryModel' : 'modelSelector.economyModel');
  useEffect(() => {
    if (!smartEnabled) { setPickingRole(null); setQuery(''); returnRole.current = null; }
  }, [smartEnabled]);
  useLayoutEffect(() => {
    if (pickingRole) searchRef.current?.focus({ preventScroll: true });
    else if (returnRole.current) {
      (returnRole.current === 'primary' ? primaryRef : economyRef).current?.focus({ preventScroll: true });
      returnRole.current = null;
    }
  }, [pickingRole]);
  const closePicker = () => { returnRole.current = pickingRole; setPickingRole(null); setQuery(''); };
  if (pickingRole && smartEnabled) {
    const search = query.trim().toLowerCase();
    const groups = new Map<string, { name: string; models: AIModelConfig[] }>();
    for (const model of filterSelectableTextChatModels(props.models)) {
      if (!model.id?.trim()) continue;
      const name = getProviderDisplayName(model);
      if (search && !`${model.model_name} ${model.name} ${name}`.toLowerCase().includes(search)) continue;
      const key = getProviderGroupKey(model);
      const group = groups.get(key) ?? { name, models: [] };
      group.models.push(model); groups.set(key, group);
    }
    return <div className="native-model-selection" data-testid="model-selection-role-picker"
      data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel"
      onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape' || (event.key === 'ArrowLeft' && event.target !== searchRef.current)) {
          event.preventDefault(); event.stopPropagation(); closePicker();
        }
      }}>
      <MenuList><MenuItem leading={<Icon name="chevron-left" size="xs" />} onClick={closePicker}
        aria-label={t('modelSelector.picker.back')}>{roleLabel(pickingRole)}</MenuItem></MenuList>
      <SearchField ref={searchRef} size="sm" value={query} onValueChange={setQuery} disabled={props.disabled}
        aria-label={t('modelSelector.picker.search')} placeholder={t('modelSelector.picker.search')}
        leadingIcon={<Icon name="search" size="sm" />} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            pickerRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
          }
        }} />
      <div className="native-model-selection__picker-options" data-openbitfun-component="model-selector" data-openbitfun-part="rolePickerList">
        <ScrollArea orientation="vertical"><MenuList ref={pickerRef} data-testid="model-selection-role-options">
          {[...groups].map(([key, group]) => <MenuSection key={key} title={group.name}>
            {group.models.map(model => <MenuItem key={model.id} role="menuitemradio" checked={props[pickingRole]?.id === model.id}
              data-testid="model-selection-role-option" data-model-id={model.id} disabled={props.disabled}
              metadata={props[pickingRole]?.id === model.id ? <Icon name="check-line" size="sm" /> : undefined}
              onClick={() => { void props.onConfigureModel(pickingRole, model.id!).then(saved => { if (saved) closePicker(); }); }}>
              {model.model_name}
            </MenuItem>)}
          </MenuSection>)}
          {groups.size === 0 && <MenuItem disabled>{t('modelSelector.picker.empty')}</MenuItem>}
        </MenuList></ScrollArea>
      </div>
      <MenuList><MenuItem onClick={props.onSettings} metadata={<Icon name="chevron-right" size="sm" />}>{t('modelSelector.manageModels')}</MenuItem></MenuList>
    </div>;
  }
  if (props.routing.available !== true) {
    return <MenuList className="openbitfun-model-selector__mode-empty" data-testid="model-selection-smart-empty">
      <Button variant="quiet" size="sm" role="menuitem" tabIndex={-1} data-openbitfun-menu-item=""
        data-testid="model-routing-settings" disabled>{t('modelSelector.routing.notOpen')}</Button>
    </MenuList>;
  }
  if (!props.routing.ready || !props.routing.supported) {
    return <MenuList className="openbitfun-model-selector__mode-empty" data-testid="model-selection-smart-empty">
      <Tooltip content={!props.routing.supported ? t('modelSelector.routing.unsupported')
        : props.routing.issue ? t('modelSelector.routing.configurationIssue') : t('modelSelector.routing.notReady')}>
        <Button variant="quiet" size="sm" role="menuitem" tabIndex={-1} data-openbitfun-menu-item=""
          data-testid="model-routing-settings" disabled={props.disabled || !props.routing.supported}
          onClick={props.onRoutingSettings}>
          {t(props.routing.supported ? 'modelSelector.routing.configure' : 'modelSelector.routing.unsupported')}
        </Button>
      </Tooltip>
    </MenuList>;
  }
  const statusLabel = t(props.routing.mode === 'smart' ? 'modelSelector.routing.active' : 'modelSelector.routing.ready');
  return <div className="native-model-selection" data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel">
    <MenuList className="native-model-selection__activation" data-testid="model-selection-smart-activation" data-empty={!smartEnabled || undefined}>
      <label className="native-model-selection__toggle">
        {t('modelSelector.routing.enable')}
        <Switch checked={smartEnabled} disabled={props.disabled} data-testid="model-routing-toggle"
          data-openbitfun-menu-item="" tabIndex={-1}
          onCheckedChange={checked => { void props.onModeChange(checked ? 'smart' : 'manual'); }} />
      </label>
      {!smartEnabled && <Button variant="quiet" size="sm" role="menuitem" tabIndex={-1} data-openbitfun-menu-item=""
        data-testid="model-routing-settings" disabled={props.disabled} onClick={props.onRoutingSettings}>
        {t('modelSelector.routing.configure')}
      </Button>}
    </MenuList>
    {smartEnabled && <>
    <MenuList data-testid="model-selection-smart-preview">
      {(['primary', 'economy'] as const).map(role => <Tooltip key={role} content={props[role]
        ? `${props[role]!.model_name} · ${getProviderDisplayName(props[role]!)}` : t('modelSelector.modelNotConfigured')}>
        <MenuItem ref={role === 'primary' ? primaryRef : economyRef} data-testid={`model-selection-smart-${role}`}
          className="openbitfun-model-selector__settings-row" disabled={props.disabled}
          metadata={<OverflowText data-openbitfun-component="model-selector" data-openbitfun-part="modelInfo">{props[role]?.model_name ?? t('modelSelector.modelNotConfigured')}</OverflowText>}
          shortcut={<Icon name="chevron-right" size="sm" />} onClick={() => { setQuery(''); setPickingRole(role); }}>
          {roleLabel(role)}
        </MenuItem>
      </Tooltip>)}
    </MenuList>
    <MenuList data-testid="model-routing-section">
      <Tooltip content={props.routing.issue ? t('modelSelector.routing.configurationIssue') : t('modelSelector.routing.costHint')}>
        <MenuItem data-testid="model-routing-settings" className="openbitfun-model-selector__settings-row"
          disabled={props.disabled || !props.routing.supported} onClick={props.onRoutingSettings}
          metadata={<OverflowText role="status">{statusLabel}</OverflowText>}
          shortcut={<Icon name="chevron-right" size="sm" />}>{t('modelSelector.routing.settings')}</MenuItem>
      </Tooltip>
    </MenuList>
    </>}
  </div>;
}
