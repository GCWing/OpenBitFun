import React, { useId } from 'react';
import './ModelModeAnimation.scss';

interface ModelModeAnimationProps {
  mode: 'smart' | 'pool';
}

type StarStyle = React.CSSProperties & Record<`--_model-star-${string}`, string | number>;

// Stable, irregular clouds keep the material still across React renders.
function starCloud(count: number, width: number, height: number, phase: number) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963 + phase + (index % 3) * 0.17;
    const spread = Math.sqrt((index + 0.5) / count);
    return {
      x: Math.cos(angle) * spread * width / 2,
      y: Math.sin(angle) * spread * height / 2,
      radius: 0.65 + (index % 4) * 0.18,
      opacity: 0.7 + (index % 5) * 0.06,
    };
  });
}

const batteryStars = [0.6, 2.1, 3.7].map((phase) => starCloud(24, 50, 78, phase));
const batteryCenters = [52, 140, 228] as const;

// Different depths share a stable sky, but never a shared twinkle phase.
const smartStarLayers = [
  { depth: 'far', count: 48, radius: 0.4 },
  { depth: 'middle', count: 28, radius: 0.64 },
  { depth: 'near', count: 12, radius: 1.08 },
].map(({ depth, count, radius }, layerIndex) => ({
  depth,
  stars: Array.from({ length: count }, (_, index) => ({
    x: 6 + (index * 61 + index * index * 13 + layerIndex * 31) % 269,
    y: 7 + (index * 43 + index * index * 7 + layerIndex * 23) % 113,
    radius: radius + (index % 3) * 0.12,
    opacity: 0.66 + layerIndex * 0.1 + (index % 3) * 0.05,
    duration: `${3.4 - layerIndex * 0.6 + (index % 7) * 0.25}s`,
    delay: `${-(index * 1.37 + layerIndex * 2.71)}s`,
  })),
}));

const px = (value: number) => `${value.toFixed(2)}px`;

