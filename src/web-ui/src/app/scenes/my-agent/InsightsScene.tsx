/* eslint-disable @typescript-eslint/no-use-before-define */
import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { OverflowText, Button, Combobox, Icon, IconButton, ScrollArea, type ComboboxOption, type IconSource } from '@openbitfun/ui';
import { Loader2, AlertTriangle, BarChart3, Calendar, Target, Zap, Trophy, AlertCircle, Lightbulb, Rocket, Database, ScanSearch, Layers3, FileCheck2, Gauge } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { insightsApi, type InsightsReport, type InsightsReportMeta, type InsightsStats } from '@/infrastructure/api/insightsApi';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getProviderDisplayName } from '@/infrastructure/config/services/modelConfigs';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { useInsightsStore } from './insightsStore';
import { createLogger } from '@/shared/utils/logger';
import { getMotionAwareScrollBehavior } from '@/shared/utils/motionPreference';
import { notificationService } from '@/shared/notification-system';
import { APPEARANCE_DOMAIN_TOKENS } from '@/infrastructure/appearance/appearanceDomainTokens';
import { formatTokenCount } from '@/shared/utils/tokenUsageFormatting';
import '@/app/components/GalleryLayout/GalleryLayout.scss';
import './InsightsScene.scss';

const log = createLogger('InsightsScene');

// Report section ids for TOC / scroll targets
const SECTIONS = [
  { id: 'overview', labelKey: 'overview', icon: { glyph: Target } },
  { id: 'stats', labelKey: 'stats', icon: { glyph: BarChart3 } },
  { id: 'work-on', labelKey: 'workOn', icon: { glyph: Target } },
  { id: 'usage', labelKey: 'usage', icon: { glyph: Zap } },
  { id: 'wins', labelKey: 'wins', icon: { glyph: Trophy } },
  { id: 'friction', labelKey: 'friction', icon: { glyph: AlertCircle } },
  { id: 'suggestions', labelKey: 'suggestions', icon: { glyph: Lightbulb } },
  { id: 'horizon', labelKey: 'horizon', icon: { glyph: Rocket } },
] as const satisfies ReadonlyArray<{ id: string; labelKey: string; icon: IconSource }>;

const DAY_OPTIONS = [7, 14, 30, 90] as const;

