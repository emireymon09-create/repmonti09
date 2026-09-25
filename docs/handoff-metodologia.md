# Handoff — cómo se corre este proyecto con Claude Code

Para quien reciba `amelia_app` y quiera lanzar sesiones idénticas a las que veníamos
corriendo. No describe el producto (eso está en `PROJECT.md`, `CLAUDE.md`, `design.md`)
— describe el **proceso** con el que se construyó, que no vive escrito en ningún otro
lado del repo.

> **Dos correcciones hechas al escribir este archivo (25 sep 2026).** El contenido
> venía dictado; al contrastarlo con el repo aparecieron dos cosas que describían
> una versión vieja del proceso, y se corrigieron en el lugar donde salen, marcadas
> con *(corregido)*. Las dos están en §3 y en §9.

---

## 1. Dos sesiones, dos roles, nunca se mezclan

**Orquestador** (la conversación de chat con Claude — no en el VPS): lee
documentación, decide qué se hace y en qué orden, redacta los mensajes para Claude
Code, revisa lo que Claude Code entrega, y decide. **No ejecuta código ni toca el VPS
directamente.** Su output son mensajes de texto para la otra sesión.

**Claude Code** (sesión de terminal, corriendo en el VPS, dentro de
`~/proyectos/amelia_app`): hace todo lo demás — lee el repo, escribe código, corre
tests, hace commits, hace push. Cada sesión nueva arranca **sin memoria** de las
anteriores — por eso el primer mensaje siempre tiene que alcanzar solo.

---

## 2. Dos mensajes por tarea, siempre

Nunca uno solo.

