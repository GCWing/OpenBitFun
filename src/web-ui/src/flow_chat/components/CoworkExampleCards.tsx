/**
 * Cowork example cards shown in empty sessions.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plane, Presentation, ListTodo, CalendarDays, ClipboardList, Mail, FileSpreadsheet, HandCoins, TrendingUp, RotateCcw } from 'lucide-react';
import { ActionCard, IconButton, Tooltip, Icon } from '@openbitfun/ui';
import './CoworkExampleCards.scss';

type ExampleId =
  | 'desktop_cleanup'
  | 'vacation_plan'
  | 'make_ppt'
  | 'todo_breakdown'
  | 'optimize_week'
  | 'weekly_plan'
  | 'meeting_minutes'
  | 'reply_email'
  | 'make_docx'
  | 'make_spreadsheet'
  | 'budget_plan';

interface ExampleItem {
  id: ExampleId;
  icon: React.ReactNode;
}

const EXAMPLES: ExampleItem[] = [
  { id: 'desktop_cleanup', icon: <Icon name="image" size="md" /> },
  { id: 'vacation_plan', icon: <Icon glyph={Plane} size="md" /> },
  { id: 'make_ppt', icon: <Icon glyph={Presentation} size="md" /> },
  { id: 'todo_breakdown', icon: <Icon glyph={ListTodo} size="md" /> },
  { id: 'optimize_week', icon: <Icon glyph={TrendingUp} size="md" /> },
  { id: 'weekly_plan', icon: <Icon glyph={CalendarDays} size="md" /> },
  { id: 'meeting_minutes', icon: <Icon glyph={ClipboardList} size="md" /> },
  { id: 'reply_email', icon: <Icon glyph={Mail} size="md" /> },
  { id: 'make_docx', icon: <Icon name="file-text" size="md" /> },
  { id: 'make_spreadsheet', icon: <Icon glyph={FileSpreadsheet} size="md" /> },
  { id: 'budget_plan', icon: <Icon glyph={HandCoins} size="md" /> },
];

function pickRandomUnique<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];

  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

export interface CoworkExampleCardsProps {
  resetKey: number;
  onClose?: () => void;
  onSelectPrompt: (prompt: string) => void;
  onAddPlugin?: () => void;
}

export const CoworkExampleCards: React.FC<CoworkExampleCardsProps> = ({
  resetKey,
  onClose,
  onSelectPrompt,
  onAddPlugin,
}) => {
  const { t } = useTranslation('flow-chat');
  const [selected, setSelected] = useState<ExampleItem[]>(() => pickRandomUnique(EXAMPLES, 3));

  useEffect(() => {
    setSelected(pickRandomUnique(EXAMPLES, 3));
  }, [resetKey]);

  const handleRefresh = useCallback(() => {
    setSelected(pickRandomUnique(EXAMPLES, 3));
  }, []);

  const cards = useMemo(() => {
    return selected.map((example) => {
      const title = t(`coworkExamples.items.${example.id}.title`);
      const description = t(`coworkExamples.items.${example.id}.description`);
      const prompt = t(`coworkExamples.items.${example.id}.prompt`);
      const handleSelect = () => onSelectPrompt(prompt);

      return (
        <ActionCard
          key={example.id}
          className="openbitfun-cowork-example-cards__card"
          description={description}
          leading={example.icon}
          size="md"
          onClick={handleSelect}
        >
          {title}
        </ActionCard>
      );
    });
  }, [onSelectPrompt, selected, t]);

  return (
    <div data-openbitfun-component="cowork-example-cards" data-openbitfun-part="root" className="openbitfun-cowork-example-cards">
      <div data-openbitfun-component="cowork-example-cards" data-openbitfun-part="header" className="openbitfun-cowork-example-cards__header">
        <div data-openbitfun-component="cowork-example-cards" data-openbitfun-part="title" className="openbitfun-cowork-example-cards__title">{t('coworkExamples.title')}</div>
        <div data-openbitfun-component="cowork-example-cards" data-openbitfun-part="actions" className="openbitfun-cowork-example-cards__header-actions">
          {onAddPlugin && (
            <Tooltip content={t('coworkExamples.addPlugin')}>
              <IconButton
                size="sm"
                onClick={onAddPlugin}
                aria-label={t('coworkExamples.addPlugin')}
                icon={<Icon name="plus" size="sm" />}
              />
            </Tooltip>
          )}
          <Tooltip content={t('coworkExamples.refresh')}>
            <IconButton
              size="sm"
              onClick={handleRefresh}
              aria-label={t('coworkExamples.refresh')}
              icon={<RotateCcw size={14} />}
            />
          </Tooltip>
          {onClose && (
            <Tooltip content={t('coworkExamples.close')}>
              <IconButton
                size="sm"
                onClick={onClose}
                aria-label={t('coworkExamples.close')}
                icon={<Icon name="xmark" size="sm" />}
              />
            </Tooltip>
          )}
        </div>
      </div>
      <div data-openbitfun-component="cowork-example-cards" data-openbitfun-part="grid" className="openbitfun-cowork-example-cards__grid">
        {cards}
      </div>
    </div>
  );
};

export default CoworkExampleCards;
