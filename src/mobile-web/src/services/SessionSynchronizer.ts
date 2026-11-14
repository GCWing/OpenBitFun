import { UNSUPPORTED_HOST_MESSAGE, type SessionStreamHandle, type SessionHistoryState } from '../../../shared/relay-transport/HostStream';
import type { RemoteSessionManager, PollResponse, ChatMessage, RemoteToolStatus } from './RemoteSessionManager';
import { SessionRecordReplica, type SessionRecord } from '../../../shared/relay-transport/SessionRecordReplica';
import { presentSessionTurn, type MobileStoredTurn } from './SessionRecordPresentation';

/** What the reader can tell the chat about its own freshness.
 * - `loading`: the first page has not arrived.
 * - `live`: caught up with the host.
 * - `catching-up`: a read failed or a reconnect is in flight; the transcript
 *   may be behind until the next completed catch-up.
 * - `unsupported`: the host cannot serve streams; retried on recovery signals. */
export type SessionSyncState = 'loading' | 'live' | 'catching-up' | 'unsupported';

export interface SessionSynchronizerOptions {
  onSyncState?: (state: SessionSyncState) => void;
}

/** The online host's stream is the sole transcript authority for initial, live
 * and recovery data; nothing is read from the Relay or from a local cache. */
export class SessionSynchronizer {
  private stopped = true;
  private unsubscribe: SessionStreamHandle | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private connecting = false;
  private ready = false;
  /** The open reader reported a failed read and is backing off on its own. */
  private stalled = false;
  private syncState: SessionSyncState = 'loading';
  private stopRecovery: (() => void) | null = null;
  private caughtUpWaiters = new Set<() => void>();
  private revision = 0;
  private replica: SessionRecordReplica;
  private readonly controls = new Map<string,{turnId:string;tool:RemoteToolStatus}>();
  private readonly turns = new Map<string, {index:number;status:string;messages:ChatMessage[]}>();
  private promptSuggestion: {turnId:string;text:string}|null = null;
  constructor(private readonly sessionMgr: RemoteSessionManager, private readonly sessionId: string,
    private readonly onUpdate: (state: PollResponse) => void, _knownModelCatalogVersion = 0, private readonly onHistoryState?: (state: SessionHistoryState) => void, private readonly onControlInvalidated?: () => void, private readonly onError?: (error: unknown) => void, private readonly options: SessionSynchronizerOptions = {}) { this.replica = new SessionRecordReplica(sessionId); }
  start(_initialMsgCount=0): void {
    this.stopped=false;
    // The reader backs off on its own after a failed read and ignores wakes
    // until its timer fires. A reconnect, resume, host return or a hint for
    // this session restarts it at once instead of waiting out the backoff.
    this.stopRecovery?.();
    this.stopRecovery=this.sessionMgr.onStreamRecoverySignal?.(this.sessionId,()=>this.recover())??null;
    void this.connect();
  }
  stop(): void {
    this.stopped=true;this.unsubscribe?.close();this.unsubscribe=null;
    if(this.retry!==null)clearTimeout(this.retry);this.retry=null;
    this.stopRecovery?.();this.stopRecovery=null;
    this.resolveCaughtUpWaiters();
  }
  resetCursors(): void { /* Cursor belongs to the persistent stream owner. */ }
  setKnownModelCatalogVersion(_version:number):void {}
  get state(): SessionSyncState { return this.syncState; }
  nudge():void {
    if(this.stopped)return;
    if(this.stalled||this.retry!==null||this.syncState==='unsupported'){this.recover();return;}
    if(this.unsubscribe)this.unsubscribe.wake();else if(!this.connecting)void this.connect();
  }
  /** Ask the host again and resolve after the next completed catch-up, or after
   * `timeoutMs` when the host does not answer. Used to settle an action whose
   * reply was lost before telling the user it was not confirmed. */
  refreshed(timeoutMs=8000):Promise<void> {
    if(this.stopped)return Promise.resolve();
    return new Promise<void>(resolve=>{
      let timer:ReturnType<typeof setTimeout>|null=null;
      const done=()=>{if(timer!==null)clearTimeout(timer);this.caughtUpWaiters.delete(done);resolve();};
      timer=setTimeout(done,timeoutMs);
      this.caughtUpWaiters.add(done);
      this.nudge();
    });
  }
  private resolveCaughtUpWaiters():void { for(const done of [...this.caughtUpWaiters])done(); }
  private setSyncState(state:SessionSyncState):void {
    if(this.syncState===state)return;
    this.syncState=state;this.options.onSyncState?.(state);
  }
  /** Restart a stalled, waiting or unsupported reader now. A healthy reader
   * already follows hints and reconnects itself. */
  private recover():void {
    if(this.stopped||this.connecting)return;
    if(this.unsubscribe&&!this.stalled)return;
    if(this.retry!==null){clearTimeout(this.retry);this.retry=null;}
    this.retryDelay=1000;
    if(this.unsubscribe){this.unsubscribe.close();this.unsubscribe=null;}
    this.stalled=false;
    if(this.ready)this.setSyncState('catching-up');
    void this.connect();
  }
  async loadOlder():Promise<void> { await this.unsubscribe?.loadOlder(); }
  private publish():void {
    const messages=[...this.turns.values()].sort((a,b)=>a.index-b.index).flatMap(turn=>turn.messages);
    const last=messages.slice(-1)[0];
    const active=last?.role==='assistant'&&last.status==='streaming'?last:null;
    const controls=[...this.controls.values()].filter(control=>control.turnId===active?.turn_id).map(control=>control.tool);
    const tools=active?.tools?.map(tool=>controls.find(control=>control.id===tool.id)??tool)??[];
    for(const control of controls)if(!tools.some(tool=>tool.id===control.id))tools.push(control);
    const items=active?.items?.map(item=>item.tool?{...item,tool:controls.find(control=>control.id===item.tool!.id)??item.tool}:item)??[];
    for(const control of controls)if(!items.some(item=>item.tool?.id===control.id))items.push({type:'tool',tool:control});
    this.onUpdate({resp:'session_update',changed:true,version:++this.revision,
      message_snapshot:active?messages.slice(0,-1):messages,
      active_turn:active?{turn_id:active.turn_id!,status:'active',text:active.content,thinking:active.thinking??'',items,tools,round_index:0}:null,
      prompt_suggestion:this.currentPromptSuggestion()});
  }
  private latestTurn():{id:string;index:number;status:string}|null {
    let latest:{id:string;index:number;status:string}|null=null;
    for(const [id,turn] of this.turns)if(!latest||turn.index>latest.index)latest={id,index:turn.index,status:turn.status};
    return latest;
  }
  /** A suggestion only answers the turn it was produced for; any newer turn retires it. */
  private currentPromptSuggestion():string|null {
    const suggestion=this.promptSuggestion;
    if(!suggestion)return null;
    const latest=this.latestTurn();
    if(latest?.id!==suggestion.turnId||latest.status!=='completed'){this.promptSuggestion=null;return null;}
    return suggestion.text;
  }
  /** Host restarts renumber records; derived state is rebuilt from the replayed page. */
  private resetDerivedState():void {
    this.replica=new SessionRecordReplica(this.sessionId);
    this.turns.clear();this.controls.clear();this.promptSuggestion=null;
  }
  private async connect():Promise<void> {
    if(this.stopped||this.connecting||this.unsubscribe)return;
    this.connecting=true;
    // A new subscription may land on a host stream rebuilt with lower revisions;
    // its records must supersede what an earlier attempt delivered.
    this.replica.rebaseRevisions();
    try {
      const unsubscribe=await this.sessionMgr.subscribeSessionStream(this.sessionId,{onEvent:event=>{
        if(this.stopped)return;
        if(event.session_id!==this.sessionId)throw new Error('Session stream binding mismatch');
        if(event.event==='session-record') {
          const change=this.replica.apply(event.payload as SessionRecord);
          if(!change)return;
          if(change.turn) {
            const turn=change.turn as unknown as MobileStoredTurn;
            const messages=presentSessionTurn(turn);
            this.turns.set(change.turnId,{index:turn.turnIndex,status:turn.status,messages});
            for(const message of messages)for(const tool of message.tools??[])if(['completed','failed','cancelled','rejected','skipped'].includes(tool.status))this.controls.delete(tool.id);
            if(turn.status!=='inprogress')for(const [id,control] of this.controls)if(control.turnId===change.turnId)this.controls.delete(id);
          } else this.turns.delete(change.turnId);
          if(this.ready)this.publish();
        } else if(event.event==='session-interaction-changed') {
          this.onControlInvalidated?.();
        } else if(event.event==='agentic://tool-event') {
          const payload=event.payload as {turnId?:string;toolEvent?:{event_type?:string;tool_id?:string;tool_name?:string;params?:unknown}};
          const tool=payload.toolEvent;
          if(['ConfirmationNeeded','Confirmed','Rejected','Cancelled'].includes(tool?.event_type??''))this.onControlInvalidated?.();
          if(tool?.tool_id&&payload.turnId){
            if(tool.event_type==='ConfirmationNeeded')this.controls.set(tool.tool_id,{turnId:payload.turnId,tool:{id:tool.tool_id,name:tool.tool_name??'',status:'pending_confirmation',tool_input:tool.params}});
            else if(['Confirmed','Completed','Failed','Cancelled','Rejected'].includes(tool.event_type??''))this.controls.delete(tool.tool_id);
            if(this.ready)this.publish();
          }
        } else if(event.event==='agentic://prompt-suggestion') {
          const payload=event.payload as {sessionId?:unknown;sourceTurnId?:unknown;suggestion?:unknown}|null;
          const text=typeof payload?.suggestion==='string'?payload.suggestion:'';
          const latest=this.latestTurn();
          if(payload&&(payload.sessionId===undefined||payload.sessionId===this.sessionId)&&
            typeof payload.sourceTurnId==='string'&&payload.sourceTurnId&&text&&
            (!latest||latest.id===payload.sourceTurnId)){
            this.promptSuggestion={turnId:payload.sourceTurnId,text};
            if(this.ready)this.publish();
          }
        } else if(event.event==='session_title_generated') {
          this.onUpdate({resp:'session_update',changed:true,version:++this.revision,title:String((event.payload as {title?:string}).title??'')});
        }
      },onError:error=>{
        console.error('[SessionSync] recovery failed',error);
        if(this.stopped)return;
        this.stalled=true;this.setSyncState(this.ready?'catching-up':'loading');
        this.onError?.(error);
      },onCaughtUp:()=>{
        if(!this.stopped){this.ready=true;this.stalled=false;this.publish();this.setSyncState('live');this.resolveCaughtUpWaiters();}
      },onHistoryState:this.onHistoryState,onResumed:this.onControlInvalidated,
      onGap:()=>{if(!this.stopped){this.resetDerivedState();
        // A restarted host may be a different build; learn its capabilities again.
        this.sessionMgr.forgetHostCapabilities?.();
        this.onUpdate({resp:'session_update',changed:true,version:++this.revision,prompt_suggestion:null});
        this.onControlInvalidated?.();}}});
      if(this.stopped)unsubscribe.close();else{this.unsubscribe=unsubscribe;this.retryDelay=1000;}
    }catch(error){
      if(this.stopped)return;
      console.error('[SessionSync] subscription deferred',error);
      this.onError?.(error);
      // An older host cannot serve streams at all; a timer would only repeat
      // the same answer. The unsupported state stands until a recovery signal
      // (host back online, reconnect, resume) re-probes the host.
      if(error instanceof Error&&error.message===UNSUPPORTED_HOST_MESSAGE){this.setSyncState('unsupported');this.resolveCaughtUpWaiters();return;}
      this.setSyncState(this.ready?'catching-up':'loading');
      this.retry=setTimeout(()=>{this.retry=null;void this.connect();},this.retryDelay);
      this.retryDelay=Math.min(this.retryDelay*2,30000);
    }finally{this.connecting=false;}
  }
}
