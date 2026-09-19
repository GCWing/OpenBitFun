import { useEffect, useRef, useState } from 'react';
import { Button, Field, Icon, IconButton, Input, Select, Switch } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import type { SkillMarketConfig, SkillMarketSource } from '../types';
import { configManager } from '../services/ConfigManager';
import { ConfigCollectionItem } from './common';

export function SkillMarketSettings({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n('settings/skills');
  const [config, setConfig] = useState<SkillMarketConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const activeRef = useRef(true);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    activeRef.current = true;
    setError(null);
    configAPI.getConfig('app.skill_market').then((value: SkillMarketConfig | undefined) => {
      if (!active) return;
      if (!Array.isArray(value?.sources)) {
        setError(t('market.settings.unsupported'));
        return;
      }
      setConfig(value!);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { active = false; activeRef.current = false; };
  }, [t, loadAttempt]);

  const updateSource = (index: number, changes: Partial<SkillMarketSource>) => {
    setConfig(current => current && ({ ...current, sources: current.sources.map((source, i) => i === index ? { ...source, ...changes } : source) }));
  };

  const save = async () => {
    if (!config) return;
    setError(null);
    for (const source of config.sources) {
      try {
        const url = new URL(source.url.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      } catch {
        setExpandedId(source.id);
        setError(t('market.settings.invalidUrl'));
        return;
      }
    }
    setSaving(true);
    try {
      await configManager.updateConfig<SkillMarketConfig>('app.skill_market', (current) => {
        if (!activeRef.current) throw new Error('Marketplace settings surface changed');
        return { ...current, sources: config.sources.map(source => ({ ...source,
          name: source.name.trim() || source.url.trim(),
          url: source.url.trim().replace(/\/+$/, ''), api_token: source.api_token.trim(),
        })) };
      });
      if (activeRef.current) onSaved();
    } catch (err) {
      if (activeRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (activeRef.current) setSaving(false);
    }
  };

  return (
    <div className="openbitfun-skills-scene__modal-form">
      {config && <>
        <div>
          {config.sources.map((source, index) => {
            const label = source.name.trim() || t('market.settings.newSource');
            return (
              <ConfigCollectionItem
                key={source.id}
                label={label}
                badge={<span className="openbitfun-collection-item__badge">{source.provider === 'skillhub' ? 'SkillHub' : source.provider === 'skills-sh' ? 'skills.sh' : source.provider}</span>}
                expanded={expandedId === source.id}
                onToggle={() => setExpandedId(current => current === source.id ? null : source.id)}
                toggleOnRowClick
                detailsDisabled={saving}
                control={(
                  <>
                    <Switch checked={source.enabled} disabled={saving}
                      aria-label={`${t('market.settings.enabled')} ${label}`}
                      onChange={event => updateSource(index, { enabled: event.target.checked })} />
                    <IconButton size="sm" disabled={saving}
                      aria-label={`${t('market.settings.remove')} ${label}`}
                      title={t('market.settings.remove')}
                      icon={<Icon name="delete" size="sm" />}
                      onClick={() => {
                        setConfig({ ...config, sources: config.sources.filter((_, i) => i !== index) });
                        if (expandedId === source.id) setExpandedId(null);
                      }} />
                  </>
                )}
                details={(
                  <div className="openbitfun-skills-scene__modal-form">
                    <Field label={t('market.settings.name')} controlWidth="fill">
                      <Input size="sm" value={source.name} disabled={saving} onChange={event => updateSource(index, { name: event.target.value })} />
                    </Field>
                    <Field label={t('market.settings.provider')} controlWidth="fill">
                      <Select size="sm" value={source.provider} disabled={saving}
                        options={[{ value: 'skills-sh', label: 'skills.sh' }, { value: 'skillhub', label: 'SkillHub' }]}
                        onValueChange={provider => updateSource(index, { provider: String(provider) })} />
                    </Field>
                    <Field label={t('market.settings.url')} description={t('market.settings.urlHint')} controlWidth="fill">
                      <Input size="sm" value={source.url} placeholder="https://skills.example.com" disabled={saving}
                        onChange={event => updateSource(index, { url: event.target.value })} />
                    </Field>
                    <Field label={t('market.settings.token')} description={t('market.settings.tokenHint')} controlWidth="fill">
                      <Input size="sm" type="password" autoComplete="off" value={source.api_token} disabled={saving}
                        onChange={event => updateSource(index, { api_token: event.target.value })} />
                    </Field>
                  </div>
                )}
              />
            );
          })}
        </div>
        {config.sources.length === 0 && <p>{t('market.settings.empty')}</p>}
        <Button size="sm" variant="outline" disabled={saving} onClick={() => setConfig({ ...config, sources: [...config.sources, {
          id: crypto.randomUUID(), name: '', provider: 'skills-sh', url: '', enabled: true, api_token: '',
        }] })}>{t('market.settings.add')}</Button>
        <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? t('market.settings.saving') : t('market.settings.save')}
        </Button>
      </>}
      {error && <div role="alert">
        <p>{error}</p>
        {!config && <Button size="sm" variant="outline" onClick={() => setLoadAttempt(attempt => attempt + 1)}>
          {t('toolbar.refreshTooltip')}
        </Button>}
      </div>}
    </div>
  );
}
