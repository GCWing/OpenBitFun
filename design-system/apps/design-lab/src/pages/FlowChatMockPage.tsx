import { useState } from 'react';
import { Maximize, Minimize, RotateCcw } from 'lucide-react';
import { Button, Icon, TabGroup } from '@openbitfun/ui';
import { useI18n } from '../i18n';
import { FlowChatMockConversation } from '../preview/FlowChatMockConversation';
import { flowChatMockScenarios } from '../preview/flowChatMockScenarios';
import { useFlowChatFullscreen } from '../preview/useFlowChatFullscreen';
import { FlowChatMockTools, FlowChatMockToolFilter, FlowChatMockCoverageNote, mockToolCoverage, type MockToolScope } from '../preview/FlowChatMockTools';
import './FlowChatMockPage.css';

export function FlowChatMockPage() {
  const { t } = useI18n();
  const { pageRef, buttonRef, fullscreen, toggleFullscreen } = useFlowChatFullscreen();
  const [selected, setSelected] = useState('completed');
  const [replay, setReplay] = useState(0);
  const [fromStart, setFromStart] = useState(false);
  const [toolScope, setToolScope] = useState<MockToolScope>('all');
  const scenario = flowChatMockScenarios.find(({ id }) => id === (selected === 'all-tools' ? 'completed' : selected))!;

  return <main ref={pageRef} className="lab-page flow-chat-mock-page" id="flow-chat-mock" data-fullscreen={fullscreen || undefined}>
    <header className="page-heading page-heading--split">
      <div>
        <h1>{t('design.conversation')}</h1>
      </div>
      <div className="flow-chat-mock-page__actions">
        <Button size="sm" leadingIcon={<Icon glyph={RotateCcw} />} onClick={() => {
          setFromStart(true);
          setReplay((value) => value + 1);
        }}>{t('flowChat.scenario.reset')}</Button>
        <Button ref={buttonRef} size="sm" leadingIcon={<Icon glyph={fullscreen ? Minimize : Maximize} />}
          aria-pressed={fullscreen} aria-controls="flow-chat-mock-panel" onClick={toggleFullscreen}>
          {t(fullscreen ? 'flowChat.mock.exitFullscreen' : 'flowChat.mock.enterFullscreen')}
        </Button>
      </div>
    </header>
    <TabGroup aria-label={t('flowChat.mock.scenarios')} value={selected}
      items={[{ value: 'all-tools', label: t('flowChat.mock.allTools', { count: mockToolCoverage.length }),
        id: 'flow-chat-mock-tab-all-tools', panelId: 'flow-chat-mock-panel' }, ...flowChatMockScenarios.map(({ id }) => ({
        value: id, label: t(`flowChat.mock.variant.${id}`),
        id: `flow-chat-mock-tab-${id}`, panelId: 'flow-chat-mock-panel',
      }))]}
      onValueChange={(value) => { setSelected(value); setFromStart(false); }} />
    <section id="flow-chat-mock-panel" role="tabpanel" aria-labelledby={`flow-chat-mock-tab-${selected}`}>
      {selected === 'all-tools' && <FlowChatMockToolFilter group={toolScope} onChange={setToolScope} />}
      <FlowChatMockConversation key={`${selected}-${replay}`} scenario={scenario} fromStart={fromStart}
        toolGallery={selected === 'all-tools' ? <FlowChatMockTools group={toolScope} /> : undefined} />
    </section>
    <p className="flow-chat-mock-page__note">{t('flowChat.mock.localOnly')}</p>
    {selected === 'all-tools' && <FlowChatMockCoverageNote />}
  </main>;
}