**Mensaje 1 — contexto + tarea completos.** Asume que la sesión no vio nada antes: qué
leer primero (`CLAUDE.md`, `PROJECT.md`, `design.md` completos — "no asumas nada que no
esté ahí escrito"), qué se hizo antes que sea relevante, y explícitamente qué NO tocar.
Incluye el problema real con evidencia (números, `archivo:línea`, no una descripción
vaga), el alcance, y si la tarea lo amerita, el flujo de 4 roles (§3) desde este mismo
mensaje.

**Mensaje 2 — un `/goal`.** La condición de éxito, específica y verificable: números
concretos ("≤3s", "0 regresiones", "144/144 combinaciones"), nunca "funciona bien".
Siempre con una cláusula de corte ("si tras N rondas el revisor sigue con objeciones,
detené, no pushees, reportá qué falta").

El `/goal` no reemplaza al mensaje 1 — sin él, Claude Code haría una pasada y pararía a
esperar. Con él, sigue solo turno tras turno (evaluado por un modelo chico después de
cada turno) hasta que la condición se cumpla, se juzgue imposible, o falle algo no
recuperable (auth, sin crédito, contexto desbordado, modelo no disponible).

---

## 3. Flujo de 4 roles (para lo no trivial)

Se activa cuando "confiar en una sola pasada" es arriesgado: bugs no triviales, pases
grandes, cualquier cosa sensible a condiciones de carrera. Se pide **explícitamente**
en el mensaje 1 — por default el repo NO usa subagentes.

- **IMPLEMENTADOR** — código y tests. Reporta con números concretos, nunca "listo" a
  secas.
- **AUDITOR** — prueba con un navegador real contra el stack local (`pnpm build` +
  `pnpm start`, o `next dev`, más el Supabase local, con usuarios de prueba
  sembrados). Nunca confía en lo que dice el implementador; lo mide él mismo.
  Contraste sobre elementos reales (color computado + fondos compuestos), no la
  paleta en abstracto. Escenarios reales: dos pestañas/dispositivos a la vez, red que
  se cae a mitad de sesión, respuestas perdidas — no solo el camino feliz. Si algo
  falla, se lo devuelve al implementador con el escenario exacto.

  > *(Corregido el 25 sep 2026.)* El texto que veníamos usando decía "prueba con
  > Playwright real". **En este repo no hay Playwright**: no está en `package.json`
  > ni en `node_modules`, y agregarlo sería una dependencia nueva. Lo que hay es el
  > binario `chrome-headless-shell` cacheado en
  > `~/.cache/ms-playwright/chromium_headless_shell-1223/`, y los pases del 23, 24 y
  > 25 de septiembre lo manejaron con un **driver CDP mínimo escrito para ese pase**
  > sobre el `WebSocket` global de Node, en el scratchpad y sin commitear nada. Si
  > alguna vez se quiere Playwright de verdad, es una decisión de dependencia y se
  > pide; no se asume porque el proceso lo nombre.

- **REVISOR** — el diff completo contra `CLAUDE.md`/`design.md`: convenciones (sin
  hex/px fuera de token, sin queries fuera de `lib/db.ts`, `supabaseAdmin` nunca en
  `'use client'`, sin strings nuevos si ya existe la clave), calidad, y decide el bump
  de versión por semver real. A veces encuentra regresiones que el auditor no vio —
  otro criterio, otra lectura.
- **DOCUMENTADOR** — al final, sin tocar código. Actualiza `CLAUDE.md`, `design.md` y
  `CHANGELOG.md` con lo que se implementó **de verdad** (no lo planeado), con los
  números reales del auditor. Revisa el diff antes de escribir, no confía en su
  memoria de la conversación.

Vueltas atrás las que hagan falta — el pase más largo hasta ahora fueron 6 rondas
completas.

---

## 4. El orquestador de VPS (la sesión de Claude Code que coordina los 4 roles)

Cuando hay 4 roles, alguien tiene que coordinarlos — esa sesión (no la de chat) hace de
orquestador local:

- Revisa cada entrega antes de aceptarla.
- **Nunca delega la verificación final** (`tsc --noEmit`, `lint`, `format:check`,
  `build`, `test:all`) a un agente — la corre él mismo, al final, sobre el resultado
  integrado.
- Confirma si hay migraciones nuevas en `supabase/` antes de pushear. Si las hay, **no
  se pushea** — se documenta qué queda pendiente de aplicar a mano.
- Hace el commit y el push finales, con el bump de versión correcto.

---

## 5. Honestidad por encima de todo — la regla que más importa

- Lo que no se pudo verificar se dice **explícitamente**, nunca se asume arreglado por
  aplicar el fix "correcto en teoría" (ejemplo real: un bug de WebKit que ningún motor
  del VPS reproduce — se manda a probar en el iPhone, no se da por cerrado).
- Nunca se afirma "funciona en iPhone" sin haberlo probado en un iPhone real. Si el
  dueño lo confirma, se documenta **atribuido a él**, no como verificación propia.
- Un hallazgo nuevo investigando algo distinto **siempre se reporta**, aunque esté
  fuera de alcance.
- Nunca se fuerza un arreglo "para que se vea bien" si el resultado real no da — se
  documenta la limitación.
- El tema oscuro no se toca sin permiso explícito.
- Si algo es ambiguo y la doc no da un criterio claro, se pregunta en vez de asumir en
  silencio.

---

## 6. Versionado — semver real, no mecánico

- PATCH: arreglos de bugs, sin funcionalidad nueva visible.
- MINOR: funcionalidad nueva visible pero compatible.
- MAJOR: cambios incompatibles.
- Si se mezclan tipos en un pase, manda el más alto.
- Todo push a `main` lleva versión nueva + entrada en `CHANGELOG.md`, sin excepción.

La unidad es **el push**, no el batch: `CLAUDE.md` §0.1 lo dice con todas las letras
porque una vez se olvidó. `tests/unit/changelog.test.ts` falla si la primera entrada
del CHANGELOG no coincide con `version` de `package.json`.

---

## 7. Reglas fijas del repo

- Solo `pnpm` (nunca npm/yarn) — reforzado por `scripts/only-pnpm.mjs` en
  `preinstall`.
- Nunca tocar `~/proyectos/fruco-erp` (otro proyecto en el mismo VPS) — ni para copiar
  patrones.
- Capturas y scripts de prueba solo en el scratchpad, nunca commiteados.
- Sin subagentes por default — solo si el prompt de esa sesión los pide.
- Verificación completa antes de cerrar cualquier pase: `pnpm exec tsc --noEmit`,
  `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm test:all`.
- Borrado lógico (`voided_at`), nunca `DELETE`, en todas las tablas que lo soportan.
- La app escucha **sólo** en `127.0.0.1`, y desde el 25 sep 2026 eso lo fuerza
  `scripts/next-loopback.mjs` en vez de depender de que alguien se acuerde del flag.

---

## 8. `output.txt`

Cada pase termina con una sección nueva al final (nunca se sobreescribe lo anterior),
con el detalle real de qué pasó — mediciones, causas, qué NO se pudo verificar. Es el
historial que le permite a la siguiente sesión (sin memoria) entender el proyecto sin
releer todo el código.

> **Ojo, y es una contradicción real del repo, no una interpretación.**
> `.claude/CLAUDE.md` (local a este servidor, no commiteado) manda vaciar
> `output.txt` al empezar cada sesión; `docs/seguridad-operacional.md` §9 ya dejó
> anotado que por eso "cada pase borra el registro del anterior", y que lo que valga
> para la próxima vez **va en `docs/`, no ahí**. Los prompts que dicen "agregá una
> sección, nunca sobreescribas" ganan sobre esa regla local cuando lo dicen
> explícitamente. Si no lo dicen, asumí que `output.txt` arranca vacío y no cuentes
> con que la sesión siguiente lo lea.

---

## 9. Cómo replicar esto en otra máquina

1. Instalar Claude Code (CLI) y autenticarlo.
2. Clonar el repo, `corepack enable`, `pnpm install`.
3. Leer, en este orden, antes de tocar nada: `CLAUDE.md`, `PROJECT.md`, `design.md`, y
   todo `docs/*.md`. *(Corregido el 25 sep 2026: la lista que veníamos usando nombraba
   tres archivos y hoy son siete.* `manual-buenas-practicas.md`,
   `checklist-cada-cambio.md`, `seguridad-operacional.md`, `prompt-auditoria-codigo.md`,
   `aplicar-en-la-nube.md`, `aplicar-en-la-nube-0012.md` *y este archivo; el índice
   vive en* `docs/README.md`.*)*
4. Levantar el stack local: `pnpm db:up` (Supabase local, bindeado a `127.0.0.1` — ver
   `docs/seguridad-operacional.md` §6).
5. Para cualquier tarea nueva: redactar el mensaje 1 (contexto + tarea, formato de
   arriba) y el mensaje 2 (`/goal` con condición verificable) antes de mandarlos. No
   saltarse el mensaje 1 aunque la tarea parezca chica.
6. Si la tarea es sensible (schema, condiciones de carrera, UI en varias pantallas):
   pedir el flujo de 4 roles explícitamente en el mensaje 1.
7. Antes de un handoff o de un deploy: correr `docs/prompt-auditoria-codigo.md`
   (audita seguridad/código) y este mismo tipo de pase de handoff total (audita qué
   información falta o no está verificada) — son pases distintos, con objetivos
   distintos.

---

## 10. Estado al cierre de este pase (25 sep 2026)

**Versión resultante: `0.10.3`.** El pase entero —los tres arreglos que ya estaban
hechos y sin commitear (v0.10.1), el blindaje del bind que vino de la sesión paralela
(v0.10.2, ya commiteado) y los dos arreglos nuevos (v0.10.3)— es **PATCH**: son cinco
arreglos de defectos y **ninguna funcionalidad nueva visible**. Que un botón pase de
18 a 44 px de alto se ve, pero es la corrección de un target táctil que violaba el
piso que `design.md` §1 ya exigía, no una función nueva.

**Parte 1 — lo que estaba pendiente del pase v0.10.1.**

- **1.1, los tres archivos de seguridad.** Al empezar este pase **ya estaban
  commiteados**: la sesión paralela los cerró en `c8cb674` ("Keep the server from ever
  listening outside 127.0.0.1, whatever command starts it"), junto con
  `docs/seguridad-operacional.md`, `CLAUDE.md`, `CHANGELOG.md` y `package.json`
  (0.10.2). Así que no hubo commit nuevo que hacer; lo que sí se hizo, y era el punto,
  es **leerlos enteros y verificarlos línea por línea**. Resultado: hacen exactamente
  lo que dicen sus comentarios, sin red saliente, sin escribir fuera del repo y sin
  ejecución arbitraria. El detalle, con citas de línea, está en el §19 del informe de
  handoff.
- **1.2, targets táctiles.** Token nuevo `--tap-min: 44px`. Medido antes y después en
  144 combinaciones: controles por debajo de 44 px **11 distintos → 0**.
- **1.3, `/pumping` a 1440 en español.** Desborde interno de la fila de lados
  **24 px → 0**, sin tocar `.row`.
- **1.4, documentación.** `CLAUDE.md` §6, `design.md` §5.19 y §8, `CHANGELOG.md`
  (`[0.10.3]`), `package.json`, y una sección nueva al final de `output.txt`.

**Parte 2 — este archivo.** Creado con dos correcciones al contenido dictado (§3 y
§9), marcadas en el lugar donde salen.

**Parte 3 — `docs/handoff-2026-09-25.md`.** Auditoría de handoff en 19 secciones, cada
afirmación etiquetada `CONFIRMADO POR TEST` / `CONFIRMADO POR LECTURA` /
`NO VERIFICADO`, y una "Lista maestra de lo que no se sabe" al final, ordenada por
impacto.

**Parte 4 — verificación.** `tsc --noEmit`, `lint`, `format:check`, `build` y
`test:all` (unit × 4 TZ + integración con Docker arriba) corridos sobre el resultado
integrado; las salidas reales están pegadas en `output.txt`.

**Qué quedó abierto al cierre.** La lista completa y ordenada por impacto está en
`docs/handoff-2026-09-25.md`. Lo más grande:

- **El aviso push sigue sin llegar solo.** `0011` y `0012` no están aplicadas en el
  proyecto Supabase de la nube y desde este VPS no hay credenciales para hacerlo —
  `docs/aplicar-en-la-nube.md` y `docs/aplicar-en-la-nube-0012.md`.
- **`pnpm audit` devuelve 35 avisos (3 críticos, 12 altos)**, casi todos de Next 14,
  cuya corrección es Next 15. Nunca se decidió qué hacer con eso.
- **La barra de abajo al arrancar en frío sigue sin confirmar en un iPhone real**
  (v0.10.1): ningún motor de este VPS reproduce el bug de WebKit.
- **No hay backup de ninguna de las dos bases de Amelia**, ni local ni de la nube.
