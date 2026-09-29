import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Tool card for TodoWrite.
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { i18nService } from '@/infrastructure/i18n';
import type { ToolCardProps } from '../types/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { useDialogTurnTodos } from '../hooks/useDialogTurnTodos';
import {
  TodoToolCard as TodoToolCardView,
  type TodoToolCardItemStatus,
} from '@openbitfun/ui/flow-chat';
import { createTodoRenderItems, type TodoLike } from './todoRenderItems';

function normalizeTodoStatus(status: TodoLike['status']): TodoToolCardItemStatus {
  if (status === 'completed' || status === 'in_progress' || status === 'cancelled') {
    return status;
  }
  return 'pending';
}

export const TodoWriteDisplay: React.FC<ToolCardProps> = ({
  toolItem,
  turnId,
  sessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const { status, toolResult, partialParams, isParamsStreaming } = toolItem;

  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const toolId = toolItem.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const turnTodos = useDialogTurnTodos(sessionId, turnId);

  const todosToDisplay: TodoLike[] = useMemo(() => {
    if (isParamsStreaming && partialParams?.todos && Array.isArray(partialParams.todos)) {
      return partialParams.todos as TodoLike[];
    }
    if (turnTodos.length > 0) {
      return turnTodos as TodoLike[];
    }
    if (toolResult?.result?.todos && Array.isArray(toolResult.result.todos)) {
      return toolResult.result.todos as TodoLike[];
    }
    return [];
  }, [partialParams, toolResult, isParamsStreaming, turnTodos]);

  const todoRenderItems = useMemo(
    () => createTodoRenderItems(todosToDisplay),
    [todosToDisplay],
  );

  const taskStats = useMemo(() => {
    if (todosToDisplay.length === 0) return { completed: 0, total: 0 };
    const completed = todosToDisplay.filter((td) => td.status === 'completed').length;
    return { completed, total: todosToDisplay.length };
  }, [todosToDisplay]);

  const isAllCompleted = useMemo(
    () => todosToDisplay.length > 0 && taskStats.completed === taskStats.total,
    [todosToDisplay.length, taskStats],
  );

  const isLoading = status === 'preparing' || status === 'streaming' || status === 'running';

  const currentDisplayTask = useMemo(() => {
    return todosToDisplay.find((todo) => todo.status === 'in_progress')
      ?? todosToDisplay.find((todo) => todo.status === 'pending')
      ?? null;
  }, [todosToDisplay]);

  const progressSummary = (task: string) => t('toolCards.todoWrite.summaryProgress', {
    task, completed: i18nService.formatNumber(taskStats.completed), total: i18nService.formatNumber(taskStats.total),
  });
  const tasksLabel = t('toolCards.todoWrite.tasks');
  const headerContent = (() => {
    if (todosToDisplay.length === 0 && isLoading) {
      return `${tasksLabel}…`;
    }
    if (isAllCompleted) {
      return progressSummary(t('toolCards.todoWrite.allCompleted'));
    }
    if (currentDisplayTask) {
      return progressSummary(currentDisplayTask.content ?? tasksLabel);
    }
    if (todosToDisplay.length > 0) {
      return t('toolCards.todoWrite.tasksCount', { count: todosToDisplay.length });
    }
    return tasksLabel;
  })();

  const handleToggleExpanded = useCallback(() => {
    if (todosToDisplay.length === 0) return;
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, setIsExpanded, todosToDisplay.length]);

  const hasTodos = todosToDisplay.length > 0;

  return (
    <div data-openbitfun-adapter="todo-write"
      ref={cardRootRef}
      data-tool-card-id={toolId ?? ''}
    >
      <TodoToolCardView
        status={status}
        isExpanded={isExpanded && hasTodos}
        onToggle={hasTodos ? handleToggleExpanded : undefined}
        allCompleted={isAllCompleted}
        completedCount={taskStats.completed}
        items={todoRenderItems.map(({ todo, key }) => ({
          content: todo.content,
          key,
          status: normalizeTodoStatus(todo.status),
        }))}
        loading={isLoading}
        mode="standard"
        progressLabel={`${i18nService.formatNumber(taskStats.completed)} / ${i18nService.formatNumber(taskStats.total)}`}
        summary={headerContent}
        title={tasksLabel}
        totalCount={taskStats.total}
      />
    </div>
  );
};
