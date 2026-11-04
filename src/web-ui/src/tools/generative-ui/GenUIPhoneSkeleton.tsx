import type { GenUIAppEnvelope } from './genUITypes';
import { genUICatalog } from './genUIContract';
import { harmonyPresentation } from './harmonyPresentation';
import GenUIHostSurface from './GenUIHostSurface';
import { HARMONY_STYLE_RESOURCE_CSS } from './components/vendor/harmonyStyles';
import './GenUIPhoneSkeleton.scss';

/** Match the host phone frame exactly while showing the loading content. */
export default function GenUIPhoneSkeleton({ app, label }: { app?: GenUIAppEnvelope; label: string }) {
  const style = app ? harmonyPresentation(app) : undefined;
  return <div className="gen-ui-phone-loading" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="root" data-openbitfun-state="loading" role="status" aria-label={label} aria-busy="true">
    <style data-gen-ui-harmony-style dangerouslySetInnerHTML={{ __html: HARMONY_STYLE_RESOURCE_CSS }} />
    <div className="gen-ui-phone-loading__preview">
    <div className="gen-ui-phone-loading__device">
    <GenUIHostSurface specification={genUICatalog.designSpecs?.['harmony.phone.v1']} harmony harmonyTheme={style?.theme} harmonyFont={style?.font} harmonyScheme={style?.scheme}>
      <div className="gen-ui-phone-skeleton" aria-hidden="true">
        <div className="gen-ui-phone-skeleton__header" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="header">
          <div className="gen-ui-phone-skeleton__heading"><span className="gen-ui-phone-skeleton__line gen-ui-phone-skeleton__line--title" /><span className="gen-ui-phone-skeleton__line" /></div>
          <span className="gen-ui-phone-skeleton__avatar" />
        </div>
        <div className="gen-ui-phone-skeleton__hero" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="hero">
          <span className="gen-ui-phone-skeleton__ring" />
          <span className="gen-ui-phone-skeleton__line" />
          <span className="gen-ui-phone-skeleton__pill" />
        </div>
        <div className="gen-ui-phone-skeleton__tiles" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="tiles">
          {[0, 1].map(key => <div className="gen-ui-phone-skeleton__tile" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="tile" key={key}><span className="gen-ui-phone-skeleton__icon" /><span className="gen-ui-phone-skeleton__line" /><span className="gen-ui-phone-skeleton__line gen-ui-phone-skeleton__line--title" /></div>)}
        </div>
        <div className="gen-ui-phone-skeleton__list" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="list">
          {[0, 1, 2].map(key => <div className="gen-ui-phone-skeleton__row" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="row" key={key}><span className="gen-ui-phone-skeleton__icon" /><div className="gen-ui-phone-skeleton__heading"><span className="gen-ui-phone-skeleton__line gen-ui-phone-skeleton__line--title" /><span className="gen-ui-phone-skeleton__line" /></div></div>)}
        </div>
        <div className="gen-ui-phone-skeleton__navigation" data-openbitfun-component="gen-ui-phone-skeleton" data-openbitfun-part="navigation">{[0, 1, 2, 3].map(key => <span className="gen-ui-phone-skeleton__icon" key={key} />)}</div>
      </div>
    </GenUIHostSurface>
    </div>
    </div>
  </div>;
}
