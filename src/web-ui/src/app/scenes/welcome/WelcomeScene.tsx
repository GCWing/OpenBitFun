/**
 * WelcomeScene — the lightweight, tabless landing surface shown by
 * SceneViewport until the user opens a scene.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { isReducedMotionPreferred } from '@/shared/utils/motionPreference';
import { OpenBitFunMark } from '@openbitfun/ui/brand';
import './WelcomeScene.scss';

const TYPE_MS = 100;
const DELETE_MS = 55;
const PHRASE_HOLD_MS = 2200;
const PHRASE_GAP_MS = 450;
const YOUR_WORD_INDEX = 2;

const WelcomeScene: React.FC = () => {
  const { t } = useI18n('common');
  const [text, setText] = useState('');
  const [reducedMotion, setReducedMotion] = useState(isReducedMotionPreferred);
  const impossible = t('welcomeScene.phrases.impossible');
  const dreams = t('welcomeScene.phrases.dreams');
  const your = t('welcomeScene.space.your');
  const suffix = t('welcomeScene.space.suffix');
  const think = t('welcomeScene.phrases.think');
  const ideas = t('welcomeScene.phrases.ideas');
  const create = t('welcomeScene.phrases.create');
  const explore = t('welcomeScene.phrases.explore');
  const phrases = useMemo(
    () => [
      impossible,
      dreams,
      `${your}${suffix}`,
      think,
      ideas,
      create,
      explore,
    ],
    [impossible, dreams, your, suffix, think, ideas, create, explore],
  );

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const handleMotionChange = () => setReducedMotion(isReducedMotionPreferred());
    media?.addEventListener('change', handleMotionChange);
    return () => media?.removeEventListener('change', handleMotionChange);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;

    // Reset on locale changes; keep the full phrase, including punctuation, in the loop.
    const characters = phrases.map(phrase => Array.from(phrase));
    let phraseIndex = 0;
    let characterCount = 0;
    let deleting = false;
    let nextDelay = PHRASE_GAP_MS;
    let timer: number | undefined;
    setText('');

    const schedule = () => {
      if (!document.hidden) timer = window.setTimeout(tick, nextDelay);
    };
    function tick() {
      const phrase = characters[phraseIndex];
      characterCount += deleting ? -1 : 1;
      setText(phrase.slice(0, characterCount).join(''));

      if (!deleting && characterCount === phrase.length) {
        deleting = true;
        nextDelay = PHRASE_HOLD_MS;
      } else if (deleting && characterCount === 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % characters.length;
        nextDelay = PHRASE_GAP_MS;
      } else {
        nextDelay = deleting ? DELETE_MS : TYPE_MS;
      }
      schedule();
    }
    const handleVisibilityChange = () => {
      window.clearTimeout(timer);
      schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [phrases, reducedMotion]);

  return (
    <section
      className="welcome-scene"
      data-testid="welcome-scene"
      data-openbitfun-scene="welcome"
      data-openbitfun-part="root"
      aria-labelledby="welcome-scene-title"
    >
      <div className="welcome-scene__content" data-openbitfun-scene="welcome" data-openbitfun-part="content">
        <div
          className="welcome-scene__greeting"
          data-openbitfun-scene="welcome"
          data-openbitfun-part="greeting"
        >
          <h1
            id="welcome-scene-title"
            className="welcome-scene__brand"
            data-openbitfun-scene="welcome"
            data-openbitfun-part="title"
          >
            <span
              className="welcome-scene__logo"
              data-openbitfun-scene="welcome"
              data-openbitfun-part="logo"
              aria-hidden="true"
            >
              <OpenBitFunMark style={{ width: '100%', height: '100%' }} />
            </span>
            <span className="welcome-scene__brand-name">
              OpenBitFun{t('welcomeScene.space.separator')}
            </span>
          </h1>
          <h2
            className="welcome-scene__tagline"
            data-openbitfun-scene="welcome"
            data-openbitfun-part="subtitle"
            aria-label={phrases[YOUR_WORD_INDEX]}
          >
            <span className="welcome-scene__phrase-slot" aria-hidden="true">
              {/* Reserve the longest phrase so the brand never shifts while typing. */}
              {phrases.map((phrase, index) => (
                <span className="welcome-scene__phrase-sizer" key={index}>
                  {phrase}
                </span>
              ))}
              <span className="welcome-scene__typed-phrase">
                {reducedMotion ? phrases[YOUR_WORD_INDEX] : text}
                <span className="welcome-scene__cursor" />
              </span>
            </span>
          </h2>
        </div>
      </div>
    </section>
  );
};

export default WelcomeScene;
