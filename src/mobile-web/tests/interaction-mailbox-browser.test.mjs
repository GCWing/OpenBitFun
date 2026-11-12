import assert from 'node:assert/strict';
import {test} from 'node:test';
import {launchBrowser,startSourceServer} from './helpers/browser-account-harness.mjs';
test('mailbox restores questions and permissions without tool attachment and replies with the owning identities', {timeout:40000},async()=>{
 const source=await startSourceServer();const browser=await launchBrowser();
 try{
  const page=await browser.newPage();await page.goto(source.origin);
  await page.evaluate(async()=>{
   const R=await import('/node_modules/.vite/deps/react.js');const React=R.default??R;
   const D=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=D.default??D;
   const {PermissionMailbox}=await import('/src/components/PermissionMailbox.tsx');
   const calls=[];window.mailboxCalls=calls;let pending=true;
   const manager={invokeHost:async(command,request)=>{
    calls.push({command,request});
    if(command==='respond_permission')return null;
    return {sessionId:'session',permissions:{revision:1,requests:[{requestId:'request-without-tool',sessionId:'session',action:'write',resources:['/target']}]},userQuestions:{revision:1,questions:pending?[{toolId:'question-tool',sessionId:'session',questions:{questions:[{question:'Choose a value',options:[{label:'Alpha'},{label:'Beta'}]}]}}]:[]}};
   },startQuestionInteraction:async(sessionId,toolId)=>calls.push({command:'start',sessionId,toolId}),answerQuestion:async(toolId,answers)=>{calls.push({command:'answer',toolId,answers});pending=false;}};
   document.body.innerHTML='<div id="mailbox-test"></div>';
   createRoot(document.querySelector('#mailbox-test')).render(React.createElement(PermissionMailbox,{manager,sessionId:'session',invalidation:0}));
  });
  await page.waitForFunction(()=>document.body.innerText.includes('Choose a value'));
  await page.evaluate(()=>Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('Alpha')).click());
  await page.click('.chat-ask-card__submit');
  await page.waitForFunction(()=>window.mailboxCalls.some(c=>c.command==='answer'));
  await page.evaluate(()=>Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='chat.approve').click());
  await page.waitForFunction(()=>window.mailboxCalls.some(c=>c.command==='respond_permission'));
  const calls=await page.evaluate(()=>window.mailboxCalls);
  assert.equal(calls.find(c=>c.command==='start').toolId,'question-tool');
  assert.equal(calls.find(c=>c.command==='answer').toolId,'question-tool');
  assert.equal(calls.find(c=>c.command==='respond_permission').request.requestId,'request-without-tool');
  assert.ok(calls.filter(c=>c.command==='get_session_interaction_mailbox').length>=2);
 }finally{await browser.close();await source.close()}
});

