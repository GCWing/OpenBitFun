import type { HTMLAttributes, ReactNode } from "react";
import { Cpu } from "lucide-react";
import { Icon } from "../../components/Icon/Icon";
import { ScrollArea } from "../../components/ScrollArea";
import { OverflowText } from "../../primitives/OverflowText";
import {
  AmbientToolCard, AmbientToolCardHeader, ProminentToolCard, ProminentToolCardSummary,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolCardDisclosure, ToolCardFields, ToolCardSection, ToolCardText, type ToolCardField } from "./ToolCardDetails";
import { ToolCardStatusSlot } from "./ToolCardStatusSlot";
import styles from "./RuntimeToolCards.module.css";

interface RuntimeToolCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "onClick"> {
  action: ReactNode;
  summary?: ReactNode;
  resultSummary?: ReactNode;
  statusDescription?: string;
  status: FlowChatToolStatus;
  isExpanded?: boolean;
  onToggle?: () => void;
  requiresConfirmation?: boolean;
  error?: ReactNode;
}

export interface ListModelsToolCardModel {
  key: string;
  name: string;
  provider?: string;
  id?: string;
}

export interface ListModelsToolCardProps extends RuntimeToolCardProps {
  models: readonly ListModelsToolCardModel[];
  modelsLabel: ReactNode;
  modelIdLabel: ReactNode;
  query?: string;
  queryLabel?: ReactNode;
  emptyContent?: ReactNode;
  hasResult?: boolean;
  resultText?: string;
}

/** Enabled model identities, supplied by the executing host. No local model lookup. */
export function ListModelsToolCard({
  action, summary, resultSummary, statusDescription, status, isExpanded = false, onToggle, requiresConfirmation,
  error, models, modelsLabel, modelIdLabel, query, queryLabel, emptyContent, resultText, hasResult, ...props
}: ListModelsToolCardProps) {
  const hasDetails = Boolean(query || models.length || emptyContent || resultText || error || hasResult);
  return (
    <AmbientToolCard {...props} data-openbitfun-tool-card="list-models"
      status={status} requiresConfirmation={requiresConfirmation}
      isExpanded={isExpanded && hasDetails} onClick={hasDetails ? onToggle : undefined}
      header={<AmbientToolCardHeader action={action} content={summary} result={resultSummary} statusDescription={statusDescription}
        icon={<ToolCardStatusSlot status={status} toolIcon={<Icon glyph={Cpu} size="sm" />} />} />}
      expandedContent={hasDetails ? (
        <div className={styles.details} data-openbitfun-part="details">
          {error && <ToolCardText className={styles.error} variant="prose" data-openbitfun-part="error">{error}</ToolCardText>}
          {query && <ToolCardFields fields={[{ label: queryLabel, value: query }]} />}
          {(models.length > 0 || emptyContent) && <ToolCardSection label={modelsLabel}>
            {models.length > 0 ? <ScrollArea className={styles.viewport} edgeFade="vertical" overscrollBehaviorY="auto">
              <ul className={styles.list} data-openbitfun-part="modelList">
                {models.map(model => <li className={styles.model} key={model.key} data-openbitfun-part="model" data-overflow-trigger>
                  <div className={styles.identity}>
                    <OverflowText className={styles.name}>{model.name}</OverflowText>
                    {model.provider && <OverflowText className={styles.secondary}>{model.provider}</OverflowText>}
                  </div>
                  {model.id && <div className={styles.modelId}>
                    <span className={styles.secondary}>{modelIdLabel}</span>
                    <OverflowText>{model.id}</OverflowText>
                  </div>}
                </li>)}
              </ul>
            </ScrollArea> : <ToolCardText variant="prose">{emptyContent}</ToolCardText>}
          </ToolCardSection>}
          {resultText && <ToolCardSection label={modelsLabel}><ToolCardText>{resultText}</ToolCardText></ToolCardSection>}
        </div>
      ) : undefined} />
  );
}

export interface ControlHubToolCardRecord {
  key: string;
  title: string;
  description?: string;
  fields?: readonly ToolCardField[];
}

