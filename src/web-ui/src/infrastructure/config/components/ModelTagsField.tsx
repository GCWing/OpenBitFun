import { Button, Field, Icon, IconButton, Input, StatusPill, Tooltip } from '@openbitfun/ui';
import { useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { MAX_MODEL_USER_TAGS, normalizeModelTags } from '../services/modelTags';
import { ConfigPageRow } from './common/ConfigPageLayout';

interface ModelTagsFieldProps {
  tags: string[];
  recommendedTags?: string[];
  disabled?: boolean;
  layout?: 'field' | 'row';
  onChange: (tags: string[]) => void;
}

interface TagDraft {
  originalTag: string | null;
  value: string;
}

export default function ModelTagsField({ tags, recommendedTags, disabled, layout = 'field', onChange }: ModelTagsFieldProps) {
  const { t } = useI18n('settings/models');
  const [tagDraft, setTagDraft] = useState<TagDraft | null>(null);
  const tagDraftRef = useRef<TagDraft | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const tagButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const recommendations = normalizeModelTags(recommendedTags);
  const atTagLimit = tags.length >= MAX_MODEL_USER_TAGS;

  const updateTagDraft = (draft: TagDraft | null) => {
    tagDraftRef.current = draft;
    setTagDraft(draft);
  };

  const restoreTagFocus = (tag?: string | null) => {
    requestAnimationFrame(() => {
      const target = (tag ? tagButtonRefs.current.get(tag) : undefined) ?? addButtonRef.current;
      target?.focus();
    });
  };

  const finishTagDraft = () => {
    const draft = tagDraftRef.current;
    if (!draft || disabled) return;
    const value = draft.value.trim();
    const alreadyExists = tags.includes(value);
    const nextTags = !value || alreadyExists
      ? tags
      : normalizeModelTags(draft.originalTag === null
        ? [...tags, value]
        : tags.map(tag => tag === draft.originalTag ? value : tag));
    if (nextTags.length > MAX_MODEL_USER_TAGS && nextTags.some(tag => !tags.includes(tag))) return;

    // Clear synchronously so Enter followed by blur cannot apply the same draft twice.
    updateTagDraft(null);
    if (nextTags !== tags) onChange(nextTags);
  };

  const tagInput = tagDraft ? (
    <Input
      autoFocus
      size="xs"
      shape="pill"
      className="openbitfun-model-settings__tag-input"
      aria-label={tagDraft.originalTag === null
        ? t('pool.addTags')
        : t('pool.editTag', { tag: tagDraft.originalTag })}
      value={tagDraft.value}
      placeholder={t('pool.tagsPlaceholder')}
      disabled={disabled}
      onFocus={event => event.target.select()}
      onChange={event => updateTagDraft({ ...tagDraft, value: event.target.value })}
      onBlur={() => finishTagDraft()}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finishTagDraft();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          updateTagDraft(null);
          restoreTagFocus(tagDraft.originalTag);
        }
      }}
    />
  ) : null;

  const tagEditor = (
    <div className="openbitfun-model-settings__tag-editor" role="group" aria-label={t('pool.tagsLabel')}>
      <div className="openbitfun-model-settings__tag-list">
        {tags.map(tag => (
          <div className="openbitfun-model-settings__model-capsule" key={tag}>
            {tagDraft?.originalTag === tag ? tagInput : (
              <>
                <Button
                  ref={element => {
                    if (element) tagButtonRefs.current.set(tag, element);
                    else tagButtonRefs.current.delete(tag);
                  }}
                  variant="outline"
                  size="xs"
                  className="openbitfun-model-settings__model-capsule-edit"
                  aria-label={t('pool.editTag', { tag })}
                  disabled={disabled || tags.length > MAX_MODEL_USER_TAGS}
                  onClick={() => updateTagDraft({ originalTag: tag, value: tag })}
                >
                  {tag}
                </Button>
                <Tooltip content={t('pool.removeTag', { tag })}>
                  <IconButton
                    className="openbitfun-model-settings__model-capsule-dismiss"
                    size="xs"
                    shape="circle"
                    variant="quiet"
                    aria-label={t('pool.removeTag', { tag })}
                    disabled={disabled}
                    onClick={() => {
                      onChange(tags.filter(value => value !== tag));
                      restoreTagFocus(tags.find(value => value !== tag));
                    }}
                    icon={<Icon name="xmark" size="sm" />}
                  />
                </Tooltip>
              </>
            )}
          </div>
        ))}
        {tagDraft?.originalTag === null && (
          <div className="openbitfun-model-settings__model-capsule">
            {tagInput}
          </div>
        )}
      </div>
      <Tooltip content={atTagLimit ? t('pool.tagsLimitReached', { max: MAX_MODEL_USER_TAGS }) : t('pool.addTags')}>
        <IconButton
          ref={addButtonRef}
          className="openbitfun-model-settings__tag-add"
          size="xs"
          variant="quiet"
          aria-label={t('pool.addTags')}
          disabled={disabled || atTagLimit || !!tagDraft}
          onClick={() => updateTagDraft({ originalTag: null, value: '' })}
          icon={<Icon name="plus" size="sm" />}
        />
      </Tooltip>
    </div>
  );
  const recommendationTags = (
    <div className="openbitfun-model-settings__pool-tags">
      {recommendations.map(tag => <StatusPill tone="neutral" key={tag}>{tag}</StatusPill>)}
    </div>
  );

  if (layout === 'row') {
    return (
      <>
        <ConfigPageRow label={t('pool.tagsLabel')} align="center" balanced
          description={atTagLimit ? t('pool.tagsLimitReached', { max: MAX_MODEL_USER_TAGS }) : undefined}>
          {tagEditor}
        </ConfigPageRow>
        {recommendations.length > 0 && (
          <ConfigPageRow label={t('pool.recommendedTags')} align="center">
            {recommendationTags}
          </ConfigPageRow>
        )}
      </>
    );
  }

  return (
    <div className="openbitfun-model-settings__selected-model-tags">
      <Field label={t('pool.tagsLabel')}
        labelAction={t('pool.tagsCount', { count: tags.length, max: MAX_MODEL_USER_TAGS })}
        description={atTagLimit
          ? t('pool.tagsLimitReached', { max: MAX_MODEL_USER_TAGS })
          : t('pool.tagsHint', { max: MAX_MODEL_USER_TAGS })}>
        {tagEditor}
      </Field>
      {recommendations.length > 0 && (
        <Field label={t('pool.recommendedTags')}>
          {recommendationTags}
        </Field>
      )}
    </div>
  );
}
