import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Event = {type:'ready'|'resync'} | {type:'input';data:string} | {type:'resize';cols:number;rows:number};
type Theme = {background:string;foreground:string;cursor?:string};
type Frame = {epoch:string;revision:number;reset:boolean;data:string;theme?:Theme};
declare global { interface Window {
  OpenBitFunTerminalHost?:{postMessage:(message:string)=>void};
  webkit?:{messageHandlers?:{openbitfunTerminal?:{postMessage:(event:Event)=>void}}};
  OpenBitFunTerminal:{connect:()=>void;setTheme:(theme:Theme)=>void;accept:(frame:Frame)=>void};
} }
const terminal = new Terminal({cursorBlink:true,scrollback:5000,convertEol:false,fontSize:14});
const fit = new FitAddon();terminal.loadAddon(fit);terminal.open(document.getElementById('terminal')!);
// xterm focuses on mousedown, which mobile WebViews need not synthesize for
// touch. Focus synchronously on a tap so the OS can open its keyboard, while
// leaving scrolling, selection and multi-touch gestures to xterm/the WebView.
const surface = document.getElementById('terminal')!;
let tap: {id:number;x:number;y:number;started:number} | undefined;
surface.addEventListener('touchstart', event => {
  const touch = event.touches[0];
  tap = event.touches.length === 1
    ? {id:touch.identifier,x:touch.clientX,y:touch.clientY,started:event.timeStamp}
    : undefined;
}, {passive:true});
surface.addEventListener('touchmove', event => {
  const touch = Array.from(event.touches).find(touch => touch.identifier === tap?.id);
  if (!touch || !tap || Math.hypot(touch.clientX-tap.x,touch.clientY-tap.y) > 10) tap = undefined;
}, {passive:true});
surface.addEventListener('touchcancel', () => { tap = undefined; }, {passive:true});
surface.addEventListener('touchend', event => {
  const ended = tap;
  tap = undefined;
  if (ended && event.touches.length === 0 && event.timeStamp-ended.started < 500 &&
      Array.from(event.changedTouches).some(touch => touch.identifier === ended.id &&
        Math.hypot(touch.clientX-ended.x,touch.clientY-ended.y) <= 10)) terminal.focus();
}, {passive:true});
function applyTheme(theme:Theme) {
  terminal.options.theme=theme;
  surface.style.backgroundColor=theme.background;
}
let epoch='';let revision=-1;
const pending: Frame[]=[];let writing=false;
function drain(){
  if(writing||!pending.length)return;
  const frame=pending.shift()!;writing=true;
  if(frame.reset)terminal.reset();if(frame.theme)applyTheme(frame.theme);
  terminal.write(frame.data,()=>{writing=false;drain();});
}
function send(event:Event) {
  if(window.OpenBitFunTerminalHost)window.OpenBitFunTerminalHost.postMessage(JSON.stringify(event));
  else window.webkit?.messageHandlers?.openbitfunTerminal?.postMessage(event);
}
terminal.onData(data=>send({type:'input',data}));
terminal.onResize(({cols,rows})=>send({type:'resize',cols,rows}));
new ResizeObserver(()=>fit.fit()).observe(document.getElementById('terminal')!);
window.OpenBitFunTerminal={
  setTheme:applyTheme,
  connect(){fit.fit();send({type:'ready'});send({type:'resize',cols:terminal.cols,rows:terminal.rows});},
  accept(frame){
    if(typeof frame.epoch!=='string'||!Number.isSafeInteger(frame.revision)||typeof frame.data!=='string')return;
    if(frame.epoch!==epoch){if(!frame.reset){send({type:'resync'});return;}epoch=frame.epoch;revision=-1;}
    if(frame.revision<=revision)return;
    if(!frame.reset&&frame.revision!==revision+1){send({type:'resync'});return;}
    pending.push(frame);revision=frame.revision;drain();
  },
};
window.OpenBitFunTerminal.connect();
