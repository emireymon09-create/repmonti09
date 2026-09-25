# Panel de diagnóstico del viewport — cómo prenderlo y qué mirar

**Rama `diagnostico-viewport`. No se mergea a `main`.** Esto no es un arreglo:
es un instrumento para sacarle al iPhone los números que este VPS no puede
medir. Cuando conteste la pregunta, la rama se borra.

---

## 1. Por qué existe

La barra de abajo nace elevada en el iPhone de Luis y un gesto de scroll la
acomoda. Se intentó arreglar **tres veces** y las tres fallaron:

| Intento | Qué hizo | Por qué no alcanzó |
|---|---|---|
| `design.md` §5.11 | `fixed` → `sticky` | cerró otro síntoma (la barra flotando a mitad del scroll), no éste |
| §5.18a (v0.10.1) | `100dvh` → `100%` + `html,body{height:100%}` | el `100%` encadenado a `html` se resuelve contra **el mismo viewport** que lee el `dvh`: cambió la unidad, no la dependencia |
| §5.20 (v0.10.4) | dejar de predecir el alto y **medirlo** con `window.innerHeight` (`lib/viewportBoot.ts`) | el síntoma **volvió** según el reporte de Luis |

Que el tercero no alcanzara es el dato importante: si medir `innerHeight` antes
del primer pintado tampoco cierra el caso, entonces **ese número también llega
tarde**, igual que llegaba tarde el `dvh`. Pero eso es una hipótesis, y ya se
gastaron tres intentos en hipótesis. Un cuarto arreglo a ciegas no se hace.

**Las dos hipótesis vivas, que este panel distingue:**

- **H1 — el valor llega tarde.** WebKit no asienta `innerHeight` hasta que la
  barra de Safari termina de animarse al cargar, y ninguno de los eventos que
  escucha `lib/viewportBoot.ts` (`resize`, `orientationchange`, `pageshow`,
  `visualViewport.resize`) dispara en ese instante. El scroll lo corrige porque
  el gesto sí dispara alguno de ellos.
- **H2 (la del dueño) — no es el scroll.** Después de la carga hay algún paso
  de verificación o reajuste posterior que corrige el layout, y ese reajuste
  simplemente **coincide** con el momento en que uno scrollea.

Las dos se separan con un solo dato: **el instante y el disparador de cada
cambio.** Eso es lo que el panel registra.

---

## 2. Cómo se prende

| Qué querés | Qué hacés |
|---|---|
| Prenderlo | abrí cualquier pantalla con `?debug=viewport` al final de la URL — por ejemplo `https://amelia-app.vercel.app/dashboard?debug=viewport` |
| Dejarlo prendido | ya queda: `?debug=viewport` además guarda la marca en este navegador (`localStorage`, clave `amelia:debug`), así el **próximo arranque** queda instrumentado desde el primer milisegundo |
| Apagarlo | el botón **×** arriba a la derecha del panel, o `?debug=off` |

**Sin la bandera el script no hace absolutamente nada**: no engancha un solo
listener, no crea un solo nodo, no arranca un solo timer. Son dos lecturas y
sale. Está medido (§5).

### 2.1 El caso de la app instalada (que es el del reporte)

La app instalada desde la pantalla de inicio **no tiene barra de direcciones**,
así que ahí no hay dónde escribir `?debug=viewport`. Por eso la bandera se
guarda: la idea es prenderla una vez en **Safari** y que el arranque siguiente
ya nazca instrumentado.

> **Esto no está verificado y puede fallar.** iOS puede darle a la app instalada
> un almacenamiento separado del de Safari; si es así, la marca guardada en
> Safari **no** llega a la app instalada y el panel no va a aparecer ahí.
> Si pasa eso, decímelo: la medición en **Safari** igual sirve, porque la barra
> dinámica de Safari ejercita el mismo camino de WebKit, y es el escenario donde
> el `innerHeight` tardío es *más* probable, no menos.

---

## 3. Qué muestra

Arriba, una línea fija: si está en modo `standalone` (o sea, app instalada),
el tamaño de pantalla, el `devicePixelRatio` y cuántas muestras lleva.

Abajo, una fila por muestra. Las filas donde **nada cambió** salen en gris; las
que **cambiaron algo** salen en blanco. Columnas:

| Columna | Qué es |
|---|---|
| `t ms` | milisegundos desde que corrió el script del `<head>` |
| `event` | qué disparó la muestra (ver abajo) |
| `innerH` | `window.innerHeight` — **el número que `lib/viewportBoot.ts` usa** |
| `visualH` | `visualViewport.height` |
| `--vh-full` | el valor que quedó escrito en la variable CSS |
| `min-height` | el `min-height` **computado** de `.page` |
| `gap` | `innerHeight − nav.bottom`: **el síntoma, en píxeles.** 0 = la barra está pegada al borde; 12 = está 12 px arriba |
| `scrollY` | cuánto se scrolleó |

