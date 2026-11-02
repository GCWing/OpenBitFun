import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import type { SceneTabId } from '../SceneBar/types';
import { SceneChromeContext, type SceneChromeContextValue } from './sceneChromeContext';

interface SceneChromeContributionRecord {
  owner: symbol;
  content: ReactNode;
}

const SceneChromeContentContext = createContext(new Map<SceneTabId, SceneChromeContributionRecord>());

interface SceneChromeProviderProps {
  activeSceneId: SceneTabId | null;
  children: ReactNode;
}

export const SceneChromeProvider: React.FC<SceneChromeProviderProps> = ({
  activeSceneId,
  children,
}) => {
  const [contributions, setContributions] = useState(
    () => new Map<SceneTabId, SceneChromeContributionRecord>(),
  );
  const setContribution = useCallback((
    sceneId: SceneTabId,
    owner: symbol,
    content: ReactNode,
  ) => {
    setContributions(current => {
      const existing = current.get(sceneId);
      if (existing?.owner === owner && existing.content === content) {
        return current;
      }

      const next = new Map(current);
      next.set(sceneId, { owner, content });
      return next;
    });
  }, []);
  const removeContribution = useCallback((sceneId: SceneTabId, owner: symbol) => {
    setContributions(current => {
      if (current.get(sceneId)?.owner !== owner) {
        return current;
      }

      const next = new Map(current);
      next.delete(sceneId);
      return next;
    });
  }, []);
  const registrationValue = useMemo<SceneChromeContextValue>(() => ({
    activeSceneId,
    setContribution,
    removeContribution,
  }), [activeSceneId, removeContribution, setContribution]);

  return (
    <SceneChromeContext.Provider value={registrationValue}>
      <SceneChromeContentContext.Provider value={contributions}>
        {children}
      </SceneChromeContentContext.Provider>
    </SceneChromeContext.Provider>
  );
};

type SceneChromeHostProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & { sceneId?: SceneTabId | null };

export const SceneChromeHost: React.FC<SceneChromeHostProps> = ({ sceneId, ...props }) => {
  const entries = useContext(SceneChromeContentContext);
  const focused = useContext(SceneChromeContext)?.activeSceneId;
  const id = sceneId === undefined ? focused : sceneId;
  const activeContent = id ? entries.get(id)?.content : null;
  return <div {...props}>{activeContent}</div>;
};

interface SceneChromeContributionProps {
  sceneId: SceneTabId;
  children: ReactNode;
}

export const SceneChromeContribution: React.FC<SceneChromeContributionProps> = ({
  sceneId,
  children,
}) => {
  const sceneChrome = useContext(SceneChromeContext);
  const ownerRef = useRef(Symbol('scene-chrome-contribution'));
  const setContribution = sceneChrome?.setContribution;
  const removeContribution = sceneChrome?.removeContribution;

  useLayoutEffect(() => {
    setContribution?.(sceneId, ownerRef.current, children);
  }, [children, sceneId, setContribution]);

  useLayoutEffect(() => () => {
    removeContribution?.(sceneId, ownerRef.current);
  }, [removeContribution, sceneId]);

  return null;
};
