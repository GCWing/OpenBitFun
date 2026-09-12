import { RemoteI18n } from '../i18n/RemoteI18n';

/** Trusted wrapper and untrusted H5 are separate browsing contexts. */
export class MiniAppDocument {
  static build(html: string, locale: string): string {
    const language = JSON.stringify(locale).replace(/</g, '\\u003c');
    const localized = html.replace('<head>', `<head><script>window.__miniappLocale=${language};</script>`);
    const source = JSON.stringify(localized).replace(/</g, '\\u003c');
    const timeout = JSON.stringify(RemoteI18n.t('miniapp.timeout'));
    const unsupported = JSON.stringify(RemoteI18n.t('miniapp.unsupported'));
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src blob:; base-uri 'none'; form-action 'none'">
<style>:root{color-scheme:light dark}html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style>
</head><body><iframe sandbox="allow-scripts" title="MiniApp"></iframe><script>
(()=>{
const frame=document.querySelector('iframe');
const pending=new Map();
window.__miniappReply=(reply)=>{if(!pending.has(reply.id))return;clearTimeout(pending.get(reply.id));pending.delete(reply.id);frame.contentWindow.postMessage(reply,'*');};
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow)return;
 const data=event.data;
 if(!data||typeof data!=='object')return;
 if(data.method==='openbitfun/request-locale'){
   frame.contentWindow.postMessage({type:'openbitfun:event',event:'localeChange',payload:{locale:${language},unsupported:${unsupported}}},'*');return;
 }
 if(typeof data.id!=='string'||typeof data.method!=='string'||pending.has(data.id))return;
 const replyError=message=>window.__miniappReply({jsonrpc:'2.0',id:data.id,error:{message}});
 pending.set(data.id,setTimeout(()=>replyError(${timeout}),10000));
 if(!['storage.get','storage.set','clipboard.writeText'].includes(data.method)){replyError(${unsupported});return;}
 try{miniappNative.request(JSON.stringify({id:data.id,method:data.method,params:data.params}));}
 catch(error){replyError(String(error));}
});
const url=URL.createObjectURL(new Blob([${source}],{type:'text/html'}));
frame.src=url;
frame.addEventListener('load',()=>frame.contentWindow.postMessage({type:'openbitfun:event',event:'activate',payload:{}},'*'));
})();
</script></body></html>`;
  }
}
