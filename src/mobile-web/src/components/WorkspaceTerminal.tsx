import { TerminalSquare } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { MobileBanner, MobileButton } from '@openbitfun/ui/mobile';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalInputQueue } from '../../../shared/terminal/TerminalInputQueue';
import { useI18n } from '../i18n';
import type { RemoteSessionManager, WorkspaceInfo } from '../services/RemoteSessionManager';

export function WorkspaceTerminal({ manager, workspace }: { manager: RemoteSessionManager; workspace: Pick<WorkspaceInfo, 'path' | 'remote_connection_id'> }) {
  const { t } = useI18n();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const refresh = useRef<() => void>(() => {});
  const input = useRef<TerminalInputQueue>();
  const epoch = useRef(0);
  useEffect(() => {
    setSessionId(null);
    return () => { epoch.current++; };
  }, [manager, workspace.path, workspace.remote_connection_id]);
  useEffect(() => {
    if (!sessionId || !container.current) return;
    let disposed = false;
    let caughtUp = false;
    let stop: import('../../../shared/relay-transport/HostStream').SessionStreamHandle | undefined;
    const fail = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };
    const typography = getComputedStyle(container.current);
    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: Number.parseFloat(typography.getPropertyValue('--openbitfun-type-body-md-font-size')),
      convertEol: false,
    });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current);
    const applyTheme = () => {
      if (!container.current || disposed) return;
      const style = getComputedStyle(container.current);
      terminal.options.theme = {background:style.backgroundColor,foreground:style.color,cursor:style.color};
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme']});
    const queue = new TerminalInputQueue(async data => {
      if (!disposed) await manager.invokeHost('terminal_write',{sessionId,data});
    },fail);
    input.current = queue;
    const dataListener = terminal.onData(data => queue.enqueue(data));
    let pendingSize: {cols:number;rows:number} | undefined;
    let resizing = false;
    const resize = async () => {
      if (resizing || disposed) return;
      resizing = true;
      try { while (pendingSize && !disposed) { const size=pendingSize;pendingSize=undefined;await manager.invokeHost('terminal_resize',{sessionId,...size}); } }
      catch(cause){fail(cause);} finally{resizing=false;}
    };
    const resizeListener = terminal.onResize(size=>{pendingSize=size;void resize();});
    const fitVisible = () => {
      const element = container.current;
      if (!disposed && element && element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    };
    const resizeObserver = new ResizeObserver(fitVisible);
    resizeObserver.observe(container.current);
    window.visualViewport?.addEventListener('resize', fitVisible);
    fitVisible(); terminal.focus();
    let offset = 0;
    let running = false;
    let dirty = false;
    const read = async () => {
      dirty = true;
      if (running || disposed) return;
      running = true;
      try {
        while (dirty && !disposed) {
          dirty = false;
          const page = await manager.invokeHost<{data:string;nextOffset:number;cursor:number;truncated:boolean}>('terminal_get_history',{sessionId,afterOffset:offset},false);
          if(disposed)return;
          if(page.nextOffset<offset&&!page.truncated)throw new Error('Terminal cursor moved backwards');
          if(page.truncated)terminal.reset();
          await new Promise<void>(resolve=>terminal.write(page.data,resolve));
          if(disposed)return;
          offset=page.nextOffset;if(offset<page.cursor)dirty=true;
        }
      }catch(cause){fail(cause);}finally{running=false;}
    };
    refresh.current=()=>{void read();};
    void manager.subscribeSessionStream('terminal-'+sessionId,{
      onEvent:()=>{if(caughtUp)void read();},onError:fail,
      onCaughtUp:()=>{if(!caughtUp){caughtUp=true;void read();}},
      onResumed:()=>{if(caughtUp)void read();},
    }).then(stream=>{stop=stream;if(disposed)stream.close();}).catch(fail);
    return ()=>{
      disposed=true;stop?.close();queue.clear();input.current=undefined;refresh.current=()=>{};
      dataListener.dispose();resizeListener.dispose();resizeObserver.disconnect();window.visualViewport?.removeEventListener('resize', fitVisible);themeObserver.disconnect();terminal.dispose();
    };
  },[manager,sessionId]);
  async function execute(action:()=>Promise<void>) {
    const ticket=epoch.current;setBusy(true);setError(null);
    try{await action();}catch(cause){if(ticket===epoch.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(ticket===epoch.current)setBusy(false);}
  }
  return <section className="workspace-terminal">
    <div className="workspace-terminal__toolbar"><span className="workspace-terminal__path">{workspace.path}</span>
    {sessionId && <div className="workspace-terminal__actions">
      <MobileButton disabled={busy} onClick={()=>input.current?.enqueue('\u0003')}>{t('common.stop')}</MobileButton>
      <MobileButton disabled={busy} onClick={()=>void execute(async()=>{const ticket=epoch.current;await manager.invokeHost('terminal_close',{sessionId});if(ticket===epoch.current)setSessionId(null);})}>{t('common.close')}</MobileButton>
    </div>}</div>
    {error&&<MobileBanner tone="danger">{error}</MobileBanner>}
    {!sessionId?<div className="workspace-terminal__empty"><TerminalSquare size={36} aria-hidden="true"/><MobileButton disabled={busy} onClick={()=>void execute(async()=>{
      const ticket=epoch.current;
      const terminal=await manager.invokeHost<{id:string}>('terminal_create',{workingDirectory:workspace.path,connectionId:workspace.remote_connection_id,cols:80,rows:24,source:'user'});
      if(ticket===epoch.current)setSessionId(terminal.id);
    })}>{t('workspace.openTerminal')}</MobileButton></div>:<>
      <div className="workspace-terminal__screen"><div ref={container} className="workspace-terminal__viewport" aria-label={t('workspace.terminalOutput')}/></div>
    </>}
  </section>;
}
