import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MobileBanner, MobileButton, MobileTextarea } from '@openbitfun/ui/mobile';
import type { RemoteSessionManager } from '../services/RemoteSessionManager';
import ChatAskQuestionCard, {QuestionInteractionContext} from './ChatAskQuestionCard';
import { InteractionVerifyContext } from './InteractionVerification';
import { describeChatError, isUnknownOutcomeFailure } from '../services/chatErrorPresentation';
import { useI18n } from '../i18n';

interface PermissionRequest {
  requestId: string; sessionId: string; toolCallId?: string; action: string;
  resources: string[]; source?: {identity?:string}; displayMetadata?: Record<string,unknown>;
}
interface PendingQuestion {toolId:string;sessionId:string;questions:Record<string,unknown>}
interface InteractionMailbox {sessionId:string;permissions:{revision:number;requests:PermissionRequest[]};userQuestions:{revision:number;questions:PendingQuestion[]}}
type MailboxFailure =
  | {operation:'load';message:string}
  | {operation:'reply';requestId:string;message:string}
  /** The reply was lost and the request is still pending after a re-read. */
  | {operation:'unconfirmed';requestId:string};

/** A read settles the failures it can answer: a load failure, and a reply
 * failure whose request is no longer pending (answered here or elsewhere). */
function settledFailure(current:MailboxFailure|null,pending:ReadonlySet<string>):MailboxFailure|null {
  if(!current||current.operation==='load')return null;
  return pending.has(current.requestId)?current:null;
}

/** Runtime mailbox identity is requestId. A tool call is only an optional display association.
 *
 * `onQuestionIds` reports the question tool IDs this mailbox renders, so the
 * transcript does not render a second card for the same question. */
export function PermissionMailbox({manager,sessionId,invalidation,onQuestionIds}:{manager:RemoteSessionManager;sessionId:string;invalidation:number;onQuestionIds?:(ids:ReadonlySet<string>)=>void}) {
  const {t}=useI18n();
  const [questions,setQuestions]=useState<PendingQuestion[]>([]);
  const [requests,setRequests]=useState<PermissionRequest[]>([]);
  const [failed,setFailed]=useState<MailboxFailure | null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [checking,setChecking]=useState<string|null>(null);
  const [editId,setEditId]=useState<string|null>(null);
  const [input,setInput]=useState('{}');
  const epoch=useRef(0);
  const running=useRef<Promise<InteractionMailbox|null>|null>(null);
  const dirty=useRef(false);
  const onQuestionIdsRef=useRef(onQuestionIds);
  onQuestionIdsRef.current=onQuestionIds;
  /** Re-read the mailbox; resolves with the newest copy, or null when it could not be read. */
  const refresh=useCallback(():Promise<InteractionMailbox|null>=>{
    dirty.current=true;
    if(running.current)return running.current;
    const ticket=epoch.current;
    const run=(async()=>{
      let latest:InteractionMailbox|null=null;
      try {
        while(dirty.current&&ticket===epoch.current){
          dirty.current=false;
          const next=await manager.invokeHost<InteractionMailbox>('get_session_interaction_mailbox',{sessionId});
          if(next.sessionId!==sessionId)throw new Error('Interaction mailbox session mismatch');
          if(ticket!==epoch.current)break;
          latest=next;
          const owned=next.userQuestions.questions.filter(question=>question.sessionId===sessionId);
          const ownedRequests=next.permissions.requests.filter(request=>request.sessionId===sessionId);
          const pending=new Set(ownedRequests.map(request=>request.requestId));
          setRequests(ownedRequests);
          setQuestions(owned);
          onQuestionIdsRef.current?.(new Set(owned.map(question=>question.toolId)));
          setFailed(current=>settledFailure(current,pending));
        }
        return latest;
      }catch(error){
        if(ticket===epoch.current)setFailed({operation:'load',message:describeChatError(error,t)});
        return null;
      }finally{running.current=null;}
    })();
    running.current=run;
    return run;
  },[manager,sessionId,t]);
  useEffect(()=>{void refresh();},[invalidation]);
  useEffect(()=>()=>{epoch.current++;onQuestionIdsRef.current?.(new Set());},[]);
  const verify=useCallback(async()=>{await refresh();},[refresh]);
  async function reply(requestId:string,answer:'once'|'reject') {
    if(busy)return;
    const ticket=epoch.current;
    setBusy(requestId);setFailed(null);
    try {
      const updatedInput=editId===requestId&&answer==='once'?JSON.parse(input):undefined;
      if(updatedInput!==undefined&&(!updatedInput||typeof updatedInput!=='object'||Array.isArray(updatedInput)))throw new Error('Input must be a JSON object');
      await manager.invokeHost('respond_permission',{requestId,reply:answer,updatedInput});
      if(ticket===epoch.current){setEditId(null);await refresh();}
    }catch(error){
      if(ticket!==epoch.current)return;
      if(isUnknownOutcomeFailure(error)){
        // The decision may have arrived. Re-read the mailbox before offering the
        // buttons again: a request that left it was answered.
        setChecking(requestId);
        const next=await refresh();
        if(ticket!==epoch.current)return;
        setChecking(null);
        if(next&&!next.permissions.requests.some(request=>request.requestId===requestId)){setEditId(null);return;}
        setFailed({operation:'unconfirmed',requestId});
      }else{
        setFailed({operation:'reply',requestId,message:error instanceof SyntaxError?'':describeChatError(error,t)});
        void refresh();
      }
    }
    finally{if(ticket===epoch.current)setBusy(null);}
  }
  if(!requests.length&&!questions.length&&!failed)return null;
  return <section aria-label={t('chat.approvalRequired')}>
    {failed&&failed.operation!=='unconfirmed'&&<MobileBanner tone="danger">{t(failed.operation==='load'?'chat.interactionLoadFailed':'chat.approvalFailed')} {failed.message}<MobileButton onClick={()=>void refresh()}>{t('devices.retry')}</MobileButton></MobileBanner>}
    <InteractionVerifyContext.Provider value={verify}>
    <QuestionInteractionContext.Provider value={toolId=>manager.startQuestionInteraction(sessionId,toolId)}>
      {questions.map(question=><ChatAskQuestionCard key={question.toolId} owner="mailbox" tool={{id:question.toolId,name:'AskUserQuestion',status:'running',tool_input:question.questions}}
        onAnswer={async(toolId,answers)=>{await manager.answerQuestion(toolId,answers);await refresh();}}/>)}
    </QuestionInteractionContext.Provider>
    </InteractionVerifyContext.Provider>
    {requests.map(request=><div key={request.requestId}>
      <h3>{request.source?.identity||request.action}</h3>
      <p>{request.action}</p><pre>{request.resources.join('\n')}</pre>
      {editId===request.requestId&&<MobileTextarea aria-label={t('chat.toolRequest')} value={input} onChange={event=>setInput(event.target.value)} disabled={!!busy}/>}
      {checking===request.requestId&&<p role="status">{t('chat.decisionChecking')}</p>}
      {failed?.operation==='unconfirmed'&&failed.requestId===request.requestId&&<p role="alert">{t('chat.decisionUnconfirmed')}</p>}
      <MobileButton disabled={!!busy} onClick={()=>{setEditId(request.requestId);setInput('{}');}}>{t('chat.editApproval')}</MobileButton>
      <MobileButton disabled={!!busy} onClick={()=>void reply(request.requestId,'once')}>{t('chat.approve')}</MobileButton>
      <MobileButton disabled={!!busy} onClick={()=>void reply(request.requestId,'reject')}>{t('chat.reject')}</MobileButton>
    </div>)}
  </section>;
}
