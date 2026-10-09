import {
  createElement,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import { FieldSurfaceContext, type FieldSurface } from "../../internal/fieldSurface";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./FieldGroup.module.css";

export type FieldGroupAppearance = "plain" | "subtle";
export type FieldGroupFieldSurface = FieldSurface;
export type FieldRowAlignment = "center" | "start";
export type FieldRowPadding = "none" | "md";
export type FormSectionHeading = "h2" | "h3" | "h4";

export interface FormSectionProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  actions?: ReactNode;
  description?: ReactNode;
  /** Keep compact section summaries beside the title instead of below it. */
  descriptionLayout?: "stacked" | "inline";
  headingAs?: FormSectionHeading;
  leading?: ReactNode;
  title?: ReactNode;
}

export interface FieldGroupProps extends HTMLAttributes<HTMLDivElement> {
  appearance?: FieldGroupAppearance;
  dividers?: boolean;
  /** Lets text and picker field shells reuse the surrounding grouped surface. */
  fieldSurface?: FieldGroupFieldSurface;
}

export interface FieldRowProps extends HTMLAttributes<HTMLDivElement> {
  align?: FieldRowAlignment;
  padding?: FieldRowPadding;
}

export const FormSection = forwardRef<HTMLElement, FormSectionProps>(
  function FormSection({
    actions,
    children,
    className,
    description,
    descriptionLayout = "stacked",
    headingAs = "h2",
    leading,
    title,
    ...props
  }, ref) {
    return (
      <section
        {...props}
        className={classNames(styles.section, className)}
        data-openbitfun-component="form-section"
        data-description-layout={descriptionLayout}
        ref={ref}
      >
        {(title !== undefined && title !== null)
          || (description !== undefined && description !== null)
          || (leading !== undefined && leading !== null)
          || (actions !== undefined && actions !== null) ? (
            <div className={styles.header} data-openbitfun-part="header">
              {(title !== undefined && title !== null)
                || (description !== undefined && description !== null)
                || (leading !== undefined && leading !== null) ? (
                  <div className={styles.headingRegion} data-openbitfun-part="heading-region">
                    {leading !== undefined && leading !== null && (
                      <div className={styles.leading} data-openbitfun-part="leading">{leading}</div>
                    )}
                    {(title !== undefined && title !== null)
                      || (description !== undefined && description !== null) ? (
                        <div className={styles.headingContent} data-openbitfun-part="heading-content">
                          {title !== undefined && title !== null && createElement(
                            headingAs,
                            { className: styles.title, "data-openbitfun-part": "title" },
                            title,
                          )}
                          {description !== undefined && description !== null && (descriptionLayout === "inline" ? (
                            <OverflowText as="div" className={styles.description} data-openbitfun-part="description">
                              {description}
                            </OverflowText>
                          ) : (
                            <div className={styles.description} data-openbitfun-part="description">
                              {description}
                            </div>
                          ))}
                        </div>
                      ) : null}
                  </div>
                ) : null}
              {actions !== undefined && actions !== null && (
                <div className={styles.actions} data-openbitfun-part="actions">{actions}</div>
              )}
            </div>
          ) : null}
        {children}
      </section>
    );
  },
);

export const FieldGroup = forwardRef<HTMLDivElement, FieldGroupProps>(
  function FieldGroup({
    appearance = "subtle",
    children,
    className,
    dividers = true,
    fieldSurface = "default",
    ...props
  }, ref) {
    return (
      <FieldSurfaceContext.Provider value={fieldSurface}>
        <div
          {...props}
          className={classNames(styles.group, className)}
          data-appearance={appearance}
          data-openbitfun-component="field-group"
          data-dividers={dividers ? "true" : "false"}
          data-field-surface={fieldSurface}
          ref={ref}
        >
          {children}
        </div>
      </FieldSurfaceContext.Provider>
    );
  },
);

export const FieldRow = forwardRef<HTMLDivElement, FieldRowProps>(
  function FieldRow({
    align = "center",
    children,
    className,
    padding = "md",
    ...props
  }, ref) {
    return (
      <div
        {...props}
        className={classNames(styles.row, className)}
        data-align={align}
        data-openbitfun-part="row"
        data-padding={padding}
        ref={ref}
      >
        {children}
      </div>
    );
  },
);
