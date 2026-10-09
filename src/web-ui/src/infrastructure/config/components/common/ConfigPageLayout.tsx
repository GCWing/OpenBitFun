import {
  FieldGroup,
  FormSection,
  ScrollArea,
  type FieldGroupFieldSurface,
  type FormSectionProps,
} from '@openbitfun/ui';
import React from 'react';
import { formatStandaloneUiCopy } from './standaloneUiCopy';
import './ConfigPageLayout.scss';

export interface ConfigPageLayoutProps extends React.HTMLAttributes<HTMLDivElement> {
   
  children: React.ReactNode;
   
  className?: string;
}

 
export const ConfigPageLayout: React.FC<ConfigPageLayoutProps> = ({
  children,
  className = '',
  ...props
}) => {
  return (
    <ScrollArea className={`openbitfun-config-page-layout ${className}`} data-openbitfun-component="config" data-openbitfun-part="root" {...props}>
      {children}
      {/* Real DOM spacer: keeps a guaranteed blank tail at the end of the scroll range. */}
      <div className="openbitfun-config-page-layout__scroll-end-spacer" aria-hidden="true" />
    </ScrollArea>
  );
};

export interface ConfigPageContentProps extends React.HTMLAttributes<HTMLDivElement> {
   
  children: React.ReactNode;
   
  className?: string;
  id?: string;
}

 
export const ConfigPageContent: React.FC<ConfigPageContentProps> = ({
  children,
  className = '',
  id,
  ...props
}) => {
  return (
    <div id={id} className={`openbitfun-config-page-content ${className}`} data-openbitfun-component="config" data-openbitfun-part="content" {...props}>
      <div className="openbitfun-config-page-content__inner" data-openbitfun-component="config" data-openbitfun-part="contentInner">
        {children}
      </div>
    </div>
  );
};

export interface ConfigPageSectionStackProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/**
 * Keeps the standard page-level spacing when sections need a shared wrapper
 * for state, test hooks, or adjacent page controls.
 */
export const ConfigPageSectionStack: React.FC<ConfigPageSectionStackProps> = ({
  children,
  className = '',
  ...props
}) => {
  return (
    <div
      {...props}
      className={`openbitfun-config-page-section-stack ${className}`.trim()}
      data-openbitfun-component="config"
      data-openbitfun-part="sectionStack"
    >
      {children}
    </div>
  );
};

export interface ConfigPageSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: string;
  /** Renders inline after the title (e.g. status badge). */
  titleSuffix?: React.ReactNode;
  description?: React.ReactNode;
  descriptionLayout?: FormSectionProps['descriptionLayout'];
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Disable when children own the surface and the standard body background/radius should be removed. */
  bodySurface?: boolean;
  /** Controls whether nested design-system fields are opaque or reuse the section surface. */
  fieldSurface?: FieldGroupFieldSurface;
}

export const ConfigPageSection: React.FC<ConfigPageSectionProps> = ({
  title,
  titleSuffix,
  description,
  descriptionLayout = 'stacked',
  extra,
  children,
  className = '',
  bodySurface = true,
  fieldSurface,
  ...props
}) => {
  const hasBody = children !== null && children !== undefined && children !== false;
  const bodyClassName = [
    'openbitfun-config-page-section__body',
    !bodySurface && 'openbitfun-config-page-section__body--flush',
  ].filter(Boolean).join(' ');
  const descriptionClassName = [
    'openbitfun-config-page-section__description',
    descriptionLayout === 'inline' && 'openbitfun-config-page-section__description--inline',
  ].filter(Boolean).join(' ');

  return (
    <FormSection
      className={`openbitfun-config-page-section ${className}`}
      data-openbitfun-component="config"
      data-openbitfun-part="section"
      headingAs="h3"
      descriptionLayout={descriptionLayout}
      title={(
        <span className="openbitfun-config-page-section__title-row" data-openbitfun-component="config" data-openbitfun-part="sectionHeader">
          <span className="openbitfun-config-page-section__title" data-openbitfun-component="config" data-openbitfun-part="sectionTitle">{title}</span>
          {titleSuffix}
        </span>
      )}
      description={description ? (
        <span className={descriptionClassName} data-openbitfun-component="config" data-openbitfun-part="sectionDescription">
          {formatStandaloneUiCopy(description)}
        </span>
      ) : undefined}
      actions={extra ? (
        <div className="openbitfun-config-page-section__extra">{extra}</div>
      ) : undefined}
      {...props}
    >
      {hasBody ? (
        <FieldGroup
          appearance={bodySurface ? 'subtle' : 'plain'}
          className={bodyClassName}
          data-openbitfun-component="config"
          data-openbitfun-part="sectionBody"
          dividers={false}
          fieldSurface={fieldSurface ?? (bodySurface ? 'ambient' : 'default')}
        >
          {children}
        </FieldGroup>
      ) : null}
    </FormSection>
  );
};

export interface ConfigPageRowProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  /** Marks the row label as required. The control still owns its native required or aria-required state. */
  required?: boolean;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  align?: 'start' | 'center';
  /** Stack label above control for multi-line editors (textarea, code blocks, etc.) */
  multiline?: boolean;
  /** Gives long-form or complex controls a 2/8 fill layout instead of the standard field width. */
  wide?: boolean;
  /**
   * ~40% label / ~60% control — middle ground between default (7:3) and wide (2:8).
   * Use for composite controls; ordinary single-line fields retain the shared field width.
   */
  balanced?: boolean;
}

export const ConfigPageRow: React.FC<ConfigPageRowProps> = ({
  label,
  required = false,
  description,
  children,
  className = '',
  align = 'start',
  multiline = false,
  wide = false,
  balanced = false,
  ...props
}) => {
  const hasControl = children !== null && children !== undefined && children !== false;
  const cls = [
    'openbitfun-config-page-row',
    `openbitfun-config-page-row--${align}`,
    multiline && 'openbitfun-config-page-row--multiline',
    wide && 'openbitfun-config-page-row--wide',
    balanced && 'openbitfun-config-page-row--balanced',
    !hasControl && 'openbitfun-config-page-row--no-control',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={cls}
      data-openbitfun-component="config"
      data-openbitfun-part="row"
      data-openbitfun-align={align}
      data-openbitfun-layout={wide ? 'wide' : balanced ? 'balanced' : multiline ? 'multiline' : 'default'}
      data-required={required ? 'true' : 'false'}
      {...props}
    >
      <div className="openbitfun-config-page-row__meta">
        {/* div (not p): label may contain buttons; button-in-p freezes React event path */}
        <div className="openbitfun-config-page-row__label" data-openbitfun-component="config" data-openbitfun-part="rowLabel">
          {label}
          {required ? (
            <span
              aria-hidden="true"
              className="openbitfun-config-page-row__required"
              data-openbitfun-component="config"
              data-openbitfun-part="required"
            >
              *
            </span>
          ) : null}
        </div>
        {description ? (
          <div className="openbitfun-config-page-row__description" data-openbitfun-component="config" data-openbitfun-part="rowDescription">{formatStandaloneUiCopy(description)}</div>
        ) : null}
      </div>
      {hasControl ? (
        <div className="openbitfun-config-page-row__control" data-openbitfun-component="config" data-openbitfun-part="rowControl">
          {children}
        </div>
      ) : null}
    </div>
  );
};

export default ConfigPageLayout;