const GENERATION_STEPS = [
  {
    id: 'collect',
    titleKey: 'insights.generationStageCollect',
    detailKey: 'insights.generationStageCollectDetail',
    icon: { glyph: Database },
    stages: ['starting', 'data_collection'],
  },
  {
    id: 'sessions',
    titleKey: 'insights.generationStageSessions',
    detailKey: 'insights.generationStageSessionsDetail',
    icon: { glyph: ScanSearch },
    stages: ['facet_extraction', 'facet_retry'],
  },
  {
    id: 'patterns',
    titleKey: 'insights.generationStagePatterns',
    detailKey: 'insights.generationStagePatternsDetail',
    icon: { glyph: Layers3 },
    stages: ['aggregation', 'analysis', 'analysis_retry'],
  },
  {
    id: 'summary',
    titleKey: 'insights.generationStageSummary',
    detailKey: 'insights.generationStageSummaryDetail',
    icon: { name: 'spark' },
    stages: ['synthesis'],
  },
  {
    id: 'save',
    titleKey: 'insights.generationStageSave',
    detailKey: 'insights.generationStageSaveDetail',
    icon: { glyph: FileCheck2 },
    stages: ['assembly', 'complete'],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  titleKey: string;
  detailKey: string;
  icon: IconSource;
  stages: readonly string[];
}>;

interface GenerationProgress {
  stage: string;
  message: string;
  current: number;
  total: number;
  isRetrying: boolean;
}

const GenerationPanel: React.FC<{ progress: GenerationProgress }> = ({ progress }) => {
  const { t } = useI18n('common');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeIndex = Math.max(
    0,
    GENERATION_STEPS.findIndex((step) => step.stages.some((stage) => stage === progress.stage)),
  );
  const activeStep = GENERATION_STEPS[activeIndex];
  const itemProgress = progress.total > 0
    ? Math.min(1, Math.max(0, progress.current / progress.total))
    : 0;
  const overallProgress = progress.stage === 'complete'
    ? 100
    : Math.min(96, ((activeIndex + Math.max(itemProgress, 0.18)) / GENERATION_STEPS.length) * 100);
  const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
  const detail = progress.current > 0 && progress.total > 0
    ? t('insights.generationItemsProgress', { current: progress.current, total: progress.total })
    : progress.isRetrying
      ? t('insights.generationRetrying')
      : t(activeStep.detailKey);

  return (
    <section className="insights-generation" aria-live="polite">
      <div className="insights-generation__status">
        <div className="insights-generation__status-icon">
          <Loader2 size={18} className="insights-scene__spinner" />
        </div>
        <div className="insights-generation__status-copy">
          <div className="insights-generation__eyebrow">{t('insights.generating')}</div>
          <div className="insights-generation__title">{t(activeStep.titleKey)}</div>
          <div className="insights-generation__detail"><OverflowText>{detail}</OverflowText></div>
        </div>
        <div className="insights-generation__elapsed">
          <Icon name="clock" size="xs" />
          <span>{t('insights.generationElapsed')}</span>
          <strong>{elapsed}</strong>
        </div>
      </div>

      <div className="insights-generation__bar" aria-hidden="true">
        <span style={{ width: `${overallProgress}%` }} />
      </div>

      <div className="insights-generation__steps">
        {GENERATION_STEPS.map((step, index) => {
          const state = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending';
          return (
            <div key={step.id} className={`insights-generation__step insights-generation__step--${state}`}>
              <span className="insights-generation__step-icon">
                {state === 'complete' ? <Icon name="check-line" size="xs" /> : <Icon {...step.icon} size="xs" />}
              </span>
              <OverflowText className="insights-generation__step-label">{t(step.titleKey)}</OverflowText>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const InsightsScene: React.FC = () => {
  const { t } = useI18n('common');
  const [availableModels, setAvailableModels] = useState<AIModelConfig[]>([]);
  const {
    view, reportMetas, currentReport, generating, progress,
    selectedDays, selectedModel, error, loadingMetas,
    setSelectedDays, setSelectedModel, fetchReportMetas, loadReport, generateReport, cancelGeneration, backToList, clearError,
  } = useInsightsStore();

  useEffect(() => {
    fetchReportMetas();
  }, [fetchReportMetas]);

  useEffect(() => {
    let active = true;
    void configManager.getConfig<AIModelConfig[]>('ai.models').then((models) => {
      if (!active) return;
      const enabledChatModels = (models || []).filter((model) => (
        model.enabled && model.id && model.capabilities?.includes('text_chat')
      ));
      setAvailableModels(enabledChatModels);
      const currentSelection = useInsightsStore.getState().selectedModel;
      if (
        currentSelection !== 'primary'
        && !enabledChatModels.some((model) => model.id === currentSelection)
      ) {
        setSelectedModel('primary');
      }
    }).catch((error) => {
      log.warn('Failed to load models for insights', error);
    });
    return () => {
      active = false;
    };
  }, [setSelectedModel]);

  const modelOptions = useMemo<ComboboxOption[]>(() => [
    {
      value: 'primary',
      label: t('insights.modelPrimary'),
      description: t('insights.modelPrimaryDescription'),
    },
    ...availableModels.map((model) => ({
      value: model.id || '',
      label: model.model_name,
      description: `${model.name} · ${getProviderDisplayName(model)}`,
    })),
  ], [availableModels, t]);

  if (view === 'report' && currentReport) {
    return <ReportView report={currentReport} onBack={backToList} />;
  }

  return (
    <div className="insights-scene" data-openbitfun-scene="insights" data-openbitfun-part="root" data-openbitfun-view="list">
      <div className="insights-scene__header" data-openbitfun-scene="insights" data-openbitfun-part="header">
        <div className="insights-scene__header-identity">
          <h2 className="insights-scene__header-title">{t('insights.title')}</h2>
          <p className="insights-scene__header-subtitle">{t('insights.subtitle')}</p>
        </div>
        <div className="insights-scene__header-actions">
          <div className="insights-scene__model-control">
            <span className="insights-scene__control-label">{t('insights.modelLabel')}</span>
            <Combobox
              className="insights-scene__model-select"
              value={selectedModel}
              options={modelOptions}
              onValueChange={(value) => setSelectedModel(String(value))}
              size="lg"
              disabled={generating}
              data-testid="insights-model-select"
            />
          </div>
          <div className="insights-scene__day-filters">
            <div className="insights-scene__day-filter-group">
              <span className="insights-scene__control-label">
                {t('insights.rangeLabel')}
              </span>
              {DAY_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={[
                    'gallery-cat-chip',
                    selectedDays === d ? 'gallery-cat-chip--active' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => setSelectedDays(d)}
                  disabled={generating}
                >
                  <span>{d} {t('insights.days')}</span>
                </button>
              ))}
            </div>
          </div>
          {generating ? (
            <Button
              variant="fill"
              size="sm"
              leadingIcon={<Icon name="xmark" size="lg" />}
              onClick={cancelGeneration}
            >
              {t('insights.cancelBtn')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<BarChart3 />}
              onClick={generateReport}
            >
              {t('insights.generateBtn')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="insights-scene__error" data-openbitfun-scene="insights" data-openbitfun-part="error">
          <Icon glyph={AlertTriangle} size="sm" />
          <span>{error}</span>
          <IconButton
            size="sm"
            onClick={clearError}
            aria-label={t('insights.dismissError')}
            icon={<Icon name="xmark" size="sm" />}
          />
        </div>
      )}

      {generating && <GenerationPanel progress={progress} />}

      <ScrollArea className="insights-scene__history" data-openbitfun-scene="insights" data-openbitfun-part="content">
        <div className="insights-scene__history-inner">
          <div className="insights-scene__history-header">
            <div className="insights-scene__history-label">
              {t('insights.history')}
              {reportMetas.length > 0 && (
                <span className="insights-scene__history-count">{reportMetas.length}</span>
              )}
            </div>
            <span className="insights-scene__history-hint">{t('insights.keepLatest5')}</span>
          </div>
          {loadingMetas ? (
            <div className="insights-scene__loading" data-openbitfun-scene="insights" data-openbitfun-part="loading">
              <Loader2 size={16} className="insights-scene__spinner" />
            </div>
          ) : reportMetas.length === 0 ? (
            <div className="insights-scene__empty" data-openbitfun-reading-surface="before" data-openbitfun-scene="insights" data-openbitfun-part="empty">{t('insights.noReports')}</div>
          ) : (
            <div className="insights-scene__report-list">
              {reportMetas.map((meta) => (
                <ReportMetaCard key={meta.generated_at} meta={meta} onSelect={loadReport} />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

const ReportMetaCard: React.FC<{
  meta: InsightsReportMeta;
  onSelect: (meta: InsightsReportMeta) => void;
}> = ({ meta, onSelect }) => {
  const { t, formatDate, formatNumber } = useI18n('common');
  const date = new Date(meta.generated_at * 1000);
  const dateStr = formatDate(date, { year: 'numeric', month: 'short', day: 'numeric' });
  const timeStr = formatDate(date, { hour: '2-digit', minute: '2-digit' });
  const rangeStart = meta.date_range.start.slice(0, 10);
  const rangeEnd = meta.date_range.end.slice(0, 10);
  const formatGoal = (g: string) => g.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const sessionUsage = meta.session_usage;
  const hasSessionUsage = sessionUsage.turns_with_usage > 0;
  const sessionUsageComplete = sessionUsage.total_turns > 0
    && sessionUsage.turns_with_usage === sessionUsage.total_turns;
  const sessionUsagePartial = sessionUsage.total_turns > 0 && !sessionUsageComplete;
  const generationUsage = meta.generation_usage;
  const hasGenerationCalls = generationUsage.model_calls > 0;
  const hasGenerationUsage = generationUsage.reported_model_calls > 0;
  const generationUsageComplete = hasGenerationCalls
    && generationUsage.reported_model_calls === generationUsage.model_calls;
  const generationModels = meta.generation_models || [];
  const sessionTokenTitle = hasSessionUsage
    ? [
        `${t('insights.inputTokens')}: ${formatTokenCount(sessionUsage.input_tokens, formatNumber)}`,
        `${t('insights.outputTokens')}: ${formatTokenCount(sessionUsage.output_tokens, formatNumber)}`,
        `${t('insights.tokenCoverage')}: ${sessionUsage.turns_with_usage}/${sessionUsage.total_turns}`,
      ].join('\n')
    : t('insights.sessionTokensUnavailable');
  const generationTokenTitle = hasGenerationUsage
    ? [
        `${t('insights.inputTokens')}: ${formatTokenCount(generationUsage.input_tokens, formatNumber)}`,
        `${t('insights.outputTokens')}: ${formatTokenCount(generationUsage.output_tokens, formatNumber)}`,
        `${t('insights.cachedTokens')}: ${formatTokenCount(generationUsage.cached_input_tokens, formatNumber)}`,
      ].join('\n')
    : t('insights.tokensUnavailable');

  return (
    <button data-overflow-trigger className="insights-meta-card" onClick={() => onSelect(meta)}>
      <div className="insights-meta-card__top">
        <div className="insights-meta-card__date">{dateStr} {timeStr}</div>
        <div className="insights-meta-card__range">{rangeStart} ~ {rangeEnd}</div>
      </div>
      <div className="insights-meta-card__metrics">
        <span
          className={`insights-meta-card__metric insights-meta-card__metric--session-tokens${sessionUsagePartial ? ' insights-meta-card__metric--partial' : ''}`}
          title={sessionTokenTitle}
        >
          <Icon glyph={Gauge} size="sm" />
          <span>
            <strong><OverflowText>
              {hasSessionUsage
                ? formatTokenCount(sessionUsage.total_tokens, formatNumber)
                : '--'}
            </OverflowText></strong>
            {t('insights.sessionTokens')}
          </span>
        </span>
        <span className="insights-meta-card__metric">
          <Icon glyph={BarChart3} size="sm" />
          <span>
            <strong><OverflowText>{formatNumber(meta.analyzed_sessions)} / {formatNumber(meta.total_sessions)}</OverflowText></strong>
            {t('insights.analyzedSessions')}
          </span>
        </span>
        <span className="insights-meta-card__metric">
          <Icon name="side-chat" size="sm" />
          <span><strong><OverflowText>{formatNumber(meta.total_messages)}</OverflowText></strong>{t('insights.messages')}</span>
        </span>
      </div>
      <div className="insights-meta-card__details">
        <span>
          <Icon name="clock" size="2xs" /> {meta.total_hours.toFixed(1)} {t('insights.hours')}
        </span>
        <span>
          <Icon glyph={Calendar} size="2xs" /> {formatNumber(meta.days_covered)} {t('insights.days')}
        </span>
      </div>
      {(meta.top_goals?.length > 0 || meta.languages?.length > 0) && (
        <div className="insights-meta-card__tags">
          {meta.top_goals?.map((g) => (
            <span key={g} className="insights-meta-card__tag">{formatGoal(g)}</span>
          ))}
          {meta.languages?.map((l) => (
            <span key={l} className="insights-meta-card__tag insights-meta-card__tag--lang">{l}</span>
          ))}
        </div>
      )}
      {(generationModels.length > 0 || hasGenerationCalls) && (
        <div className="insights-meta-card__generation-meta">
          {generationModels.length > 0 && (
            <span title={generationModels.join(', ')}>
              <Icon name="thinking" size="lg" style={{ width: 10, height: 10 }} />
              <OverflowText title="">{generationModels.join(' + ')}</OverflowText>
            </span>
          )}
          {hasGenerationCalls && (
            <span
              title={generationTokenTitle}
              className={generationUsageComplete ? '' : 'insights-meta-card__generation-meta--partial'}
            >
              <Icon name="spark" size="2xs" />
              <OverflowText title="">
              {t('insights.insightsGenerationTokens')}:
              {' '}{hasGenerationUsage
                ? formatTokenCount(generationUsage.total_tokens, formatNumber)
                : '--'} {t('insights.tokens')}
              {!generationUsageComplete && ` · ${t('insights.partialUsage')}`}
              </OverflowText>
            </span>
          )}
        </div>
      )}
    </button>
  );
};

// ============ Report View ============

// Report view: right-hand TOC / section nav
const ReportNav: React.FC<{ report: InsightsReport; scrollContainerRef: React.RefObject<HTMLDivElement> }> = ({ report, scrollContainerRef }) => {
  const { t } = useI18n('common');
  const [activeSection, setActiveSection] = useState<string>('overview');

  // Sections shown in the nav (skip empty blocks)
  const visibleSections = [
    { id: 'overview', label: t('insights.atAGlance'), hasContent: true },
    { id: 'stats', label: t('insights.stats'), hasContent: true },
    { id: 'work-on', label: t('insights.projectAreas'), hasContent: report.project_areas.length > 0 },
    { id: 'usage', label: t('insights.interactionStyle'), hasContent: report.interaction_style.narrative || true },
    { id: 'wins', label: t('insights.bigWins'), hasContent: Boolean(report.wins_intro) || report.big_wins.length > 0 },
    { id: 'friction', label: t('insights.friction'), hasContent: Boolean(report.friction_intro) || report.friction_categories.length > 0 },
    { id: 'suggestions', label: t('insights.suggestions'), hasContent: true },
    { id: 'horizon', label: t('insights.horizon'), hasContent: report.on_the_horizon.length > 0 },
  ].filter(s => s.hasContent);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const detectActiveSection = () => {
      const scrollTop = container.scrollTop;
      const containerTop = container.getBoundingClientRect().top;
      const sections = container.querySelectorAll('[data-section]');
      let current = 'overview';

      sections.forEach((section) => {
        const el = section as HTMLElement;
        const elTop = el.getBoundingClientRect().top - containerTop;
        // Active section: heading within 80px of the scroll container top
        if (scrollTop > 0 ? elTop < 80 : elTop <= 0) {
          current = el.dataset.section || 'overview';
        }
      });

      // setState with the same string is a no-op re-render-wise.
      setActiveSection(current);
    };

    // rAF-merge scroll events: the detection reads one rect per section.
    let frameId: number | null = null;
    const handleScroll = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        detectActiveSection();
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    detectActiveSection();
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [scrollContainerRef]);

  const scrollToSection = (id: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const element = container.querySelector(`[data-section="${id}"]`) as HTMLElement | null;
    if (!element) return;
    const containerTop = container.getBoundingClientRect().top;
    const elTop = element.getBoundingClientRect().top - containerTop;
    container.scrollBy({
      top: elTop - 16,
      behavior: getMotionAwareScrollBehavior('smooth'),
    });
  };

  return (
    <nav className="insights-report-nav">
      {visibleSections.map((section) => {
        const sectionIcon = SECTIONS.find(s => s.id === section.id)?.icon ?? { glyph: Target };
        return (
          <button data-overflow-trigger
            key={section.id}
            className={`insights-report-nav__item ${activeSection === section.id ? 'is-active' : ''}`}
            onClick={() => scrollToSection(section.id)}
            title={section.label}
          >
            <Icon {...sectionIcon} size="sm" />
            <OverflowText className="insights-report-nav__label">{section.label}</OverflowText>
          </button>
        );
      })}
    </nav>
  );
};

const ReportView: React.FC<{ report: InsightsReport; onBack: () => void }> = ({ report, onBack }) => {
  const { t } = useI18n('common');
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleOpenHtml = useCallback(async () => {
    if (report.html_report_path) {
      try {
        await insightsApi.openReport(report.html_report_path);
      } catch (error) {
        log.error('Failed to open HTML report', error);
        notificationService.error(
          String(error),
          { title: t('insights.openHtmlFailed'), duration: 5000 }
        );
      }
    }
  }, [report.html_report_path, t]);

  const dateStart = report.date_range.start.slice(0, 10);
  const dateEnd = report.date_range.end.slice(0, 10);

  return (
    <div className="insights-scene insights-scene--report" data-openbitfun-scene="insights" data-openbitfun-part="root" data-openbitfun-view="report">
      <div className="insights-report-header" data-openbitfun-scene="insights" data-openbitfun-part="header">
        <Button
          variant="outline"
          size="sm"
          leadingIcon={<Icon name="arrow-left" size="lg" />}
          onClick={onBack}
        >
          {t('insights.backToList')}
        </Button>
        <div className="insights-report-header__meta">
          <span><Icon name="side-chat" size="2xs" /> {report.total_messages} {t('insights.messages')}</span>
          <span><Icon glyph={BarChart3} size="2xs" /> {report.total_sessions} {t('insights.sessions')}</span>
          <span><Icon glyph={Calendar} size="2xs" /> {dateStart} ~ {dateEnd}</span>
        </div>
        <div className="insights-report-header__actions">
          <Button
            variant="outline"
            size="sm"
            leadingIcon={<Icon name="arrow-up-right" size="lg" />}
            onClick={handleOpenHtml}
            disabled={!report.html_report_path}
          >
            {t('insights.openHtml')}
          </Button>
        </div>
      </div>

      <ScrollArea className="insights-report-content" ref={bodyRef} data-openbitfun-scene="insights" data-openbitfun-part="content">
        <div className="insights-report-body">
          <div className="insights-report-body-inner">
            <header className="insights-report-hero">
              <h1 className="insights-report-hero__title">
                {t('insights.reportTitle', { dateStart, dateEnd })}
              </h1>
            </header>
            <div data-section="overview">
              <AtAGlanceSection report={report} />
            </div>
            <div data-section="stats">
              <StatsRow report={report} />
            </div>

            {/* What You Work On */}
            {report.project_areas.length > 0 && (
              <section className="insights-section" data-section="work-on">
                <h3>{t('insights.projectAreas')}</h3>
                <div className="insights-areas">
                  {report.project_areas.map((area) => (
                    <div key={area.name} className="insights-area-card">
                      <div className="insights-area-card__header">
                        <span className="insights-area-card__name">{area.name}</span>
                        <span className="insights-area-card__count">~{area.session_count} {t('insights.sessions')}</span>
                      </div>
                      <p className="insights-area-card__desc"><MarkdownInline text={area.description} /></p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          <BasicCharts stats={report.stats} />

          {/* How You Use OpenBitFun */}
          {report.interaction_style.narrative && <div data-section="usage"><InteractionStyleSection report={report} /></div>}
          <div data-section="usage">
            <UsageCharts stats={report.stats} />
          </div>

          {/* Impressive Things You Did */}
          {(report.wins_intro || report.big_wins.length > 0) && (
            <section className="insights-section" data-section="wins">
              <h3>{t('insights.bigWins')}</h3>
              {report.wins_intro && <p className="insights-section-intro" data-openbitfun-reading-surface="before"><MarkdownInline text={report.wins_intro} /></p>}
              <div className="insights-wins">
                {report.big_wins.map((win) => (
                  <div key={win.title} className="insights-win-card">
                    <div className="insights-win-card__title">{win.title}</div>
                    <p className="insights-win-card__desc"><MarkdownInline text={win.description} /></p>
                    {win.impact && <p className="insights-win-card__impact"><MarkdownInline text={win.impact} /></p>}
                  </div>
                ))}
              </div>
            </section>
          )}
          <OutcomeCharts stats={report.stats} />

          {/* Where Things Go Wrong */}
          {(report.friction_intro || report.friction_categories.length > 0) && (
            <section className="insights-section" data-section="friction">
              <h3>{t('insights.friction')}</h3>
              {report.friction_intro && <p className="insights-section-intro" data-openbitfun-reading-surface="before"><MarkdownInline text={report.friction_intro} /></p>}
              <div className="insights-friction">
                {report.friction_categories.map((f) => (
                  <div key={f.category} className="insights-friction-card">
                    <div className="insights-friction-card__title">{f.category}</div>
                    <p className="insights-friction-card__desc"><MarkdownInline text={f.description} /></p>
                    {f.examples.length > 0 && (
                      <ul className="insights-friction-card__examples">
                        {f.examples.map((ex, j) => <li key={j}><MarkdownInline text={ex} /></li>)}
                      </ul>
                    )}
                    {f.suggestion && <div className="insights-friction-card__suggestion"><MarkdownInline text={f.suggestion} /></div>}
                  </div>
                ))}
              </div>
            </section>
          )}
          <FrictionCharts stats={report.stats} />

          <div data-section="suggestions">
            <SuggestionsSection report={report} />
          </div>

          {report.on_the_horizon.length > 0 && (
            <section className="insights-section" data-section="horizon">
              <h3>{t('insights.horizon')}</h3>
              {report.horizon_intro && (
                <p className="insights-section-intro" data-openbitfun-reading-surface="before"><MarkdownInline text={report.horizon_intro} /></p>
              )}
              <div className="insights-horizon">
                {report.on_the_horizon.map((h, i) => (
                  <div key={h.title} className="insights-horizon-card">
                    <span className="insights-horizon-card__index">{i + 1}</span>
                    <div className="insights-horizon-card__body">
                      <div className="insights-horizon-card__title">{h.title}</div>
                      <p className="insights-horizon-card__desc"><MarkdownInline text={h.whats_possible} /></p>
                      {h.how_to_try && (
                        <div className="insights-horizon-card__how">
                          <span className="insights-horizon-card__how-label">{t('insights.howToTry')}</span>
                          <span><MarkdownInline text={h.how_to_try} /></span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {report.fun_ending && (
            <div className="insights-fun-ending">
              <div className="insights-fun-ending__blob" />
              <div className="insights-fun-ending__blob-2" />
              <div className="insights-fun-ending__bg">
                <div className="insights-fun-ending__headline">{report.fun_ending.headline}</div>
                <p className="insights-fun-ending__message"><MarkdownInline text={report.fun_ending.detail} /></p>
              </div>
            </div>
          )}
          </div>
        </div>

        <ReportNav report={report} scrollContainerRef={bodyRef as React.RefObject<HTMLDivElement>} />
      </ScrollArea>
    </div>
  );
};

// ============ Sub-components ============

const AtAGlanceSection: React.FC<{ report: InsightsReport }> = ({ report }) => {
  const { at_a_glance } = report;
  const { t } = useI18n('common');

  return (
    <div className="insights-glance">
      <div className="insights-glance__title">{t('insights.atAGlance')}</div>
      <div className="insights-glance__sections">
        <div className="insights-glance__item">
          <strong>{t('insights.whatsWorking')}:</strong> <MarkdownInline text={at_a_glance.whats_working} />
        </div>
        <div className="insights-glance__item">
          <strong>{t('insights.whatsHindering')}:</strong> <MarkdownInline text={at_a_glance.whats_hindering} />
        </div>
        <div className="insights-glance__item">
          <strong>{t('insights.quickWins')}:</strong> <MarkdownInline text={at_a_glance.quick_wins} />
        </div>
        <div className="insights-glance__item">
          <strong>{t('insights.lookingAhead')}:</strong> <MarkdownInline text={at_a_glance.looking_ahead} />
        </div>
      </div>
    </div>
  );
};

const InteractionStyleSection: React.FC<{ report: InsightsReport }> = ({ report }) => {
  const { interaction_style } = report;
  const { t } = useI18n('common');

  return (
    <section className="insights-section">
      <h3>{t('insights.interactionStyle')}</h3>
      <div className="insights-interaction" data-openbitfun-reading-surface="before">
        <p className="insights-interaction__narrative"><MarkdownInline text={interaction_style.narrative} /></p>
        {interaction_style.key_patterns.length > 0 && (
          <div className="insights-interaction__patterns">
            {interaction_style.key_patterns.map((pattern, i) => (
              <div key={i} className="insights-interaction__pattern"><MarkdownInline text={pattern} /></div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

const RESPONSE_TIME_ORDER = ['2-10s', '10-30s', '30s-1m', '1-2m', '2-5m', '5-15m', '>15m'];

const TIME_OF_DAY_PERIODS: { labelKey: string; hours: number[] }[] = [
  { labelKey: 'timeMorning', hours: [6, 7, 8, 9, 10, 11] },
  { labelKey: 'timeAfternoon', hours: [12, 13, 14, 15, 16, 17] },
  { labelKey: 'timeEvening', hours: [18, 19, 20, 21, 22, 23] },
  { labelKey: 'timeNight', hours: [0, 1, 2, 3, 4, 5] },
];

const formatDurationShort = (secs: number): string => {
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${(secs / 60).toFixed(1)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
};

const StatsRow: React.FC<{ report: InsightsReport }> = ({ report }) => {
  const { t, formatNumber } = useI18n('common');
  const { stats } = report;
  const hasCodeChanges = (stats.total_lines_added ?? 0) > 0 || (stats.total_lines_removed ?? 0) > 0;

  const items: Array<{ key: string; value: string; label: string }> = [
    { key: 'messages', value: report.total_messages.toString(), label: t('insights.messages') },
    { key: 'sessions', value: report.total_sessions.toString(), label: t('insights.sessions') },
    { key: 'hours', value: `${stats.total_hours.toFixed(1)}h`, label: t('insights.hours') },
    { key: 'days', value: report.days_covered.toString(), label: t('insights.days') },
    { key: 'msgsPerDay', value: stats.msgs_per_day.toFixed(1), label: t('insights.msgsPerDay') },
  ];
  if (hasCodeChanges) {
    items.push({
      key: 'lines',
      value: `+${formatNumber(stats.total_lines_added)}/-${formatNumber(stats.total_lines_removed)}`,
      label: t('insights.lines'),
    });
  }
  if ((stats.total_files_modified ?? 0) > 0) {
    items.push({
      key: 'files',
      value: formatNumber(stats.total_files_modified),
      label: t('insights.files'),
    });
  }
  if (stats.median_response_time_secs != null) {
    items.push({
      key: 'medianRt',
      value: formatDurationShort(stats.median_response_time_secs),
      label: t('insights.medianResponseTime'),
    });
  }
  if (stats.avg_response_time_secs != null) {
    items.push({
      key: 'avgRt',
      value: formatDurationShort(stats.avg_response_time_secs),
      label: t('insights.avgResponseTime'),
    });
  }

  const mid = Math.ceil(items.length / 2);
  const row1 = items.slice(0, mid);
  const row2 = items.slice(mid);

  return (
    <div className="insights-stats">
      <div className="insights-stats__row">
        {row1.map((it) => (
          <StatItem key={it.key} value={it.value} label={it.label} />
        ))}
      </div>
      {row2.length > 0 && (
        <div className="insights-stats__row">
          {row2.map((it) => (
            <StatItem key={it.key} value={it.value} label={it.label} />
          ))}
        </div>
      )}
    </div>
  );
};

const ChartsRow: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const visible = React.Children.toArray(children).filter(Boolean);
  if (visible.length === 0) return null;
  const isSingle = visible.length === 1;
  return (
    <div className={`insights-charts-row${isSingle ? ' insights-charts-row--full' : ''}`}>
      {visible}
    </div>
  );
};

const BasicCharts: React.FC<{ stats: InsightsStats }> = ({ stats }) => {
  const { t } = useI18n('common');
  const hasGoals = stats.top_goals.some(([, v]) => v > 0);
  const hasTools = stats.top_tools.some(([, v]) => v > 0);
  const langItems = Object.entries(stats.languages).sort(([, a], [, b]) => b - a).slice(0, 6);
  const hasLangs = langItems.some(([, v]) => v > 0);
  const typeItems = Object.entries(stats.session_types).sort(([, a], [, b]) => b - a).slice(0, 6);
  const hasTypes = typeItems.some(([, v]) => v > 0);

  return (
    <>
      <ChartsRow>
        {hasGoals && <BarChart title={t('insights.topGoals')} items={stats.top_goals} max={6} color={CHART_COLORS.blue} />}
        {hasTools && <BarChart title={t('insights.topTools')} items={stats.top_tools} max={6} color={CHART_COLORS.blue} />}
      </ChartsRow>
      {(hasLangs || hasTypes) && (
        <ChartsRow>
          {hasLangs && <BarChart title={t('insights.languages')} items={langItems} max={6} color={CHART_COLORS.green} />}
          {hasTypes && <BarChart title={t('insights.sessionTypes')} items={typeItems} max={6} color={CHART_COLORS.purple} />}
        </ChartsRow>
      )}
    </>
  );
};

const UsageCharts: React.FC<{ stats: InsightsStats }> = ({ stats }) => {
  const { t } = useI18n('common');

  const responseTimeBuckets = stats.response_time_buckets || {};
  const hasResponseTime = Object.keys(responseTimeBuckets).length > 0;
  const hourCounts = stats.hour_counts || {};
  const hasTimeOfDay = Object.keys(hourCounts).length > 0;
  const toolErrors = stats.tool_errors || {};
  const hasToolErrors = Object.keys(toolErrors).length > 0;
  const agentTypes = stats.agent_types || {};
  const hasAgentTypes = Object.keys(agentTypes).length > 0;

  const sortedResponseTime: [string, number][] = RESPONSE_TIME_ORDER
    .filter((label) => responseTimeBuckets[label] != null)
    .map((label) => [label, responseTimeBuckets[label]]);

  const timeOfDayItems: [string, number][] = TIME_OF_DAY_PERIODS.map(({ labelKey, hours }) => {
    const count = hours.reduce((sum, h) => sum + (hourCounts[h] ?? 0), 0);
    return [t(`insights.${labelKey}`), count];
  });

  if (!hasResponseTime && !hasTimeOfDay && !hasToolErrors && !hasAgentTypes) return null;

  return (
    <>
      {hasResponseTime && (
        <ChartsRow>
          <BarChart
            title={t('insights.responseTime')}
            items={sortedResponseTime}
            max={7}
            color={CHART_COLORS.indigo}
          />
        </ChartsRow>
      )}
      {(hasTimeOfDay || hasToolErrors) && (
        <ChartsRow>
          {hasTimeOfDay && (
            <BarChart
              title={t('insights.timeOfDay')}
              items={timeOfDayItems}
              max={4}
              color={CHART_COLORS.orange}
            />
          )}
          {hasToolErrors && (
            <BarChart
              title={t('insights.toolErrors')}
              items={Object.entries(toolErrors).sort(([, a], [, b]) => b - a).slice(0, 6)}
              max={6}
              color={CHART_COLORS.red}
            />
          )}
        </ChartsRow>
      )}
      {hasAgentTypes && (
        <ChartsRow>
          <BarChart
            title={t('insights.agentTypes')}
            items={Object.entries(agentTypes).sort(([, a], [, b]) => b - a)}
            max={6}
            color={CHART_COLORS.purple}
          />
        </ChartsRow>
      )}
    </>
  );
};

const OutcomeCharts: React.FC<{ stats: InsightsStats }> = ({ stats }) => {
  const { t } = useI18n('common');
  const success = stats.success || {};
  const outcomes = stats.outcomes || {};
  const hasSuccess = Object.keys(success).length > 0;
  const hasOutcomes = Object.keys(outcomes).length > 0;

  if (!hasSuccess && !hasOutcomes) return null;

  return (
    <ChartsRow>
      {hasSuccess && (
        <BarChart
          title={t('insights.whatHelpedMost')}
          items={Object.entries(success).sort(([, a], [, b]) => b - a).slice(0, 6)}
          max={6}
          color={CHART_COLORS.green}
        />
      )}
      {hasOutcomes && (
        <BarChart
          title={t('insights.outcomes')}
          items={Object.entries(outcomes).sort(([, a], [, b]) => b - a).slice(0, 6)}
          max={6}
          color={CHART_COLORS.purple}
        />
      )}
    </ChartsRow>
  );
};

const FrictionCharts: React.FC<{ stats: InsightsStats }> = ({ stats }) => {
  const { t } = useI18n('common');
  const friction = stats.friction || {};
  const satisfaction = stats.satisfaction || {};
  const hasFriction = Object.keys(friction).length > 0;
  const hasSatisfaction = Object.keys(satisfaction).length > 0;

  if (!hasFriction && !hasSatisfaction) return null;

  return (
    <ChartsRow>
      {hasFriction && (
        <BarChart
          title={t('insights.frictionTypes')}
          items={Object.entries(friction).sort(([, a], [, b]) => b - a).slice(0, 6)}
          max={6}
          color={CHART_COLORS.red}
        />
      )}
      {hasSatisfaction && (
        <BarChart
          title={t('insights.satisfaction')}
          items={Object.entries(satisfaction).sort(([, a], [, b]) => b - a).slice(0, 6)}
          max={6}
          color={CHART_COLORS.orange}
        />
      )}
    </ChartsRow>
  );
};

const StatItem: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <div className="insights-stat">
    <span className="insights-stat__value">{value}</span>
    <span className="insights-stat__label">{label}</span>
  </div>
);

// Bar chart palette (default + semantic roles)
const CHART_COLORS = {
  blue: 'var(--openbitfun-color-accent-default)',      // default / primary series
  green: APPEARANCE_DOMAIN_TOKENS.insights.positive,     // positive / success
  purple: 'var(--openbitfun-color-accent-secondary)',    // distribution / category
  indigo: APPEARANCE_DOMAIN_TOKENS.insights.time,    // time-related
  orange: APPEARANCE_DOMAIN_TOKENS.insights.neutral,    // time-of-day / neutral
  red: APPEARANCE_DOMAIN_TOKENS.insights.issue,       // issues / errors
} as const;

type ChartColor = typeof CHART_COLORS[keyof typeof CHART_COLORS];

const BarChart: React.FC<{ title: string; items: [string, number][]; max: number; color?: ChartColor }> = ({ title, items, max, color }) => {
  const nonZero = items.filter(([, v]) => v > 0);
  const displayed = nonZero.slice(0, max);
  const maxVal = Math.max(...displayed.map(([, v]) => v), 1);

  if (displayed.length === 0) return null;

  const barColor = color || CHART_COLORS.blue;

  return (
    <div className="insights-chart-card">
      <div className="insights-chart-card__title">{title}</div>
      {displayed.map(([label, value]) => {
        const pct = (value / maxVal) * 100;
        const displayLabel = label.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        return (
          <div key={label} className="insights-bar-row">
            <OverflowText className="insights-bar-row__label">{displayLabel}</OverflowText>
            <div className="insights-bar-row__track">
              <div className="insights-bar-row__fill" style={{ width: `${pct}%`, background: barColor }} />
            </div>
            <span className="insights-bar-row__value">{value}</span>
          </div>
        );
      })}
    </div>
  );
};

const SuggestionsSection: React.FC<{ report: InsightsReport }> = ({ report }) => {
  const { suggestions } = report;
  const { t } = useI18n('common');
  const hasSuggestions =
    suggestions.openbitfun_md_additions.length > 0 ||
    suggestions.features_to_try.length > 0 ||
    suggestions.usage_patterns.length > 0;

  if (!hasSuggestions) return null;

  return (
    <section className="insights-section">
      <h3>{t('insights.suggestions')}</h3>

      {suggestions.openbitfun_md_additions.length > 0 && (
        <div className="insights-md-list">
          <h4>{t('insights.mdAdditions')}</h4>
          {suggestions.openbitfun_md_additions.map((md, i) => (
            <div key={i} className="insights-md-row">
              <div className="insights-md-row__header">
                {md.section && <span className="insights-md-row__badge">{md.section}</span>}
              </div>
              <CopyableCode text={md.content} />
              {md.rationale && <p className="insights-md-row__rationale">{md.rationale}</p>}
            </div>
          ))}
        </div>
      )}

      {suggestions.features_to_try.length > 0 && (
        <div className="insights-feature-list">
          <h4>{t('insights.featuresToTry')}</h4>
          {suggestions.features_to_try.map((f, i) => (
            <div key={f.feature} className="insights-feature-row">
              <span className="insights-feature-row__index">{i + 1}</span>
              <div className="insights-feature-row__body">
                <div className="insights-feature-row__title">{f.feature}</div>
                <p className="insights-feature-row__desc"><MarkdownInline text={f.description} /></p>
                {f.benefit && <p className="insights-feature-row__benefit"><MarkdownInline text={f.benefit} /></p>}
                {f.example_usage && <CopyableCode text={f.example_usage} />}
              </div>
            </div>
          ))}
        </div>
      )}

      {suggestions.usage_patterns.length > 0 && (
        <div className="insights-pattern-list">
          <h4>{t('insights.usagePatterns')}</h4>
          {suggestions.usage_patterns.map((p) => (
            <div key={p.pattern} className="insights-pattern-row">
              <div className="insights-pattern-row__title">{p.pattern}</div>
              <p className="insights-pattern-row__desc"><MarkdownInline text={p.description} /></p>
              {p.suggested_prompt && <CopyableCode text={p.suggested_prompt} label={t('insights.tryThisPrompt')} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const MarkdownInline: React.FC<{ text: string }> = ({ text }) => {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1] != null) {
      parts.push(<strong key={match.index}>{match[1]}</strong>);
    } else if (match[2] != null) {
      parts.push(<em key={match.index}>{match[2]}</em>);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
};

const CopyableCode: React.FC<{ text: string; label?: string }> = ({ text, label }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      log.error('Failed to copy', e);
    }
  }, [text]);

  return (
    <div className="insights-copyable">
      {label && <div className="insights-copyable__label">{label}</div>}
      <div className="insights-copyable__row">
        <code className="insights-copyable__code">{text}</code>
        <button className="insights-copyable__btn" onClick={handleCopy} aria-label={copied ? 'Copied' : 'Copy to clipboard'}>
          {copied ? <Icon name="check-line" size="xs" /> : <Icon name="duplicate" size="xs" />}
        </button>
      </div>
    </div>
  );
};

export default InsightsScene;
