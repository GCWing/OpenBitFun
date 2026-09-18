import { UNSUPPORTED_HOST_MESSAGE, type SessionStreamHandle, type SessionHistoryState } from '../../../shared/relay-transport/HostStream';
import type { RemoteSessionManager, PollResponse, ChatMessage, RemoteToolStatus } from './RemoteSessionManager';
import { SessionRecordReplica, type SessionRecord } from '../../../shared/relay-transport/SessionRecordReplica';
import { presentSessionTurn, type MobileStoredTurn } from './SessionRecordPresentation';

/** The online host's stream is the sole transcript authority for initial, live
 * and recovery data; nothing is read from the Relay or from a local cache. */
export class SessionSynchronizer {
  private stopped = true;
  private unsubscribe: SessionStreamHandle | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private connecting = false;
  private ready = false;
  private revision = 0;
  private replica: SessionRecordReplica;
  private readonly controls = new Map<string,{turnId:string;tool:RemoteToolStatus}>();
  private readonly turns = new Map<string, {index:number;messages:ChatMessage[]}>();
  constructor(private readonly sessionMgr: RemoteSessionManager, private readonly sessionId: string,
    private readonly onUpdate: (state: PollResponse) => void, _knownModelCatalogVersion = 0, private readonly onHistoryState?: (state: SessionHistoryState) => void, private readonly onControlInvalidated?: () => void, private readonly onError?: (error: unknown) => void) { this.replica = new SessionRecordReplica(sessionId); }
  start(_initialMsgCount=0): void {this.stopped=false;void this.connect();}
  stop(): void {this.stopped=true;this.unsubscribe?.close();this.unsubscribe=null;if(this.retry!==null)clearTimeout(this.retry);}
  resetCursors(): void { /* Cursor belongs to the persistent stream owner. */ }
  setKnownModelCatalogVersion(_version:number):void {}
  nudge():void { if(this.stopped)return;if(this.unsubscribe)this.unsubscribe.wake();else if(!this.connecting)void this.connect(); }
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
      active_turn:active?{turn_id:active.turn_id!,status:'active',text:active.content,thinking:active.thinking??'',items,tools,round_index:0}:null});
  }
  /** Host restarts renumber records; derived state is rebuilt from the replayed page. */
  private resetDerivedState():void {
    this.replica=new SessionRecordReplica(this.sessionId);
    this.turns.clear();this.controls.clear();
  }
  private async connect():Promise<void> {
    if(this.stopped||this.connecting||this.unsubscribe)return;
    this.connecting=true;
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
            this.turns.set(change.turnId,{index:turn.turnIndex,messages});
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
        } else if(event.event==='session_title_generated') {
          this.onUpdate({resp:'session_update',changed:true,version:++this.revision,title:String((event.payload as {title?:string}).title??'')});
        }
      },onError:error=>{console.error('[SessionSync] recovery failed',error);if(!this.stopped)this.onError?.(error);},onCaughtUp:()=>{
        if(!this.stopped){this.ready=true;this.publish();}
      },onHistoryState:this.onHistoryState,onResumed:this.onControlInvalidated,
      onGap:()=>{if(!this.stopped){this.resetDerivedState();this.onControlInvalidated?.();}}});
      if(this.stopped)unsubscribe.close();else{this.unsubscribe=unsubscribe;this.retryDelay=1000;}
    }catch(error){
      if(this.stopped)return;
      console.error('[SessionSync] subscription deferred',error);
      this.onError?.(error);
      // An older host cannot serve streams at all; retrying would only repeat
      // the same answer, so the explicit unsupported state stands.
      if(error instanceof Error&&error.message===UNSUPPORTED_HOST_MESSAGE)return;
      this.retry=setTimeout(()=>{this.retry=null;void this.connect();},this.retryDelay);
      this.retryDelay=Math.min(this.retryDelay*2,30000);
    }finally{this.connecting=false;}
  }
}