function SmartStarfield() {
  const skyId = useId();

  return (
    <g className="openbitfun-model-mode__sky" mask={`url(#${skyId}-text-space)`}>
      <defs>
        <radialGradient id={`${skyId}-glow`}>
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="26%" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.03" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${skyId}-text-fade`}>
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
          <stop offset="28%" stopColor="currentColor" stopOpacity="0.12" />
          <stop offset="64%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="100%" stopColor="currentColor" />
        </radialGradient>
        <mask id={`${skyId}-text-space`} x="0" y="0" width="280" height="128" maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }}>
          <rect width="280" height="128" fill={`url(#${skyId}-text-fade)`} />
        </mask>
      </defs>
      {smartStarLayers.map(({ depth, stars }) => (
        <g key={depth} className={`openbitfun-model-mode__sky-layer openbitfun-model-mode__sky-layer--${depth}`}>
          {stars.map((star, index) => (
            <g key={index} transform={`translate(${star.x} ${star.y})`}>
              <g
                className={`openbitfun-model-mode__sky-star${depth === 'near' ? ' openbitfun-model-mode__sky-star--near' : ''}`}
                style={{
                  '--_model-star-opacity': star.opacity,
                  '--_model-star-duration': star.duration,
                  '--_model-star-delay': star.delay,
                } as StarStyle}
              >
                {depth === 'near' && (
                  <circle className="openbitfun-model-mode__sky-glow" r={star.radius * 3} fill={`url(#${skyId}-glow)`} />
                )}
                <circle className="openbitfun-model-mode__sky-core" r={star.radius} />
              </g>
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

function ModeNebula() {
  const nebulaId = useId();

  return (
    <g className="openbitfun-model-mode__nebula">
      <defs>
        <filter id={`${nebulaId}-cloud`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035 0.04" numOctaves="3" seed="8" result="noise" />
          <feColorMatrix
            in="noise"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.8 0 0 0 -0.9"
            result="cloud"
          />
          <feComposite in="SourceGraphic" in2="cloud" operator="in" />
        </filter>
      </defs>
      <rect className="openbitfun-model-mode__nebula-field" width="280" height="128" filter={`url(#${nebulaId}-cloud)`} />
    </g>
  );
}

function BatteryMaterial() {
  const batteryId = useId();

  return (
    <g className="openbitfun-model-mode__battery-silhouettes">
      <defs>
        <linearGradient className="openbitfun-model-mode__battery-glass" id={`${batteryId}-glass`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="48%" stopColor="currentColor" stopOpacity="0.09" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.16" />
        </linearGradient>
        <radialGradient className="openbitfun-model-mode__battery-light" id={`${batteryId}-energy`} cx="50%" cy="88%" r="82%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="45%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <linearGradient className="openbitfun-model-mode__battery-rim" id={`${batteryId}-rim`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.42" />
          <stop offset="52%" stopColor="currentColor" stopOpacity="0.36" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.4" />
        </linearGradient>
        <filter id={`${batteryId}-soften`} x="-15%" y="-15%" width="130%" height="130%">
          <feGaussianBlur stdDeviation="0.45" />
        </filter>
        <clipPath id={`${batteryId}-bounds`}>
          <rect x="-34" y="-52" width="68" height="104" rx="14" />
        </clipPath>
        <radialGradient id={`${batteryId}-glow`}>
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.42" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${batteryId}-text-fade`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="20%" stopColor="currentColor" />
          <stop offset="42%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="58%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="80%" stopColor="currentColor" />
        </linearGradient>
        <mask
          id={`${batteryId}-text-space`}
          x="-34" y="-52" width="68" height="104"
          maskUnits="userSpaceOnUse"
          style={{ maskType: 'alpha' }}
        >
          <rect x="-34" y="-52" width="68" height="104" fill={`url(#${batteryId}-text-fade)`} />
        </mask>
      </defs>
      {batteryCenters.map((x, cellIndex) => (
        <g
          key={x}
          transform={`translate(${x} 64)`}
          style={{ '--_model-star-cell-phase': (cellIndex - 3) / 3 } as StarStyle}
        >
          <rect
            className="openbitfun-model-mode__battery-shell"
            x="-34" y="-52" width="68" height="104" rx="14"
            fill={`url(#${batteryId}-glass)`}
            filter={`url(#${batteryId}-soften)`}
          />
          <g
            clipPath={`url(#${batteryId}-bounds)`}
            mask={cellIndex === 1 ? `url(#${batteryId}-text-space)` : undefined}
          >
            <rect
              className="openbitfun-model-mode__battery-energy"
              x="-34" y="-52" width="68" height="104" rx="14"
              fill={`url(#${batteryId}-energy)`}
            />
            <g className="openbitfun-model-mode__battery-particles">
              {batteryStars[cellIndex].map((star, index) => (
                <g
                  key={index}
                  className="openbitfun-model-mode__battery-particle"
                  style={{
                    '--_model-star-opacity': star.opacity,
                    '--_model-star-delay': `${-(index * 0.73 + cellIndex * 1.17)}s`,
                    '--_model-star-duration': `${4.4 + (index % 4) * 0.55}s`,
                    '--_model-star-sway-x': px(Math.sin(index * 1.7 + cellIndex) * 3),
                    '--_model-star-rise-y': px(8 + (index % 4) * 2.5),
                  } as StarStyle}
                >
                  {index % 6 === 0 && (
                    <circle cx={star.x} cy={star.y} r={star.radius * 3.4} fill={`url(#${batteryId}-glow)`} />
                  )}
                  <circle
                    className={index % 6 === 0 ? 'openbitfun-model-mode__battery-spark' : undefined}
                    cx={star.x} cy={star.y} r={star.radius}
                  />
                </g>
              ))}
            </g>
          </g>
          <rect
            className={`openbitfun-model-mode__battery-outline${cellIndex === 2 ? ' openbitfun-model-mode__battery-outline--right' : ''}`}
            x="-34" y="-52" width="68" height="104" rx="14"
            fill="none"
            stroke={`url(#${batteryId}-rim)`}
          />
        </g>
      ))}
    </g>
  );
}

/** Ambient material only; battery silhouettes do not represent live capacity. */
export const ModelModeAnimation: React.FC<ModelModeAnimationProps> = ({ mode }) => (
  <svg
    className="openbitfun-model-mode"
    data-openbitfun-component="model-selector"
    data-openbitfun-part="modeMaterial"
    data-mode={mode}
    viewBox="0 0 280 128"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
  >
    <ModeNebula />
    {mode === 'smart' ? <SmartStarfield /> : <BatteryMaterial />}
  </svg>
);
