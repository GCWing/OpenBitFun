import { useMemo, useState } from 'react';
import { Alert, Disclosure, Empty, FieldGroup, FieldRow, FormSection, Icon, NumberBadge, PageHeader, ScrollArea, SearchField, Stack, StatusPill } from '@openbitfun/ui';
import { Search, Wrench } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import { formatUsageNumber } from './usageReportUtils';
import { isRecord, parseToolDefinitionsDocument, schemaType } from './toolDefinitionsDocument';
import './ToolDefinitionsPreview.scss';

const headerTones = ['violet', 'green', 'amber', 'magenta', 'blue', 'rose'] as const;
const constraintLabels: Record<string, string> = {
  enum: 'usage.toolDefinitions.enum',
  default: 'usage.toolDefinitions.default',
  const: 'usage.toolDefinitions.constraints.const',
  minimum: 'usage.toolDefinitions.constraints.minimum',
  maximum: 'usage.toolDefinitions.constraints.maximum',
  exclusiveMinimum: 'usage.toolDefinitions.constraints.exclusiveMinimum',
  exclusiveMaximum: 'usage.toolDefinitions.constraints.exclusiveMaximum',
  minLength: 'usage.toolDefinitions.constraints.minLength',
  maxLength: 'usage.toolDefinitions.constraints.maxLength',
  minItems: 'usage.toolDefinitions.constraints.minItems',
  maxItems: 'usage.toolDefinitions.constraints.maxItems',
  pattern: 'usage.toolDefinitions.constraints.pattern',
  format: 'usage.toolDefinitions.constraints.format',
  additionalProperties: 'usage.toolDefinitions.constraints.additionalProperties',
  $ref: 'usage.toolDefinitions.constraints.reference',
};

/** Preserve less common schema constraints as readable values, never an opaque JSON block. */
function DefinitionValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.length) return <Stack direction="horizontal" gap="1" wrap>{value.map((item, index) => <DefinitionValue key={index} value={item} />)}</Stack>;
  if (isRecord(value) && Object.keys(value).length) return <FieldGroup appearance="plain">{Object.entries(value).map(([key, item]) => (
    <FieldRow key={key} align="start" padding="none" className="tool-definitions-preview__nested" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="nested"><Stack direction="horizontal" align="start" gap="2" wrap><code className="tool-definitions-preview__name" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="name">{key}</code><DefinitionValue value={item} /></Stack></FieldRow>
  ))}</FieldGroup>;
  const text = typeof value === 'string' ? JSON.stringify(value) : Array.isArray(value) ? '[]' : isRecord(value) ? '{}' : String(value);
  return <StatusPill tone="neutral" shape="rounded" className="tool-definitions-preview__value-chip">
    <code className="tool-definitions-preview__value" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="value">{text}</code>
  </StatusPill>;
}

function SchemaConstraints({ entries }: { entries: [string, unknown][] }) {
  const { t } = useI18n('flow-chat');
  if (!entries.length) return null;
  return <dl className="tool-definitions-preview__constraints" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="constraints">
    {entries.map(([key, value]) => <div key={key} className="tool-definitions-preview__constraint" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="constraint">
      <dt>{Object.prototype.hasOwnProperty.call(constraintLabels, key) ? t(constraintLabels[key]) : key}</dt>
      <dd><DefinitionValue value={value} /></dd>
    </div>)}
  </dl>;
}

function Parameter({ name, schema, required }: { name: string; schema: unknown; required?: boolean }) {
  const { t } = useI18n('flow-chat');
  const type = schemaType(schema);
  return <Stack gap="2">
    <Stack direction="horizontal" align="center" justify="between" gap="2" wrap>
      <Stack direction="horizontal" align="center" gap="2" wrap>
        <code className="tool-definitions-preview__name" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="name">{name}</code>
        {type && <code className="tool-definitions-preview__type" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="type">{type}</code>}
      </Stack>
      {required === true && <StatusPill tone="accent" shape="rounded">{t('usage.toolDefinitions.required')}</StatusPill>}
      {required === false && <span className="tool-definitions-preview__optional" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="optional">{t('usage.toolDefinitions.optional')}</span>}
    </Stack>
    <SchemaDetails schema={schema} />
  </Stack>;
}

