// Sin 'use client' a propósito: app/layout.tsx (server) necesita el string,
// no una referencia de cliente. Mismo patrón que lib/viewportBoot.ts.

/**
 * PANEL DE DIAGNÓSTICO DEL VIEWPORT — TEMPORAL, RAMA `diagnostico-viewport`.
 *
 * NO ES UN ARREGLO. Es un instrumento. Existe porque tres intentos de arreglar
 * "la barra de abajo nace elevada en el iPhone" fallaron (design.md §5.11,
 * §5.18a y §5.20), y el cuarto no se hace a ciegas: primero hay que ver qué
 * mide ese teléfono, en ese instante, con sus propios números.
 *
 * QUÉ PREGUNTA CONTESTA. La hipótesis viva es que `window.innerHeight` sufre
 * lo mismo que sufría el CSS: WebKit no lo asienta hasta que la barra de
 * Safari termina de animarse al cargar, y ninguno de los eventos que escucha
 * lib/viewportBoot.ts (`resize`, `orientationchange`, `pageshow`,
 * `visualViewport.resize`) dispara en ese momento — pero un gesto de scroll sí
 * lo corrige. Y la hipótesis alternativa del dueño: que lo que corrige no es
 * el scroll sino algún reajuste posterior que simplemente COINCIDE con él.
 *
 * Las dos se distinguen con un solo dato: el instante y el disparador de cada
 * cambio. Por eso cada muestra lleva `t` (ms desde que corrió este script) y
 * la etiqueta del evento. Y por eso hay un muestreo `poll` cada 100 ms: si
 * `innerHeight` o `--vh-full` cambian SIN que haya disparado ningún evento, la
 * muestra queda etiquetada `poll` y la hipótesis del dueño queda demostrada.
 * Sin ese muestreo, un cambio silencioso sería invisible y el scroll se
 * llevaría un crédito que no le toca.
 *
 * `scroll` se escucha ACÁ y sólo acá: lib/viewportBoot.ts NO lo escucha y este
 * archivo no lo cambia. Está en la lista porque el reporte dice que el scroll
 * corrige la barra, así que su timestamp es justamente el dato a cruzar.
 *
 * COSTO PARA QUIEN NO LO PRENDE: dos lecturas baratas y sale. Sin listeners,
 * sin timers, sin un solo nodo en el DOM. La medición está en output.txt.
 *
 * CÓMO SE PRENDE:
 *   ?debug=viewport   lo prende y lo DEJA prendido (localStorage
 *                     `amelia:debug`), para que el próximo arranque —el de la
 *                     app instalada, donde no hay barra de direcciones— quede
 *                     instrumentado desde el primer milisegundo.
 *   ?debug=off        lo apaga y borra la marca.
 *   el botón ×        lo mismo que ?debug=off, desde adentro del panel.
 *
 * El panel es `position: fixed` y cuelga de <body>, fuera de `.page`: no está
 * en el flujo, así que no puede mover la barra que viene a medir. Está
 * comprobado midiendo el barrido con el panel puesto.
 *
 * Inglés a propósito, y sin pasar por lib/i18n (§5.7): es un instrumento para
 * una sola persona en una rama que no se mergea, no texto de la app. Los px y
 * los colores tampoco salen de app/globals.css por el mismo motivo. Las dos
 * excepciones están declaradas en output.txt y en docs/diagnostico-viewport.md.
 */
export const VIEWPORT_DEBUG_KEY = 'amelia:debug'

