import { Field, MultiSelect, StatusPill } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { MAX_MODEL_USER_TAGS, normalizeModelTags } from '../services/modelTags';

interface ModelTagsFieldProps {
  tags: string[];
  recommendedTags?: string[];
  disabled?: boolean;
  onChange: (tags: string[]) => void;
}

export default function ModelTagsField({ tags, recommendedTags, disabled, onChange }: ModelTagsFieldProps) {
  const { t } = useI18n('settings/models');
  const recommendations = normalizeModelTags(recommendedTags);
  const atTagLimit = tags.length >= MAX_MODEL_USER_TAGS;

  return (
    <div className="openbitfun-model-settings__selected-model-tags">
      <Field label={t('pool.tagsLabel')}
        labelAction={t('pool.tagsCount', { count: tags.length, max: MAX_MODEL_USER_TAGS })}
        description={atTagLimit
          ? t('pool.tagsLimitReached', { max: MAX_MODEL_USER_TAGS })
          : t('pool.tagsHint', { max: MAX_MODEL_USER_TAGS })}>
        <MultiSelect size="sm" value={tags}
          aria-label={t('pool.addTags')}
          options={tags.map(tag => ({ value: tag, label: tag }))}
          maxVisibleTags={Math.max(MAX_MODEL_USER_TAGS, tags.length)}
          onCreateValue={atTagLimit ? undefined : value => value}
          onValueChange={values => {
            const nextTags = normalizeModelTags(values);
            if (nextTags.length > MAX_MODEL_USER_TAGS
              && nextTags.some(tag => !tags.includes(tag))) return;
            onChange(nextTags);
          }}
          placeholder={t('pool.tagsPlaceholder')} disabled={disabled} />
      </Field>
      {recommendations.length > 0 && (
        <Field label={t('pool.recommendedTags')}>
          <div className="openbitfun-model-settings__pool-tags">
            {recommendations.map(tag => <StatusPill tone="neutral" key={tag}>{tag}</StatusPill>)}
          </div>
        </Field>
      )}
    </div>
  );
}
