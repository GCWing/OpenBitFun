import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../components/Icon/Icon";
import {
  AmbientToolCard,
  AmbientToolCardHeader,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolCardStatusSlot } from "./ToolCardStatusSlot";
import { ScrollArea } from "../../components/ScrollArea";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./SearchResultsToolCards.module.css";

export interface SearchToolCardDetail {
  label: ReactNode;
  value: ReactNode;
}

export interface SearchToolCardResult {
  description?: ReactNode;
  icon?: "directory" | "file" | "link";
  key: string;
  meta?: ReactNode;
  onOpen?: () => void;
  title: ReactNode;
  url?: string;
}

export interface GrepSearchResultLine {
  gapBefore?: boolean;
  kind: "match" | "context";
  lineNumber: number;
  text: string;
}

export type GrepSearchResultBlock =
  | { kind: "file"; path: string; lines: readonly GrepSearchResultLine[] }
  | { kind: "text"; text: string };

interface SearchResultsToolCardBaseProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick" | "results"> {
  action?: ReactNode;
  details?: readonly SearchToolCardDetail[];
  icon: ReactNode;
  isExpanded?: boolean;
  moreResultsLabel?: ReactNode;
  onToggle?: () => void;
  resultContent?: ReactNode;
  resultText?: string;
  results?: readonly SearchToolCardResult[];
  status: FlowChatToolStatus;
  statusDescription?: string;
  resultSummary?: ReactNode;
  summary: ReactNode;
  toolCard: string;
}

function ResultIcon({ kind }: { kind?: SearchToolCardResult["icon"] }) {
  if (kind === "directory") return <Icon name="folder" size="sm" />;
  if (kind === "link") return <Icon name="link" size="sm" />;
  return <Icon name="file-text" size="sm" />;
}

