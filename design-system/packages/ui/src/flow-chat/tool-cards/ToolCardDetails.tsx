import type { HTMLAttributes, ReactNode } from "react";
import { Disclosure, type DisclosureProps } from "../../components/Disclosure";
import { Icon } from "../../components/Icon";
import { ScrollArea } from "../../components/ScrollArea";
import { classNames } from "../../internal/classNames";
import { ToolCardActions, ToolCardSubject } from "./FlowChatToolCard";
import styles from "./ToolCardDetails.module.css";

export interface ToolCardSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  label?: ReactNode;
  actions?: ReactNode;
}

/** A subordinate section. The card shell owns the outer inset. */
export function ToolCardSection({ label, actions, children, className, ...props }: ToolCardSectionProps) {
  return (
    <section data-openbitfun-part="section" {...props} className={classNames(styles.section, className)} data-tool-card-action-scope>
      {(label || actions) && (
        <div className={styles.heading} data-tool-card-action-heading>
          {label && <div className={styles.label} data-openbitfun-part="sectionLabel">{label}</div>}
          {actions && <ToolCardActions className={styles.actions} revealOnHover>{actions}</ToolCardActions>}
        </div>
      )}
      {children}
    </section>
  );
}

export type ToolCardDisclosureProps = Omit<
  Extract<DisclosureProps, { presentation?: "custom" }>,
  "presentation" | "renderHeader" | "leading"
>;

/** Supporting details share the section edges; Disclosure owns state and accessibility. */
export function ToolCardDisclosure({
  actions, summary, description, children, className, contentInnerClassName, ...props
}: ToolCardDisclosureProps) {
  return (
    <Disclosure
      {...props}
      className={classNames(styles.disclosure, className)}
      contentInnerClassName={classNames(styles.disclosureContent, contentInnerClassName)}
      summary={summary}
      renderHeader={(triggerProps) => (
        <div className={styles.heading} data-openbitfun-part="header" data-tool-card-action-scope>
          <button {...triggerProps} className={styles.disclosureTrigger}>
            <span className={styles.disclosureIndicator} aria-hidden="true" data-openbitfun-part="indicator" data-openbitfun-icon-slot="true">
              <Icon name="chevron-right" size="sm" />
            </span>
            <span className={styles.disclosureHeading} data-openbitfun-part="heading">
              <span className={styles.label} data-openbitfun-part="summary">{summary}</span>
              {description !== undefined && description !== null && (
                <span className={styles.description} data-openbitfun-part="description">{description}</span>
              )}
            </span>
          </button>
          {actions !== undefined && actions !== null && (
            <ToolCardActions className={styles.actions} revealOnHover>{actions}</ToolCardActions>
          )}
        </div>
      )}
    >
      {children}
    </Disclosure>
  );
}

export interface ToolCardField {
  label: ReactNode;
  value: ReactNode;
  actions?: ReactNode;
}

export interface ToolCardFieldsProps extends HTMLAttributes<HTMLDListElement> {
  fields: readonly ToolCardField[];
}

/** Read-only metadata, with a shared value column and width-based stacking. */
export function ToolCardFields({ fields, className, ...props }: ToolCardFieldsProps) {
  return (
    <dl {...props} className={classNames(styles.fields, className)}>
      {fields.map((field, index) => (
        <div className={styles.field} data-openbitfun-part="field" key={index}>
          <dt className={styles.fieldLabel}>{field.label}</dt>
          <dd className={styles.fieldValue} data-tool-card-action-scope>
            {field.actions ? <ToolCardSubject actions={field.actions}>{field.value}</ToolCardSubject> : field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ToolCardTextProps extends HTMLAttributes<HTMLPreElement> {
  variant?: "code" | "prose";
}

/** Bounded textual evidence; scrolling hands off to the conversation at its edges. */
export function ToolCardText({ children, className, variant = "code", ...props }: ToolCardTextProps) {
  return (
    <ScrollArea className={styles.viewport} edgeFade="vertical" overscrollBehaviorY="auto">
      <pre {...props} className={classNames(styles.text, className)} data-variant={variant}>{children}</pre>
    </ScrollArea>
  );
}
