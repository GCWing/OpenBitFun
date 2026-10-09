import React, { useLayoutEffect, useRef, useState } from 'react';
import '../../src/styles/reset.scss';
import '@openbitfun/theme-openbitfun/default.css';
import '@openbitfun/ui/mobile.css';
import '../../src/styles/index.scss';
import { createRoot } from 'react-dom/client';
import { ThinkingBlock } from '../../src/components/ChatTranscript';
import { MarkdownContent } from '../../src/components/ChatMarkdown';
import ChatComposerBar from '../../src/components/ChatComposerBar';
import { MobileHostQueue } from '../../src/components/MobileHostQueue';
import { useMobileViewport } from '../../src/hooks/useMobileViewport';
import { ThemeProvider } from '../../src/theme';
import { I18nProvider } from '../../src/i18n';
import { HostDialogQueue } from '../../../shared/dialog-queue/HostDialogQueue';

export function mountHostQueueFixture({ count = 1, expanded = true } = {}) {
  const element = document.createElement('main');
  element.style.height = '100%';
  document.body.replaceChildren(element);
  const calls: string[] = [];
  let items = Array.from({ length: count }, (_, index) => ({ turnId: `queued-${index}`, displayContent: index === 0 ? '接着检查错误处理和测试覆盖' : `排队消息 ${index + 1}：分析当前项目的实现，检查可能的问题。`, previewTruncated: false,
    attachmentCount: 0, agentType: 'Standard', createdAtMs: 1, status: 'queued' as const, reason: null, targetTurnId: null, steeringId: null }));
  const queue = new HostDialogQueue('ui-fixture', 'session', async request => {
    calls.push(request.action);
    if (request.action === 'cancel' || request.action === 'promote') items = items.filter(item => item.turnId !== request.turnId);
    return { sessionId: 'session', queueEpoch: 'epoch', revision: calls.length, activeTurnId: 'active',
      items, capacity: 20, used: items.length, receipt: null };
  });
  const noop = () => {};
  const root = createRoot(element);
  function Fixture() {
    useMobileViewport();
    const ref = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState(56);
    useLayoutEffect(() => {
      const observer = new ResizeObserver(() => setHeight(ref.current!.getBoundingClientRect().height));
      observer.observe(ref.current!);
      return () => observer.disconnect();
    }, []);
    return <ThemeProvider><I18nProvider><div className={`chat-page${window.innerWidth >= 900 ? ' chat-page--wide' : ''}`} style={{ '--chat-composer-height': `${height}px` } as React.CSSProperties}>
    <header className="chat-page__header">项目介绍</header>
    <div className="chat-page__messages"><div className="chat-msg chat-msg--assistant"><ThinkingBlock thinking="检查代码和测试覆盖。" /><div className="chat-msg__assistant-content"><MarkdownContent content={"我先看一下工作区，再继续分析实现。\n\n公式演示：\\(E = mc^2\\)\n\n\\[\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\\]\n\n```bash\necho $$ $1 $&\n```\n\nhttps://example.com/very/long/path/that/should/wrap/without/overflowing/the/mobile/viewport"} /></div></div></div>
    <ChatComposerBar queueContent={<MobileHostQueue queue={queue} onRestore={noop} />}
      cancelling={false} containerRef={ref} expanded={expanded} imageAnalyzing={false} sending={false}
      input="继续检查" inputRef={null} modelControls={null} onActivate={noop} onAttach={noop} onCancel={() => calls.push('stop')}
      onChange={noop} onCompositionEnd={noop} onCompositionStart={noop} onKeyDown={noop} onRemoveImage={noop}
      onSend={() => calls.push('send')} pendingImages={[]} remoteUnavailable={false} streaming />
  </div></I18nProvider></ThemeProvider>;
  }
  root.render(<Fixture />);
  return { calls, dispose: () => root.unmount() };
}