function SchemaDetails({ schema }: { schema: unknown }) {
  const { t } = useI18n('flow-chat');
  if (typeof schema === 'boolean') return <p className="tool-definitions-preview__text" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="help">
    {t(schema ? 'usage.toolDefinitions.anyValue' : 'usage.toolDefinitions.noValue')}
  </p>;
  if (!isRecord(schema)) return <DefinitionValue value={schema} />;
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const extra = Object.entries(schema).filter(([key]) => !['type', 'description', 'properties', 'items', 'prefixItems', 'oneOf', 'anyOf', 'allOf', '$defs', 'definitions'].includes(key)
    && (key !== 'required' || required.some(name => !properties.some(([property]) => property === name))));
  return <Stack gap="2">
    {typeof schema.description === 'string' && schema.description && <MarkdownRenderer className="tool-definitions-preview__description" content={schema.description} />}
    {properties.length > 0 && <FieldGroup appearance="plain">{properties.map(([name, value]) => (
      <FieldRow key={name} align="start" padding="none" className="tool-definitions-preview__nested" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="nested"><Parameter name={name} schema={value} required={required.includes(name)} /></FieldRow>
    ))}</FieldGroup>}
    {schema.items !== undefined && <Disclosure summary={t('usage.toolDefinitions.items')} triggerClassName="tool-definitions-preview__nested-trigger" contentInnerClassName="tool-definitions-preview__content" unmountOnClose>
      <Parameter name="[]" schema={schema.items} />
    </Disclosure>}
    {(['prefixItems', 'oneOf', 'anyOf', 'allOf'] as const).map(key => Array.isArray(schema[key]) && (
      <Disclosure key={key} summary={t(`usage.toolDefinitions.${key}`)} triggerClassName="tool-definitions-preview__nested-trigger" contentInnerClassName="tool-definitions-preview__content" unmountOnClose>
        <FieldGroup appearance="plain">{schema[key].map((variant, index) => (
          <FieldRow key={index} align="start" padding="none" className="tool-definitions-preview__nested" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="nested"><Parameter name={formatUsageNumber(index + 1, t)} schema={variant} /></FieldRow>
        ))}</FieldGroup>
      </Disclosure>
    ))}
    {(['$defs', 'definitions'] as const).map(key => isRecord(schema[key]) && (
      <Disclosure key={key} summary={t('usage.toolDefinitions.definitions')} triggerClassName="tool-definitions-preview__nested-trigger" contentInnerClassName="tool-definitions-preview__content" unmountOnClose>
        <FieldGroup appearance="plain">{Object.entries(schema[key]).map(([name, value]) => (
          <FieldRow key={name} align="start" padding="none" className="tool-definitions-preview__nested" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="nested"><Parameter name={name} schema={value} /></FieldRow>
        ))}</FieldGroup>
      </Disclosure>
    ))}
    <SchemaConstraints entries={extra} />
  </Stack>;
}

export function ToolDefinitionsPreview({ content }: { content: string }) {
  const { t } = useI18n('flow-chat');
  const [query, setQuery] = useState('');
  const document = useMemo(() => parseToolDefinitionsDocument(content), [content]);
  const normalizedQuery = query.trim().toLowerCase();
  const tools = document.tools.map((tool, index) => ({ tool, index })).filter(({ tool }) => !normalizedQuery
    || `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`.toLowerCase().includes(normalizedQuery));
  return <div className="tool-definitions-preview" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="root">
    <PageHeader level={2} title={t('usage.context.categories.toolDefinitions')}
      action={<StatusPill tone="neutral">{formatUsageNumber(document.tools.length, t)}</StatusPill>} />
    {document.tools.length > 0 && <SearchField aria-label={t('usage.toolDefinitions.search')}
      placeholder={t('usage.toolDefinitions.search')} leadingIcon={<Icon glyph={Search} size="sm" />}
      value={query} onValueChange={setQuery} clearLabel={t('usage.toolDefinitions.clearSearch')} onClear={() => setQuery('')} />}
    <ScrollArea className="tool-definitions-preview__viewport" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="viewport">
    {document.invalid && <Alert tone="warning" message={t('usage.toolDefinitions.unavailable')} />}
    {!tools.length && !document.invalid && <Empty icon={<Icon glyph={Wrench} />}
      title={t(normalizedQuery ? 'usage.toolDefinitions.noMatches' : 'usage.toolDefinitions.empty')} />}
    <Stack gap="3">{tools.map(({ tool, index }, visibleIndex) => (
        <Disclosure key={`${tool.name}-${index}`} summary={tool.name} defaultOpen={visibleIndex === 0}
          headerClassName={`tool-definitions-preview__header tool-definitions-preview__header--${headerTones[index % headerTones.length]}`}
          contentInnerClassName="tool-definitions-preview__content tool-definitions-preview__content--tool" unmountOnClose>
          <Stack gap="4">
            {tool.description && <MarkdownRenderer content={tool.description} />}
            <FormSection title={t('usage.toolDefinitions.parameters')} headingAs="h3"
              actions={isRecord(tool.parameters) && isRecord(tool.parameters.properties)
                ? <NumberBadge value={formatUsageNumber(Object.keys(tool.parameters.properties).length, t)} />
                : schemaType(tool.parameters) && <code className="tool-definitions-preview__type" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="type">{schemaType(tool.parameters)}</code>}>
              {isRecord(tool.parameters) && (!tool.parameters.type || tool.parameters.type === 'object')
                && Object.entries(tool.parameters).every(([key, value]) => key === 'type'
                  || (key === 'additionalProperties' && typeof value === 'boolean')
                  || (key === 'properties' && isRecord(value) && !Object.keys(value).length)
                  || (key === 'required' && Array.isArray(value) && !value.length))
                ? <p className="tool-definitions-preview__text" data-openbitfun-product-component="tool-definitions-preview" data-openbitfun-product-part="help">{t(tool.parameters.additionalProperties === false ? 'usage.toolDefinitions.noParameters' : 'usage.toolDefinitions.anyParameters')}</p>
                : <SchemaDetails schema={tool.parameters} />}
            </FormSection>
          </Stack>
        </Disclosure>
    ))}</Stack>
    {document.notes && <Disclosure summary={t('usage.toolDefinitions.notes')}
      headerClassName="tool-definitions-preview__header tool-definitions-preview__header--blue"
      contentInnerClassName="tool-definitions-preview__content tool-definitions-preview__content--tool" unmountOnClose>
      <MarkdownRenderer content={document.notes} />
    </Disclosure>}
    </ScrollArea>
  </div>;
}
