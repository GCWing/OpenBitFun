export const BROWSER_WEBVIEW_DOCUMENT_READY_EVENT = 'browser-webview-document-ready';

export interface BrowserDocumentReadyPayload {
  label: string;
  sequence: number;
  url: string;
}

/** Reconcile native commit notifications with the current document, including BFCache restores. */
export function createBrowserPageLifecycleScript(label: string, sequence: number): string {
  return /* js */ `(function(){
    if(window.top!==window){return;}
    var state=window.__openbitfun_page_lifecycle;
    if(!state){
      state={label:'',sequence:0,lastReported:null};
      window.__openbitfun_page_lifecycle=state;
      state.report=function(){
        if(document.readyState!=='complete'){return;}
        var internals=window.__TAURI_INTERNALS__;
        if(!internals||typeof internals.invoke!=='function'){return;}
        var payload={label:state.label,sequence:state.sequence,url:location.href};
        var key=JSON.stringify(payload);
        if(state.lastReported===key){return;}
        state.lastReported=key;
        try{
          Promise.resolve(internals.invoke('plugin:event|emit',{
            event:${JSON.stringify(BROWSER_WEBVIEW_DOCUMENT_READY_EVENT)},payload:payload
          })).catch(function(){if(state.lastReported===key){state.lastReported=null;}});
        }catch(error){state.lastReported=null;}
      };
      document.addEventListener('readystatechange',state.report);
      window.addEventListener('load',state.report);
      window.addEventListener('pageshow',state.report);
      window.addEventListener('popstate',state.report);
      window.addEventListener('hashchange',state.report);
    }
    if(state.label===${JSON.stringify(label)}&&state.sequence>${JSON.stringify(sequence)}){return;}
    state.label=${JSON.stringify(label)};
    state.sequence=${JSON.stringify(sequence)};
    // Native Started means document commit on all three desktop engines. A
    // restored document may already be complete before this script executes.
    state.report();
  })()`;
}
