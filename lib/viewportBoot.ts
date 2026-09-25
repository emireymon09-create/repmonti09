// Sin 'use client' a propósito: app/layout.tsx (server) necesita el string,
// no una referencia de cliente. Mismo patrón que lib/themeBoot.ts y
// lib/i18n/boot.ts.

export const VIEWPORT_VAR = '--vh-full'

/**
 * Escribe el alto REAL de la ventana en `--vh-full`, en píxeles.
 *
 * Por qué existe (25 sep 2026, tercer intento sobre el mismo síntoma). La
 * barra de abajo es `sticky` y llega al borde porque `.page` llega al borde:
 * su `min-height` es el alto de la ventana. Ese alto se escribió primero como
 * `100dvh` y después como `100%` (con `html, body { height: 100% }`), y **las
 * dos veces la barra siguió naciendo elevada en un iPhone**. No es casualidad:
 * un porcentaje sobre html/body se resuelve contra el bloque contenedor
 * inicial, que es el MISMO viewport que lee `dvh`. Cambió la unidad, no la
 * dependencia — las dos preguntan "¿cuánto mide la ventana?" en el momento en
 * que WebKit todavía no lo tiene asentado, y un valor N píxeles corto pone la
 * barra N píxeles arriba (medido, sensibilidad exacta 1:1).
 *
 * Así que este script no PREDICE el alto con una unidad: lo MIDE, y lo vuelve
 * a medir cada vez que la ventana cambia. Corre en <head> antes del primer
 * pintado, así que `--vh-full` ya es píxeles en el primer layout.
 *
 * Se lee `window.innerHeight` —el viewport de layout— y no
 * `visualViewport.height`, porque en iOS el teclado achica el visual pero no
 * el de layout, y la barra tiene que quedar en el borde de la PANTALLA, no
 * arriba del teclado.
 *
 * Y aun así no se actualiza mientras hay un campo con foco: en Android Chrome
 * el teclado **sí** achica el viewport de layout, o sea `innerHeight`. Sin
 * este guard, abrir el teclado para cargar una toma achicaría `--vh-full` y la
 * barra treparía por encima del contenido mientras se tipea. La medición que
 * quedó pendiente se aplica al salir del campo (`focusout`, en un tick
 * diferido para no contar el salto de un campo al siguiente como "ya no
 * estoy tipeando").
 *
 * Si el JavaScript nunca llega, `--vh-full` se queda en el `100dvh` (o el
 * `100vh`) que define app/globals.css, que es el comportamiento anterior.
 */
export const VIEWPORT_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,p=false;
function k(){var a=document.activeElement;if(!a)return false;var t=a.tagName;
return t==='INPUT'||t==='TEXTAREA'||t==='SELECT'||a.isContentEditable===true}
function s(){if(k()){p=true;return}p=false;d.style.setProperty('${VIEWPORT_VAR}',window.innerHeight+'px')}
function l(){setTimeout(function(){if(p)s()},0)}
s();addEventListener('resize',s);addEventListener('orientationchange',s);
addEventListener('pageshow',s);addEventListener('focusout',l);
if(window.visualViewport)visualViewport.addEventListener('resize',s)}catch(e){}})()`