export const VIEWPORT_DEBUG_SCRIPT = `(function(){try{
var q=location.search.indexOf('debug=viewport')>-1,off=location.search.indexOf('debug=off')>-1;
if(off){try{localStorage.removeItem('${VIEWPORT_DEBUG_KEY}')}catch(e){}return}
var on=q;if(!on){try{on=localStorage.getItem('${VIEWPORT_DEBUG_KEY}')==='viewport'}catch(e){}}
if(!on)return;
if(q){try{localStorage.setItem('${VIEWPORT_DEBUG_KEY}','viewport')}catch(e){}}

var t0=Date.now(),L=[],MAX=60,el=null,body=null,last=null;
function css(){return getComputedStyle(document.documentElement).getPropertyValue('--vh-full').trim()||'(unset)'}
function pageM(){var p=document.querySelector('.page');return p?getComputedStyle(p).minHeight:'(no .page)'}
function navB(){var n=document.querySelector('nav.nav');return n?+n.getBoundingClientRect().bottom.toFixed(1):null}
function sample(what){
  var vv=window.visualViewport,nb=navB();
  var s={t:Date.now()-t0,w:what,ih:window.innerHeight,
    vv:vv?+vv.height.toFixed(1):null,vt:vv?+vv.offsetTop.toFixed(1):null,
    vh:css(),mh:pageM(),nb:nb,gap:nb===null?null:+(window.innerHeight-nb).toFixed(1),
    sy:Math.round(window.scrollY)};
  var k=s.ih+'|'+s.vv+'|'+s.vh+'|'+s.mh+'|'+s.gap;
  s.same=(k===last);last=k;
  L.push(s);if(L.length>MAX)L.shift();
  render();
}
function row(s){
  return '<tr'+(s.same?' class="d">':' class="c">')+
    '<td>'+s.t+'</td><td>'+s.w+'</td><td>'+s.ih+'</td><td>'+(s.vv===null?'-':s.vv)+
    '</td><td>'+s.vh+'</td><td>'+s.mh+'</td><td>'+(s.gap===null?'-':s.gap)+'</td><td>'+s.sy+'</td></tr>';
}
function render(){
  if(!el){
    body=document.body;if(!body)return;
    el=document.createElement('div');el.id='vh-debug';
    el.innerHTML='<style>#vh-debug{position:fixed;top:0;left:0;right:0;z-index:2147483647;'+
      'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(0,0,0,.86);color:#e8e8e8;'+
      'max-height:52vh;overflow:auto;-webkit-overflow-scrolling:touch;padding:4px 6px;'+
      'box-shadow:0 1px 0 rgba(255,255,255,.25)}'+
      '#vh-debug h4{margin:0 0 3px;font-size:11px;font-weight:600;color:#ffd479}'+
      '#vh-debug table{border-collapse:collapse;width:100%}'+
      '#vh-debug th{text-align:right;color:#8ab4f8;font-weight:600;padding:0 3px;position:sticky;top:0;background:#000}'+
      '#vh-debug td{text-align:right;padding:0 3px;white-space:nowrap}'+
      '#vh-debug td:nth-child(2){text-align:left;color:#9be09b}'+
      '#vh-debug tr.d td{color:#777}'+
      '#vh-debug button{position:absolute;top:2px;right:4px;font:inherit;background:#333;color:#fff;'+
      'border:1px solid #666;border-radius:3px;padding:1px 7px}</style>'+
      '<h4></h4><button type="button">x</button><table><thead><tr>'+
      '<th>t ms</th><th>event</th><th>innerH</th><th>visualH</th><th>--vh-full</th>'+
      '<th>min-height</th><th>gap</th><th>scrollY</th></tr></thead><tbody></tbody></table>';
    body.appendChild(el);
    el.querySelector('button').addEventListener('click',function(){
      try{localStorage.removeItem('${VIEWPORT_DEBUG_KEY}')}catch(e){}
      el.parentNode.removeChild(el);el=null;});
  }
  var sa=false;try{sa=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true}catch(e){}
  el.querySelector('h4').textContent='viewport debug — standalone:'+(sa?'YES':'no')+
    ' screen:'+screen.width+'x'+screen.height+' dpr:'+devicePixelRatio+' samples:'+L.length;
  var t='';for(var i=0;i<L.length;i++)t+=row(L[i]);
  el.querySelector('tbody').innerHTML=t;
}
function on_(target,name,label){target.addEventListener(name,function(){sample(label)},{passive:true})}
sample('script');
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){sample('domready')});
on_(window,'load','load');
on_(window,'resize','resize');
on_(window,'orientationchange','orientationchange');
on_(window,'pageshow','pageshow');
on_(window,'scroll','scroll');
on_(window,'focusin','focusin');
on_(window,'focusout','focusout');
if(window.visualViewport){on_(visualViewport,'resize','vv.resize');on_(visualViewport,'scroll','vv.scroll')}
var n=0,iv=setInterval(function(){
  n++;if(n>600){clearInterval(iv);return}
  var k=window.innerHeight+'|'+(window.visualViewport?+visualViewport.height.toFixed(1):null)+'|'+css()+'|'+pageM()+'|'+
    (navB()===null?null:+(window.innerHeight-navB()).toFixed(1));
  if(k!==last)sample('poll');
},100);
}catch(e){}})()`
