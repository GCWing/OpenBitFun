import type { AgentWithCapabilities } from '../agentsStore';
import { HARNESS_IDS, type HarnessId } from '@/shared/agents/identity';
import { HARNESS_PRESENTATION } from '@/shared/agents/harnessPresentation';
import React from 'react';
import { Icon } from '@openbitfun/ui';
import { GalleryZone } from '@/app/components/GalleryLayout';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

const HARNESS_STRATEGIES = HARNESS_IDS.map(id => ({ id, ...HARNESS_PRESENTATION[id] }));

type HarnessStrategyId = HarnessId;

// Route coordinates describe execution structure; labels and icons keep their
// natural size while the connecting lines adapt to the available width.
const STRATEGY_ROUTES: Record<HarnessStrategyId, {
  paths: string[];
  nodes: Array<[number, number]>;
}> = {
  Minimal: {
    paths: ['M 0 22 H 320'],
    nodes: [[160, 22]],
  },
  Standard: {
    paths: ['M 0 22 H 320'],
    nodes: [[64, 22], [128, 22], [192, 22], [256, 22]],
  },
  Ultimate: {
    paths: [
      'M 0 22 H 48 C 68 22 70 7 92 7 H 222 C 242 7 245 22 267 22 H 320',
      'M 48 22 C 68 22 70 37 92 37 H 222 C 242 37 245 22 267 22',
    ],
    nodes: [[48, 22], [116, 7], [174, 7], [124, 37], [192, 37], [267, 22]],
  },
  Creative: {
    paths: ['M 0 22 C 20 22 24 18 48 18 C 88 18 96 34 144 34 C 184 34 192 10 224 10 C 252 10 256 22 280 22 H 320'],
    nodes: [[48, 18], [144, 34], [280, 22]],
  },
};

function HarnessStrategyRoute({ profile }: { profile: HarnessStrategyId }) {
  const route = STRATEGY_ROUTES[profile];

  return (
    <div className="openbitfun-agents-scene__harness-route" aria-hidden="true">
      <svg viewBox="0 0 320 44" preserveAspectRatio="none" focusable="false">
        {route.paths.map(path => (
          <path key={path} d={path} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {route.nodes.map(([x, y]) => (
        <span
          key={`${x}-${y}`}
          className="openbitfun-agents-scene__harness-route-node"
          style={{ left: `${x / 320 * 100}%`, top: `${y / 44 * 100}%` }}
        >
          <Icon name="unselected" size="2xs" style={{ width: 9, height: 9 }} />
        </span>
      ))}
      {profile === 'Minimal' && (
        <span className="openbitfun-agents-scene__harness-route-arrow">
          <Icon name="arrow-right" size="2xs" />
        </span>
      )}
    </div>
  );
}

const AgentHarnessOverview: React.FC<{
  agents: AgentWithCapabilities[];
  onOpenDetails: (agent: AgentWithCapabilities) => void;
}> = ({ agents, onOpenDetails }) => {
  const { t } = useI18n('scenes/agents');

  return (
    <div className="openbitfun-agents-scene__harness">
      <GalleryZone
        id="harness-zone"
        className="openbitfun-agents-scene__harness-zone"
        data-testid="agents-harness-zone"
        title={t('harnessZone.title')}
        subtitle={t('harnessZone.subtitle')}
      >
        <ul
          className="openbitfun-agents-scene__harness-presentation"
          role="list"
          aria-label={t('harnessZone.title')}
          data-openbitfun-scene="agents"
          data-openbitfun-part="harnessPresentation"
        >
          {HARNESS_STRATEGIES.map(({ id, icon, gear }) => {
            const agent = agents.find(candidate => candidate.id === id);

            return (
              <li
                key={id}
                className="openbitfun-agents-scene__harness-profile-item"
              >
                <button
                  type="button"
                  disabled={!agent}
                  onClick={() => { if (agent) onOpenDetails(agent); }}
                  className="openbitfun-agents-scene__harness-profile"
                  data-openbitfun-component="harness-profile-step"
                  data-openbitfun-part="root"
                  data-openbitfun-profile={id}
                  data-harness-gear={gear}
                  data-testid={`agents-harness-${id}`}
                >
                  <Icon name={icon} size="lg" className="openbitfun-agents-scene__harness-profile-icon" />
                  <strong className="openbitfun-agents-scene__harness-profile-name">
                    {t(`harnessZone.profiles.${id}.name`)}
                  </strong>
                  <span className="openbitfun-agents-scene__harness-profile-purpose">
                    {t(`harnessZone.profiles.${id}.purpose`)}
                  </span>
                  <HarnessStrategyRoute profile={id} />
                </button>
              </li>
            );
          })}
        </ul>
      </GalleryZone>
    </div>
  );
};

export default AgentHarnessOverview;
