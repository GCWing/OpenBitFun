import { runtimeToolRecord } from './runtimeToolCardModel';
import {
  builtinRecords, builtinText,
  type BuiltinCardContext, type BuiltinCardField, type BuiltinTranslate,
} from './builtinToolCardModel';

function actionLabel(action: string | undefined, t: BuiltinTranslate): string | undefined {
  switch (action) {
    case 'presets': return t('toolCards.builtin.desktopCard.actions.presets');
    case 'create': return t('toolCards.builtin.desktopCard.actions.create');
    case 'update': return t('toolCards.builtin.desktopCard.actions.update');
    case 'list': return t('toolCards.builtin.desktopCard.actions.list');
    case 'get': return t('toolCards.builtin.desktopCard.actions.get');
    case 'show': return t('toolCards.builtin.desktopCard.actions.show');
    case 'hide': return t('toolCards.builtin.desktopCard.actions.hide');
    case 'delete': return t('toolCards.builtin.desktopCard.actions.delete');
    case 'refresh': return t('toolCards.builtin.desktopCard.actions.refresh');
    default: return undefined;
  }
}

function templateLabel(kind: string | undefined, t: BuiltinTranslate): string | undefined {
  switch (kind) {
    case 'countdown': return t('toolCards.builtin.desktopCard.templates.countdown');
    case 'checklist': return t('toolCards.builtin.desktopCard.templates.checklist');
    case 'note': return t('toolCards.builtin.desktopCard.templates.note');
    case 'progress': return t('toolCards.builtin.desktopCard.templates.progress');
    case 'metrics': return t('toolCards.builtin.desktopCard.templates.metrics');
    case 'chart': return t('toolCards.builtin.desktopCard.templates.chart');
    case 'cronJob': return t('toolCards.builtin.desktopCard.templates.cronJob');
    case 'custom': return t('toolCards.builtin.desktopCard.templates.custom');
    default: return kind;
  }
}

function sourceLabel(source: Record<string, unknown>, t: BuiltinTranslate): string | undefined {
  const target = builtinText(source.url, source.command);
  const interval = typeof source.intervalSeconds === 'number' ? source.intervalSeconds : undefined;
  if (interval === undefined) return target ?? builtinText(source.kind);
  switch (source.kind) {
    case 'http': return t('toolCards.builtin.desktopCard.sources.http', { target: target ?? '', interval });
    case 'command': return t('toolCards.builtin.desktopCard.sources.command', { target: target ?? '', interval });
    default: return builtinText(source.kind);
  }
}

function visibilityLabel(visible: unknown, t: BuiltinTranslate): string | undefined {
  if (typeof visible !== 'boolean') return undefined;
  return t(visible ? 'toolCards.builtin.desktopCard.visible' : 'toolCards.builtin.desktopCard.hidden');
}

export function buildDesktopCardToolCard(context: BuiltinCardContext): void {
  const { model, input, data, done, t, field, section, outcome, list, link } = context;
  model.family = 'desktop-card';
  const action = builtinText(input.action);
  model.action = actionLabel(action, t) ?? (action ? `${model.action} · ${action}` : model.action);

  const card = runtimeToolRecord(data.card);
  const draft = runtimeToolRecord(input.card);
  const patch = runtimeToolRecord(input.patch);
  const template = runtimeToolRecord(card.template ?? draft.template ?? patch.template);
  const source = runtimeToolRecord(card.dataSource ?? draft.dataSource ?? patch.dataSource);
  const lastData = runtimeToolRecord(card.lastData);
  model.summary = builtinText(card.title, draft.title, patch.title, input.cardId, card.id);

  field('card', builtinText(card.id, input.cardId));
  field('template', templateLabel(builtinText(template.kind), t));
  field('dataSource', source.kind ? sourceLabel(source, t) : undefined);
  field('visibility', visibilityLabel(card.visible, t));
  section('refreshError', lastData.error);
  section('commandStderr', lastData.error ? undefined : lastData.warning, 'code');
  link('url', card.link ?? draft.link, 'openSource');

  if (action === 'presets') {
    model.recordsLabel = t('toolCards.builtin.fields.presets');
    list(builtinRecords(data.presets)?.map((row, index) => ({
      key: `${builtinText(row.id) ?? 'preset'}:${index}`,
      title: builtinText(row.id) ?? t('toolCards.builtin.unknown'),
      description: builtinText(row.useWhen),
    })));
    return;
  }

  if (action === 'list') {
    model.recordsLabel = t('toolCards.builtin.fields.cards');
    if (data.enabled === false) model.notice = t('toolCards.builtin.desktopCard.disabledNotice');
    list(builtinRecords(data.cards)?.map((row, index) => {
      const fields: BuiltinCardField[] = [];
      const rowTemplate = runtimeToolRecord(row.template);
      field('template', templateLabel(builtinText(rowTemplate.kind), t), fields);
      field('visibility', visibilityLabel(row.visible, t), fields);
      const rowError = builtinText(runtimeToolRecord(row.lastData).error);
      field('refreshError', rowError, fields);
      return {
        key: `${builtinText(row.id) ?? 'card'}:${index}`,
        title: builtinText(row.title, row.id) ?? t('toolCards.builtin.unknown'),
        description: builtinText(row.subtitle),
        fields,
      };
    }));
    return;
  }

  if (!done) return;
  switch (action) {
    case 'create': outcome('cardCreated', 'success'); break;
    case 'update': outcome('updated', 'success'); break;
    case 'show': outcome('cardShown', 'success'); break;
    case 'hide': outcome('cardHidden', 'neutral'); break;
    case 'delete': if (data.deleted === true) outcome('deleted', 'neutral'); break;
  }
}