function SearchResultsToolCardBase({
  action,
  details = [],
  icon,
  isExpanded = false,
  moreResultsLabel,
  onToggle,
  resultContent,
  resultText,
  results = [],
  status,
  statusDescription,
  resultSummary,
  summary,
  toolCard,
  ...props
}: SearchResultsToolCardBaseProps) {
  const inlineResults = toolCard === "glob-search";
  const hasDetails = details.length > 0 || results.length > 0 || Boolean(resultContent || resultText);
  const expandedContent = hasDetails ? (
    <div className={styles.searchDetails} data-openbitfun-part="searchDetails">
      {details.length > 0 && (
        <div className={styles.details} data-openbitfun-part="details">
          {details.map((detail, index) => (
            <span
              className={styles.detail}
              data-openbitfun-part="detail"
              key={index}
            >
              <span className={styles.detailLabel}>{detail.label}</span>
              <span className={styles.detailValue}>{detail.value}</span>
            </span>
          ))}
        </div>
      )}

      <ScrollArea className={styles.resultViewport} edgeFade="vertical" overscrollBehaviorY="auto">
      {resultContent ?? (resultText && (
        <pre className={styles.resultText} data-variant={toolCard === "web-search" ? "prose" : "code"} data-openbitfun-part="resultText">{resultText}</pre>
      ))}

      {results.length > 0 && (
        <div className={styles.results} data-openbitfun-part="results">
          {results.map((result) => (
            <div className={styles.result} data-openbitfun-part="result" key={result.key}>
              <span className={styles.resultIcon} data-openbitfun-icon-slot="true"><ResultIcon kind={result.icon} /></span>
              <span className={styles.resultBody}>
                {result.onOpen ? (
                  <button
                    className={styles.resultButton}
                    data-overflow-trigger={inlineResults || undefined}
                    onClick={result.onOpen}
                    title={result.url}
                    type="button"
                  >
                    {inlineResults ? <OverflowText>{result.title}</OverflowText> : result.title}
                  </button>
                ) : inlineResults ? (
                  <OverflowText className={styles.resultTitle}>{result.title}</OverflowText>
                ) : (
                  <span className={styles.resultTitle}>{result.title}</span>
                )}
                {result.description && (inlineResults ? (
                  <OverflowText className={styles.resultDescription}>{result.description}</OverflowText>
                ) : (
                  <span className={styles.resultDescription}>{result.description}</span>
                ))}
                {result.url && <span className={styles.resultUrl}>{result.url}</span>}
              </span>
              {result.meta && <span className={styles.resultMeta}>{result.meta}</span>}
            </div>
          ))}
          {moreResultsLabel && (
            <div className={styles.overflowLabel} data-openbitfun-part="overflowLabel">
              {moreResultsLabel}
            </div>
          )}
        </div>
      )}
      </ScrollArea>
    </div>
  ) : undefined;

  return (
    <AmbientToolCard
      {...props}
      data-openbitfun-tool-card={toolCard}
      expandedContent={expandedContent}
      header={(
        <AmbientToolCardHeader
          action={action}
          content={summary}
          result={resultSummary}
          statusDescription={statusDescription}
          icon={(
            <ToolCardStatusSlot
              status={status}
              toolIcon={icon}
            />
          )}
        />
      )}
      isExpanded={Boolean(isExpanded && hasDetails)}
      onClick={hasDetails && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export type SearchResultsToolCardProps = Omit<
  SearchResultsToolCardBaseProps,
  "icon" | "toolCard" | "resultContent"
>;

export interface GrepSearchToolCardProps extends SearchResultsToolCardProps {
  /** Structured content takes precedence over the legacy resultText preview. */
  resultBlocks?: readonly GrepSearchResultBlock[];
}

function GrepSearchResults({ blocks }: { blocks: readonly GrepSearchResultBlock[] }) {
  // One track for the whole result, including files whose line numbers grow wider.
  const lineNumberDigits = blocks.reduce((width, block) => block.kind === "file"
    ? block.lines.reduce((digits, line) => Math.max(digits, String(line.lineNumber).length), width)
    : width, 3);
  return (
    <div
      className={styles.grepResults}
      data-openbitfun-part="grepResults"
      style={{ "--_grep-line-number-width": `${lineNumberDigits}ch` } as CSSProperties}
    >
      {blocks.map((block, blockIndex) => {
        if (block.kind === "text") {
          return <pre className={styles.resultText} data-openbitfun-part="resultText" key={blockIndex}>{block.text}</pre>;
        }

        const filenameStart = Math.max(block.path.lastIndexOf("/"), block.path.lastIndexOf("\\")) + 1;
        return (
          <figure className={styles.grepFile} data-openbitfun-part="grepFile" key={blockIndex}>
            <figcaption className={styles.grepFilePath} data-openbitfun-part="grepFilePath">
              <span className={styles.grepDirectory}>{block.path.slice(0, filenameStart)}</span>
              <span className={styles.grepFilename}>{block.path.slice(filenameStart)}</span>
            </figcaption>
            <div className={`${styles.resultText} ${styles.grepLines}`}>
              {block.lines.map((line, lineIndex) => {
                const previousLine = block.lines[lineIndex - 1];
                const gapBefore = line.gapBefore || (previousLine && line.lineNumber > previousLine.lineNumber + 1);
                return (
                  <div
                    className={styles.grepLine}
                    data-openbitfun-part="grepLine"
                    data-kind={line.kind}
                    data-gap-before={gapBefore || undefined}
                    key={lineIndex}
                  >
                    <span className={styles.grepLineNumber} data-openbitfun-part="grepLineNumber">{line.lineNumber}</span>
                    <pre className={styles.grepLineContent} data-openbitfun-part="grepLineContent">{line.text}</pre>
                  </div>
                );
              })}
            </div>
          </figure>
        );
      })}
    </div>
  );
}

export function GrepSearchToolCard({ resultBlocks, ...props }: GrepSearchToolCardProps) {
  return (
    <SearchResultsToolCardBase
      {...props}
      icon={<Icon name="text-search" size="sm" />}
      resultContent={resultBlocks?.length ? <GrepSearchResults blocks={resultBlocks} /> : undefined}
      toolCard="grep-search"
    />
  );
}

export function GlobSearchToolCard(props: SearchResultsToolCardProps) {
  return <SearchResultsToolCardBase {...props} icon={<Icon name="file-search-corner" size="sm" />} toolCard="glob-search" />;
}

export function DirectoryListToolCard(props: SearchResultsToolCardProps) {
  return <SearchResultsToolCardBase {...props} icon={<Icon name="folder-open" size="sm" />} toolCard="directory-list" />;
}

export function WebSearchToolCard(props: SearchResultsToolCardProps) {
  return <SearchResultsToolCardBase {...props} icon={<Icon name="browser" size="sm" />} toolCard="web-search" />;
}
