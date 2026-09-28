/**
 * Tool status indicator for tool execution states.
 */

import React from 'react';
import { Icon, type IconName } from '@openbitfun/ui';
import { Loader2, XCircle, AlertCircle, type LucideIcon } from 'lucide-react';
import { ToolProcessingDots } from '@openbitfun/ui/flow-chat';
import type { ToolExecutionStatus } from '../../shared/types/tool-events';

interface ToolStatusIndicatorProps {
  status: ToolExecutionStatus;
  duration?: number;
  className?: string;
  showLabel?: boolean;
}

const STATUS_CONFIG: Record<
  ToolExecutionStatus,
  {
    icon: LucideIcon | null;
    catalogIcon?: IconName;
    color: string;
    bgColor: string;
    label: string;
    animate: boolean;
    useDots?: boolean;
  }
> = {
  pending: {
    icon: null,
    color: 'text-gray-500',
    bgColor: 'bg-gray-100',
    label: 'Waiting',
    animate: false,
    useDots: true,
  },
  receiving: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100',
    label: 'Receiving input',
    animate: true
  },
  starting: {
    icon: null,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100',
    label: 'Starting',
    animate: false,
    useDots: true,
  },
  running: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100', 
    label: 'Running',
    animate: true
  },
  completed: {
    icon: null,
    catalogIcon: 'check-circle',
    color: 'text-green-500',
    bgColor: 'bg-green-100',
    label: 'Completed',
    animate: false
  },
  failed: {
    icon: XCircle,
    color: 'text-red-500',
    bgColor: 'bg-red-100',
    label: 'Failed',
    animate: false
  },
  cancelled: {
    icon: AlertCircle,
    color: 'text-orange-500',
    bgColor: 'bg-orange-100', 
    label: 'Cancelled',
    animate: false
  }
};

export const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status,
  duration,
  className = '',
  showLabel = true
}) => {
  const config = STATUS_CONFIG[status];

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = (ms / 1000).toFixed(1);
    return `${seconds}s`;
  };

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <div className={`flex items-center justify-center w-5 h-5 rounded-full ${config.bgColor}`}>
        {config.useDots ? (
          <ToolProcessingDots size={12} className={config.color} />
        ) : config.catalogIcon ? (
          <Icon
            name={config.catalogIcon}
            size="xs"
            className={`w-3 h-3 ${config.color}`}
          />
        ) : config.icon ? (
          <Icon glyph={config.icon} size="xs"
            className={`w-3 h-3 ${config.color} ${config.animate ? 'animate-spin' : ''}`}
          />
        ) : null}
      </div>
      
      {showLabel && (
        <div className="flex items-center gap-2 text-sm">
          <span className={config.color}>{config.label}</span>
          {duration && status === 'completed' && (
            <span className="text-gray-500">
              ({formatDuration(duration)})
            </span>
          )}
        </div>
      )}
    </div>
  );
};
