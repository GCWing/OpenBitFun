import type { ActiveTurnSnapshot, ChatMessage, ChatMessageItem, PollResponse } from './RemoteSessionManager';
import type { SessionEvent } from '../../../shared/relay-transport/HostStream';
import { backgroundDeliveryFromMetadata, readBackgroundDelivery } from '../../../shared/background-delivery';

/** Presentation-only reduction of the runtime's durable typed event contract.
 * Reads and execution stay on the host. Transport sequence deduplication occurs
 * before this reducer, so text chunks are appended exactly once. */
export class SessionEventReducer {
  active: ActiveTurnSnapshot | null = null;
  revision = 0;
  private userText = '';
  private userMetadata: Record<string, unknown> | undefined;
  private timestamp = '';
  private positions = new WeakMap<ChatMessageItem,{round:string;attempt:string}>();

  apply(envelope: SessionEvent): PollResponse | null {
    const payload = envelope.payload as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') throw new Error('Invalid session event payload');
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : '';
    const response = (): PollResponse => ({resp:'session_update',changed:true,version:++this.revision,active_turn:this.active ? structuredClone(this.active):null});
    if (envelope.event === 'session_title_generated') return {...response(), title: String(payload.title ?? '')};
    if (envelope.event === 'agentic://dialog-turn-started') {
      this.active={turn_id:turnId,status:'active',text:'',thinking:'',tools:[],round_index:0,items:[]};
      this.userText=String(payload.originalUserInput ?? payload.userInput ?? '');
      this.userMetadata = payload.userMessageMetadata as Record<string, unknown> | undefined;
      this.active.backgroundDelivery = backgroundDeliveryFromMetadata(this.userMetadata, turnId);
      this.timestamp=String(Math.floor(Date.now()/1000)); this.positions=new WeakMap();
      return {...response(),new_messages:[{id:`${turnId}_user`,turn_id:turnId,role:'user',content:this.userText,timestamp:this.timestamp, metadata:this.userMetadata, ...(this.active.backgroundDelivery ? {status:'active'} : {})}]};
    }
    if (!this.active || this.active.turn_id !== turnId) return null;
    if (envelope.event === 'agentic://model-round-started') {
      this.active.round_index=Number(payload.roundIndex ?? this.active.round_index);
      return response();
    }
    if (envelope.event === 'agentic://text-chunk') {
      const kind=payload.contentType==='thinking'?'thinking':'text';
      const text=typeof payload.text==='string'?payload.text:'';
      const round=String(payload.roundId??'');const attempt=String(payload.attemptId??'');
      const items=this.active.items!;const last=items.slice(-1)[0];
      if (last?.type===kind && round===this.positions.get(last)?.round && attempt===this.positions.get(last)?.attempt) last.content=(last.content??'')+text;
      else { const item:ChatMessageItem={type:kind,content:text};items.push(item);this.positions.set(item,{round,attempt}); }
      this.active[kind]+=text;
      return response();
    }
    if (envelope.event === 'agentic://tool-event') {
      const event=payload.toolEvent as Record<string,unknown>;
      if (!event || typeof event.tool_id!=='string') throw new Error('Invalid tool event');
      let tool=this.active.tools.find(tool=>tool.id===event.tool_id);
      if (!tool) { tool={id:event.tool_id,name:String(event.tool_name??''),status:'pending'};this.active.tools.push(tool);const item:ChatMessageItem={type:'tool',tool};this.active.items!.push(item);this.positions.set(item,{round:String(payload.roundId??''),attempt:String(payload.attemptId??'')}); }
      const statuses:Record<string,string>={Confirmed:'confirmed',EarlyDetected:'pending',Started:'running',Completed:'completed',Failed:'error',Cancelled:'cancelled',Rejected:'rejected',ConfirmationNeeded:'pending_confirmation',Waiting:'waiting',Queued:'queued'};
      if (statuses[String(event.event_type)]) tool.status=statuses[String(event.event_type)];
      if ('params' in event) {
        if (event.event_type==='ParamsPartial') tool.input_preview=(tool.input_preview??'')+String(event.params??'');
        else {tool.tool_input=event.params;tool.input_preview=JSON.stringify(event.params);}
      }
      if (typeof event.duration_ms==='number') tool.duration_ms=event.duration_ms;
      return response();
    }
    if (envelope.event==='agentic://model-round-attempt-superseded') {
      const diagnostic=payload.diagnostic as Record<string,unknown>;
      const attempt=String(diagnostic?.attemptId??'');
      const round=String(payload.roundId??'');
      this.active.items=this.active.items!.filter(item=>{
        const position=this.positions.get(item);return position?.round!==round||position.attempt!==attempt;
      });
      this.active.text=this.active.items.filter(item=>item.type==='text').map(item=>item.content??'').join('');
      this.active.thinking=this.active.items.filter(item=>item.type==='thinking').map(item=>item.content??'').join('');
      this.active.tools=this.active.items.flatMap(item=>item.tool?[item.tool]:[]);
      return response();
    }
    if (envelope.event==='agentic://dialog-turn-interrupted') { this.active.status='interrupted';return response(); }
    if (envelope.event==='agentic://dialog-turn-recovered') {
      this.active.status='active';
      const delivery = readBackgroundDelivery(this.active.backgroundDelivery, turnId);
      if (delivery) this.active.backgroundDelivery = { ...delivery, executionGeneration: Number(payload.executionGeneration ?? 0), disposition: 'pending', resolvedAtMs: undefined };
      return response();
    }
    if (['agentic://dialog-turn-completed','agentic://dialog-turn-cancelled','agentic://dialog-turn-failed'].includes(envelope.event)) {
      const delivery = readBackgroundDelivery(payload.backgroundDelivery, turnId);
      const current = readBackgroundDelivery(this.active.backgroundDelivery, turnId);
      if (delivery && (delivery.executionGeneration ?? 0) < (current?.executionGeneration ?? 0)) return null;
      const active=this.active;this.active=null;
      const message:ChatMessage={id:`${turnId}_assistant`,turn_id:turnId,role:'assistant',content:active.text,thinking:active.thinking,tools:active.tools,items:active.items,timestamp:this.timestamp,status:envelope.event.endsWith('failed')||payload.success===false?'error':envelope.event.endsWith('completed')?'completed':'cancelled',error:typeof payload.error==='string'?payload.error:undefined};
      if (delivery || active.backgroundDelivery) {
        message.metadata = { backgroundDelivery: delivery };
        const user:ChatMessage = {id:`${turnId}_user`,turn_id:turnId,role:'user',content:this.userText,timestamp:this.timestamp,status:message.status,metadata:{...this.userMetadata,backgroundDelivery:delivery}};
        return {...response(),new_messages:[user,message]};
      }
      return {...response(),new_messages:[message]};
    }
    return null;
  }
}
