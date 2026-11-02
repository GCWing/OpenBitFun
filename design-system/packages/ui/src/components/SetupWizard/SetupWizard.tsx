import { forwardRef, useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import { PageHeader } from "../PageHeader";
import { ScrollArea } from "../ScrollArea";
import styles from "./SetupWizard.module.css";

export interface SetupWizardStep {
  /** Stable identity; changing it resets the content viewport's scroll position. */
  id: string;
  label: ReactNode;
  /** Explain the effect of this choice instead of repeating the form labels. */
  title: ReactNode;
  description: ReactNode;
  /** Localized progress, for example "2 / 3". */
  progress: ReactNode;
}

export interface SetupWizardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  /** Use the same id on the containing Dialog's aria-labelledby. */
  titleId?: string;
  headerActions?: ReactNode;
  guideLabel: string;
  step: SetupWizardStep;
  footer: ReactNode;
  /** Contained delegates scrolling to an editor or another bounded child. */
  contentMode?: "scroll" | "contained";
}

/** Controlled setup layout. The consumer owns drafts, navigation and validation. */
export const SetupWizard = forwardRef<HTMLDivElement, SetupWizardProps>(function SetupWizard({
  children,
  className,
  contentMode = "scroll",
  footer,
  guideLabel,
  headerActions,
  step,
  title,
  titleId,
  ...props
}, ref) {
  const generatedTitleId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [step.id]);

  return (
    <div {...props} className={classNames(styles.root, className)} data-openbitfun-component="setup-wizard" data-openbitfun-part="root" data-content-mode={contentMode} ref={ref}>
      <div className={styles.layout} data-openbitfun-component="setup-wizard" data-openbitfun-part="layout">
        <header className={styles.header} data-openbitfun-component="setup-wizard" data-openbitfun-part="header">
          <div className={styles.heading} data-openbitfun-component="setup-wizard" data-openbitfun-part="heading">
            <h2 className={styles.title} id={titleId ?? generatedTitleId} data-openbitfun-component="setup-wizard" data-openbitfun-part="title"><OverflowText>{title}</OverflowText></h2>
          </div>
          <div className={styles.headerActions} data-openbitfun-component="setup-wizard" data-openbitfun-part="headerActions">{headerActions}</div>
        </header>
        <aside className={styles.guide} aria-label={guideLabel} data-openbitfun-component="setup-wizard" data-openbitfun-part="guide">
          <div className={styles.guideContent} aria-live="polite" aria-atomic="true">
            <div className={styles.guideCopy} data-openbitfun-component="setup-wizard" data-openbitfun-part="guideCopy">
              <PageHeader title={step.title} description={step.description} level={3} />
            </div>
            <div className={styles.progress} data-openbitfun-component="setup-wizard" data-openbitfun-part="progress">
              <span>{step.progress}</span>
              <span className={styles.step} aria-current="step" data-openbitfun-component="setup-wizard" data-openbitfun-part="step">{step.label}</span>
            </div>
          </div>
        </aside>
        <ScrollArea className={styles.content} ref={viewportRef} data-openbitfun-component="setup-wizard" data-openbitfun-part="content">
          <div className={styles.contentInner} data-openbitfun-component="setup-wizard" data-openbitfun-part="contentInner">{children}</div>
        </ScrollArea>
        <footer className={styles.footer} data-openbitfun-component="setup-wizard" data-openbitfun-part="footer">{footer}</footer>
      </div>
    </div>
  );
});