Disparadores posibles: `script` (la primera muestra, en el `<head>`, antes de
que exista el `<body>` — por eso ahí `min-height` dice `(no .page)`),
`domready`, `load`, `resize`, `orientationchange`, `pageshow`, `scroll`,
`focusin`, `focusout`, `vv.resize`, `vv.scroll`, y **`poll`**.

**`poll` es la fila clave.** Cada 100 ms el panel compara los números con la
última muestra; si algo cambió **sin que haya disparado ningún evento**, anota
la fila como `poll`. `scroll` se escucha **sólo acá** —`lib/viewportBoot.ts` no
lo escucha y este instrumento no lo cambia— justamente para poder cruzar su
timestamp con el resto.

---

## 4. Qué mirar, y qué prueba cada cosa

1. **Abrí la app de cero** (cerrala del todo antes), dejala quieta unos segundos
   **sin tocar la pantalla**, y sacale una foto al panel.
2. **Recién ahí** hacé el gesto de scroll que corrige la barra, y sacale otra.

Lo que dice cada resultado:

| Lo que ves | Qué significa |
|---|---|
| `gap` arranca > 0 y `innerH` **cambia** en alguna fila posterior | **H1 confirmada**: el valor llegó tarde. La fila que lo corrigió dice **qué evento** hay que escuchar (y si dice `poll`, ninguno de los que existen sirve) |
| `gap` arranca > 0, `innerH` **nunca cambia**, pero `min-height` o `gap` sí | el problema no es la medición: es que WebKit no vuelve a hacer el layout con el valor bueno |
| la fila que corrige el `gap` es `poll`, y su `t` es **anterior** al `scroll` | **H2 confirmada**: se arregló solo y el scroll llegó después |
| la fila que corrige el `gap` es `scroll` (o `vv.resize` con el mismo `t`) | el gesto es la causa, no una coincidencia |
| `gap` es 0 en todas las filas y la barra igual se ve elevada | el `gap` medido no es el síntoma: es otra cosa (un `safe-area-inset`, la barra de gestos del sistema) y hay que mirar por otro lado |

Con cualquiera de esas cinco respuestas el cuarto intento deja de ser a ciegas.

---

## 5. Lo que se verificó de este instrumento (25 sep 2026)

Medido con `chrome-headless-shell` por CDP contra `pnpm build` + `pnpm start`,
Supabase local:

| Qué | Resultado |
|---|---|
| **A/B controlado, mismo dato, con y sin el script** (132 combinaciones: 11 pantallas × 3 anchos × 2 temas × 2 idiomas) | **0 campos distintos sobre 1848 comparaciones** |
| Bundle JS de la app | **sin cambio**: 102 kB compartidos, `/dashboard` 4,99 kB / 204 kB, middleware 93,8 kB — idénticos, porque el script va inline en el `<head>`, no al bundle |
| Peso que sí agrega | **4297 bytes** de HTML inline por página, sin comprimir |
| Sin la bandera | 0 nodos en el DOM (`body.children` 16 con y sin), `localStorage['amelia:debug']` `null`, panel ausente |
| Con la bandera | panel presente, `position: fixed`, **1 solo nodo extra** en `<body>`, y `docH`/`pageH`/`min-height`/`--vh-full`/`nav.bottom`/`gap`/scroll horizontal **idénticos** a la carga sin bandera |
| `?debug=off` y el botón × | panel fuera, marca borrada, layout otra vez idéntico |
| El registro funciona | `scroll` queda anotado con su `scrollY`; y cambiando `--vh-full` a mano **sin disparar ningún evento** aparece la fila `poll` a los 2801 ms con el valor nuevo |
| `tsc` / `lint` / `format:check` / `build` / `test:all` | todo en verde |

**Lo que NO se puede afirmar desde acá:** que el panel se vea bien en un iPhone,
y —otra vez— que el síntoma exista o no exista, porque Chromium no reproduce el
bug de WebKit y `display-mode: standalone` no se puede emular en
`chrome-headless-shell`. Lo medido dice que el instrumento **no altera lo que
viene a medir**; no dice nada sobre el síntoma.

---

## 6. Dos reglas del proyecto que este archivo rompe a propósito

Las dos están declaradas acá y en `output.txt`, y las dos valen **sólo** porque
esta rama no se mergea:

- **§5.7 — todo texto visible pasa por `lib/i18n/`.** El panel está en inglés y
  no pasa por los diccionarios. Es un instrumento para una persona; meterle
  quince claves a `en.ts` y `es.ts` para algo que se va a borrar sería peor.
- **`design.md` — ningún hex ni px fuera de `app/globals.css`.** El panel trae
  los suyos. No es UI de la app: es un osciloscopio pegado encima.

Si alguna vez esto tuviera que quedarse, las dos hay que arreglarlas primero.