test('lost replies are checked against the host before the mailbox offers its actions again', {timeout:40000},async()=>{
 const source=await startSourceServer();const browser=await launchBrowser();
 try{
  const page=await browser.newPage();await page.goto(source.origin);
  await page.evaluate(async()=>{
   const R=await import('/node_modules/.vite/deps/react.js');const React=R.default??R;
   const D=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=D.default??D;
   const {PermissionMailbox}=await import('/src/components/PermissionMailbox.tsx');
   const {default:ChatAskQuestionCard}=await import('/src/components/ChatAskQuestionCard.tsx');
   const {MailboxQuestionOwnerContext}=await import('/src/components/InteractionVerification.ts');
   const state={question:true,permissions:['kept','answered'],answers:0,owned:null};window.mailboxState=state;
   const lost=()=>Promise.reject(new Error('Relay connection changed; delivery outcome is unknown'));
   const manager={invokeHost:async(command,request)=>{
    if(command==='respond_permission'){
     // "answered" reaches the host before its reply is lost; "kept" never arrives.
     if(request.requestId==='answered')state.permissions=state.permissions.filter(id=>id!=='answered');
     return lost();
    }
    return {sessionId:'session',permissions:{revision:1,requests:state.permissions.map(id=>({requestId:id,sessionId:'session',action:`write-${id}`,resources:['/target']}))},
     userQuestions:{revision:1,questions:state.question?[{toolId:'question-tool',sessionId:'session',questions:{questions:[{question:'Choose a value',options:[{label:'Alpha'},{label:'Beta'}]}]}}]:[]}};
   },startQuestionInteraction:async()=>{},answerQuestion:async()=>{state.answers++;if(state.answers===1)return lost();state.question=false;}};
   document.body.innerHTML='<div id="mailbox-test"></div><div id="transcript-test"></div>';
   createRoot(document.querySelector('#mailbox-test')).render(React.createElement(PermissionMailbox,{manager,sessionId:'session',invalidation:0,onQuestionIds:ids=>{state.owned=[...ids];}}));
   const tool={id:'question-tool',name:'AskUserQuestion',status:'running',tool_input:{questions:[{question:'Transcript copy',options:[{label:'Gamma'}]}]}};
   window.renderTranscript=()=>createRoot(document.querySelector('#transcript-test')).render(React.createElement(MailboxQuestionOwnerContext.Provider,{value:new Set(state.owned??[])},React.createElement(ChatAskQuestionCard,{tool,onAnswer:async()=>{}})));
  });
  await page.waitForFunction(()=>document.body.innerText.includes('Choose a value')&&window.mailboxState.owned?.length===1);
  await page.evaluate(()=>window.renderTranscript());
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await page.evaluate(()=>document.body.innerText.includes('Transcript copy')),false,'the mailbox owns the question');

  // A lost answer whose question is still pending is offered again.
  await page.evaluate(()=>Array.from(document.querySelectorAll('#mailbox-test button')).find(e=>e.textContent.includes('Alpha')).click());
  await page.click('#mailbox-test .chat-ask-card__submit');
  await page.waitForFunction(()=>document.body.innerText.includes('chat.answerUnconfirmed'));
  assert.equal(await page.evaluate(()=>document.querySelector('#mailbox-test .chat-ask-card__submit').disabled),false);
  assert.match(await page.evaluate(()=>document.querySelector('#mailbox-test .chat-ask-card__submit').textContent),/chat\.retryAnswer/);
  await page.click('#mailbox-test .chat-ask-card__submit');
  await page.waitForFunction(()=>!document.body.innerText.includes('Choose a value'));

  // A decision the host applied leaves the mailbox; one it never got is offered again.
  const clickApprove=async action=>page.evaluate(action=>{
   const block=Array.from(document.querySelectorAll('#mailbox-test div')).find(e=>e.querySelector('p')?.textContent===action);
   Array.from(block.querySelectorAll('button')).find(e=>e.textContent==='chat.approve').click();
  },action);
  await clickApprove('write-answered');
  await page.waitForFunction(()=>!document.body.innerText.includes('write-answered'));
  assert.equal(await page.evaluate(()=>document.body.innerText.includes('chat.decisionUnconfirmed')),false);
  await clickApprove('write-kept');
  await page.waitForFunction(()=>document.body.innerText.includes('chat.decisionUnconfirmed'));
  assert.equal(await page.evaluate(()=>Array.from(document.querySelectorAll('#mailbox-test button')).find(e=>e.textContent==='chat.approve').disabled),false);
 }finally{await browser.close();await source.close()}
});

test('a tool approval with a lost reply shows a check, then re-enables only while still pending', {timeout:40000},async()=>{
 const source=await startSourceServer();const browser=await launchBrowser();
 try{
  const page=await browser.newPage();await page.goto(source.origin);
  await page.evaluate(async()=>{
   const R=await import('/node_modules/.vite/deps/react.js');const React=R.default??R;
   const D=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=D.default??D;
   const {default:ChatToolApprovalActions}=await import('/src/components/ChatToolApprovalActions.tsx');
   const {InteractionVerifyContext}=await import('/src/components/InteractionVerification.ts');
   let finishCheck;window.finishCheck=()=>finishCheck();
   const verify=()=>new Promise(resolve=>{finishCheck=resolve;});
   const tool={id:'tool-1',name:'Write',status:'pending_confirmation',tool_input:{path:'/a'}};
   const onApprove=()=>Promise.reject(new Error('Relay connection changed; delivery outcome is unknown'));
   document.body.innerHTML='<div id="approval-test"></div>';
   createRoot(document.querySelector('#approval-test')).render(React.createElement(InteractionVerifyContext.Provider,{value:verify},
     React.createElement(ChatToolApprovalActions,{tool,onApprove,onReject:onApprove})));
  });
  await page.click('.chat-tool-approval__button--approve');
  await page.waitForFunction(()=>document.body.innerText.includes('chat.decisionChecking'));
  assert.equal(await page.evaluate(()=>document.querySelector('.chat-tool-approval__button--approve').disabled),true,'no second decision while checking');
  assert.equal(await page.evaluate(()=>document.body.innerText.includes('chat.approvalFailed')),false,'a lost reply is not reported as a failure');
  await page.evaluate(()=>window.finishCheck());
  await page.waitForFunction(()=>document.body.innerText.includes('chat.decisionUnconfirmed'));
  assert.equal(await page.evaluate(()=>document.querySelector('.chat-tool-approval__button--approve').disabled),false);
 }finally{await browser.close();await source.close()}
});