export interface ControlHubToolCardProps extends RuntimeToolCardProps {
  attention: "ambient" | "prominent";
  domain: "browser" | "terminal" | "meta" | "unknown";
  fields?: readonly ToolCardField[];
  records?: readonly ControlHubToolCardRecord[];
  resultLabel: ReactNode;
  resultText?: string;
  resultVariant?: "code" | "prose";
  resultDetailsText?: string;
  resultDetailsLabel?: ReactNode;
  notices?: readonly string[];
  noticesLabel?: ReactNode;
  images?: readonly { src: string; alt: string }[];
  paramsText?: string;
  paramsLabel?: ReactNode;
  onParamsOpenChange?: () => void;
}

/** A shared control card; the adapter classifies the action and supplies recorded evidence. */
export function ControlHubToolCard({
  action, summary, resultSummary, statusDescription, status, isExpanded = false, onToggle, requiresConfirmation, error,
  attention, domain, fields = [], records = [], resultLabel, resultText, resultVariant = "code",
  resultDetailsText, resultDetailsLabel,
  notices = [], noticesLabel, images = [], paramsText, paramsLabel, onParamsOpenChange, ...props
}: ControlHubToolCardProps) {
  const hasDetails = Boolean(fields.length || records.length || resultText || resultDetailsText || notices.length || images.length || paramsText || error);
  const toolIcon = domain === "terminal" ? <Icon name="square-terminal" size="sm" />
    : domain === "meta" ? <Icon name="workflow" size="sm" />
      : domain === "browser" ? <Icon name="browser" size="sm" />
        : <Icon name="mouse-pointer" size="sm" />;
  const icon = <ToolCardStatusSlot status={status} toolIcon={toolIcon} />;
  const details = hasDetails ? <div className={styles.details} data-openbitfun-part="details">
    {error && <ToolCardText variant="prose" className={styles.error} data-openbitfun-part="error">{error}</ToolCardText>}
    {fields.length > 0 && <ToolCardFields fields={fields} />}
    {records.length > 0 && <ToolCardSection label={resultLabel}>
      <ScrollArea className={styles.viewport} edgeFade="vertical" overscrollBehaviorY="auto">
        <ul className={styles.list} data-openbitfun-part="resultList">
          {records.map(record => <li key={record.key} className={styles.record} data-openbitfun-part="result" data-overflow-trigger>
            <OverflowText className={styles.name}>{record.title}</OverflowText>
            {record.description && <span className={styles.description}>{record.description}</span>}
            {record.fields && record.fields.length > 0 && <ToolCardFields fields={record.fields} />}
          </li>)}
        </ul>
      </ScrollArea>
    </ToolCardSection>}
    {resultText && <ToolCardSection label={resultLabel}>
      <ToolCardText variant={resultVariant} data-openbitfun-part="output">{resultText}</ToolCardText>
    </ToolCardSection>}
    {images.map((image, index) => <img className={styles.image} key={index} src={image.src} alt={image.alt} loading="lazy" data-openbitfun-part="image" />)}
    {notices.length > 0 && <ToolCardSection label={noticesLabel}>
      <ToolCardText variant="prose" data-openbitfun-part="notices">{notices.join("\n\n")}</ToolCardText>
    </ToolCardSection>}
    {resultDetailsText && <ToolCardDisclosure summary={resultDetailsLabel} onOpenChange={onParamsOpenChange}>
      <ToolCardText data-openbitfun-part="resultDetails">{resultDetailsText}</ToolCardText>
    </ToolCardDisclosure>}
    {paramsText && <ToolCardDisclosure summary={paramsLabel} onOpenChange={onParamsOpenChange}>
      <ToolCardText data-openbitfun-part="params">{paramsText}</ToolCardText>
    </ToolCardDisclosure>}
  </div> : undefined;
  const common = {
    ...props, "data-openbitfun-tool-card": "control-hub", status, requiresConfirmation,
    isExpanded: isExpanded && hasDetails, expandedContent: details,
  };
  return attention === "ambient"
    ? <AmbientToolCard {...common} onClick={hasDetails ? onToggle : undefined}
        header={<AmbientToolCardHeader action={action} content={summary} result={resultSummary} statusDescription={statusDescription} icon={icon} />} />
    : <ProminentToolCard {...common} allowExpandedWhenFailed onToggle={hasDetails ? onToggle : undefined}
        summary={<ProminentToolCardSummary action={action} content={summary} icon={icon} />} />;
}
