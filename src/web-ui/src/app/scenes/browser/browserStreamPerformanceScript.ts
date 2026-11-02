/**
 * Injected into browser webviews to reduce composition cost for realtime
 * canvas/video preview pages. It is intentionally conservative and only
 * activates for pages that look like OpenBitFun's Harmony device preview stream.
 */
export const STREAM_RENDER_OPTIMIZATION_SCRIPT = /* js */ `(function(){
  if(window.__openbitfun_stream_render_optimized){return;}

  function looksLikeDeviceStream(){
    if(document.getElementById('screen')&&document.getElementById('stage')){return true;}
    if(document.title&&/harmony.*preview|device.*preview/i.test(document.title)){return true;}
    return false;
  }

  function optimize(){
    if(!looksLikeDeviceStream()){return;}
    window.__openbitfun_stream_render_optimized=true;

    var style=document.getElementById('openbitfun-stream-render-optimization');
    if(!style){
      style=document.createElement('style');
      style.id='openbitfun-stream-render-optimization';
      style.textContent=[
        'header{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important;}',
        '#screenFrame{box-shadow:none!important;}',
        '#screen{box-shadow:none!important;outline:none!important;transform:translateZ(0);will-change:transform;contain:paint;}'
      ].join('\\n');
      document.documentElement.appendChild(style);
    }

    var screen=document.getElementById('screen');
    if(screen){
      screen.style.transform='translateZ(0)';
      screen.style.willChange='transform';
      screen.style.contain='paint';
    }
  }

  optimize();
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',optimize,{once:true});
  }
  window.addEventListener('load',optimize,{once:true});
})()`;
