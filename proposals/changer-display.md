# Propuesta — pantalla táctil del cambiador (ESP32)

**Estado: PROPUESTA. Nada de esto está aplicado.** Emilio pidió el 5 oct 2026
escribir el diseño antes de tocar código o schema (CLAUDE.md §5.2: un cambio de
schema se propone primero). La migración de §3 va **sin numerar** a propósito.

Todo lo que dice "existe" acá se verificó contra el código de `main` en
`9824e26` + el commit de History (v0.11.0). Lo que no se pudo verificar está
marcado como tal.

---

## 1. Qué es

Una pantalla de 2,8" montada **vertical** en el costado del mueble del cambiador
de Amelia (donde también está el calentador de biberones). Es un control remoto
de la app, no una app aparte: lo que se toca ahí aparece en los dos teléfonos y
en History, y lo que se registra desde el teléfono aparece ahí.

Primera versión, la que pidió Emilio:

```
┌──────────────────────┐
│ Lactancia · izq       │   ← estado: qué corre y desde cuándo
│ 12 min                │
│ Último pañal: 1 h 40  │
├──────────────────────┤
│  [ Izq ]   [ Der ]    │   ← lactancia: arranca / corta / cambia de lado
├──────────────────────┤
│ [Mojado] [Sucio]      │   ← pañal: un toque = un registro
│      [ Ambos ]        │
└──────────────────────┘
```

**Queda para después:** la receta de leche (pantalla aparte), y la carcasa
impresa (Bambu) para los agujeros M6 del costado del mueble — no depende de
nada de acá.

---

## 2. Qué ya existe y qué falta

| Pieza | Estado | Dónde |
|---|---|---|
| Arrancar / cortar / cambiar lactancia desde un dispositivo | **Existe** | `POST /api/quick/nurse`, scope `quick_nurse` |
| Tokens por dispositivo (hash, scope, clavado a un bebé, revocables) | **Existe** | `device_tokens` (0007), `lib/deviceAuth.ts`, `pnpm device-token` |
| Registrar un pañal desde un dispositivo | **Falta** | — |
| Que un dispositivo **lea** el estado (qué corre, último pañal) | **Falta** | Hoy ningún endpoint de dispositivo lee nada: los tres escriben |
| Cuándo vence la próxima comida | Existe como lógica pura | `lastFeedingEnd` / `nextDue` en `lib/schedule.ts`, umbral en `family_settings` (0012) |

O sea: con un token `quick_nurse` la pantalla ya podría manejar la lactancia
**hoy**, sin cambiar nada del servidor. Los botones de pañal y el estado de
arriba necesitan §3–§5.

---

## 3. Base de datos — dos scopes nuevos

```sql
-- ⚠️ SIN NUMERAR. Cuando Emilio lo apruebe, va con el siguiente número libre
-- (hoy sería 0013) y se aplica A MANO en la nube (CLAUDE.md §2.1).
--
-- Mismo patrón que 0009 con push_check: no hay tabla nueva, solo se amplía la
-- lista de scopes permitidos.
alter table device_tokens drop constraint device_tokens_scopes_check;
alter table device_tokens add constraint device_tokens_scopes_check
  check (
    cardinality(scopes) > 0
    and scopes <@ array['ingest', 'quick_nurse', 'push_check',
                        'quick_diaper', 'read_status']::text[]
  );
```

Y en código, `DEVICE_SCOPES` de `lib/deviceTokens.ts` suma `'quick_diaper'` y
`'read_status'` (el CLI de `pnpm device-token` los acepta solo por eso).

**Por qué dos scopes y no uno "cambiador":** es la regla que ya sigue el repo —
un scope por capacidad, no por aparato. Un Shortcut de iOS que solo registra
pañales no tiene por qué poder leer el estado de la familia, y una pantalla de
solo lectura en otro cuarto no tiene por qué poder escribir.

**Sin tabla nueva ⇒ sin RLS nueva.** `diaper_changes` ya existe con RLS; el
endpoint escribe con `service_role` como `/api/quick/nurse`, y el bebé sale del
token (`resolveBabyForDevice`), nunca del cuerpo sin validar.

---

## 4. `POST /api/quick/diaper`

```
POST /api/quick/diaper
Authorization: Bearer amd_…            (scope quick_diaper)
Body: { "type": "wet" | "dirty" | "both", "id"?: "<uuid>", "baby_id"?: "<uuid>" }

200 { ok: true, action: "logged", id, changed_at, message: "Diaper (wet) — 6:42 PM" }
200 { ok: true, action: "already_logged", id, … }   ← mismo id otra vez
400 tipo inválido / id que no es uuid
401 / 403 / 409 / 429 como los otros endpoints de dispositivo
```

**El `id` lo genera la pantalla**, igual que la app genera los suyos
(`newId()`, CLAUDE.md §5.4), y el insert es `ON CONFLICT (id) DO NOTHING` —
el mismo mecanismo que ya usa el replay de la cola (`sendOpWith`, modo
`replay`). Eso resuelve, solo para este endpoint, lo que §4 de
`device-tokens-and-idempotency.md` deja abierto para todos: si el wifi del
cuarto corta la respuesta y la pantalla reintenta, el reintento lleva el mismo
`id` y no hay un segundo pañal. Sin `id`, el servidor genera uno (como hace
`/api/quick/nurse`) y no hay garantía contra el doble registro.

`changed_at` es siempre **ahora, en el servidor**. La pantalla no manda hora:
no tiene reloj confiable hasta que sincroniza NTP, y un pañal "del pasado" se
carga desde la app. `logged_by` queda `null`, igual que en `/api/quick/nurse`.

Un `id` que ya existe pero es de **otra** familia o de otro bebé tiene que
contestar distinto de "already_logged": el `ON CONFLICT DO NOTHING` no lo
distingue solo. Releer la fila por `id` + `baby_id` después del insert y, si no
aparece, 409. (Mismo cuidado que `tests/integration/queue-replay.test.ts` con
"reusar el id de una fila ajena no la toca".)

---

## 5. `GET /api/quick/status`

Solo lectura. Lo que la pantalla necesita para pintar la parte de arriba, ya
resuelto en el servidor para que el firmware no reimplemente reglas de la app:

```
GET /api/quick/status
Authorization: Bearer amd_…            (scope read_status)

200 {
  "now": "2026-10-05T03:12:00.000Z",
  "baby": { "name": "Amelia" },
  "nursing": { "side": "left", "started_at": "…" } | null,
  "sleep":   { "started_at": "…" } | null,
  "last_feeding_end": "…" | null,
  "feed_due": { "due_at": "…", "overdue": false } | null,
  "last_diaper": { "at": "…", "type": "wet" } | null
}
```

- **`now` va en la respuesta** para que la pantalla calcule "hace 12 min" con su
  propio contador desde la última lectura, sin depender de su reloj.
- **`last_feeding_end` y `feed_due` salen de `lastFeedingEnd` y `nextDue`**
  (`lib/schedule.ts`), con el umbral de `family_settings`, los mismos que usa el
  countdown de /dashboard y el aviso push (`runScheduleChecks` en
  `lib/push/server.ts`). Si la pantalla y el teléfono dijeran cosas distintas,
  sería un bug; por eso no se recalcula en C++.
- Con una lactancia corriendo, `feed_due` es `null` — misma regla que la
  tarjeta de Today (no se afirma un vencimiento que no se sabe).
- **Dónde viven las queries:** `lib/db.ts` es `'use client'` y no puede usarse
  en un route handler con `service_role` (CLAUDE.md §5.3). Mismo arreglo que el
  push y el calendario: un `lib/device/server.ts` solo de servidor, y la ruta no
  arma ninguna query.
- **Qué expone:** el nombre del bebé y horarios de lactancia, sueño, comida y
  pañal de las últimas horas. Nada de crecimiento, turnos médicos, notas ni
  nombres de los padres.

**Polling:** cada 30 s con la pantalla prendida, y una lectura inmediata
después de cada toque. Son ~2 pedidos por minuto, adentro del techo de 20 por
minuto de `lib/deviceAuth.ts` — **pero ese techo es por IP**, y la pantalla, el
NUC y Home Assistant salen todos por la IP de la casa (pregunta 4 de CLAUDE.md
§7). Hoy alcanza; si se suman más aparatos, es el primer número que hay que
mirar.

---

## 6. El token de la pantalla

```bash
pnpm device-token create --family <uuid> --baby <uuid> \
  --label "Pantalla del cambiador" \
  --scope quick_nurse --scope quick_diaper --scope read_status
```

- **Clavado a Amelia** (`--baby`): aunque la familia tenga un segundo bebé algún
  día, esta pantalla no puede escribir en otro.
- **Contra producción**, no contra el stack local: `pnpm device-token` usa la
  `service_role` de `.env.local`. Esa clave de producción no está en este repo
  ni en el VPS (§2.1); crearlo es un paso de Emilio, con las variables de la nube
  cargadas solo para ese comando, o el equivalente en el SQL Editor de Supabase
  (insertar el **hash**, nunca el token en claro).
- **Si la placa se pierde o se rompe:** `pnpm device-token revoke --id <uuid>`.
  Quien tenga la placa en la mano puede leer su flash y sacar el token, y con él
  hacer exactamente lo de sus tres scopes. Nada más: no entra a la app, no lee
  otra familia, no borra nada.

---

## 7. Firmware

**Vive afuera de `amelia-app`.** Este repo es una sola app Next con un solo
`package.json` (CLAUDE.md §2); un proyecto de PlatformIO adentro no tiene lugar.
Propuesta: una carpeta hermana, `AMELIA SOFTWARE/changer-display/`, con su
propio git.

**Placa:** ESP32-2432S028R ("Cheap Yellow Display"), confirmada por Emilio.
Pines de la versión común — **verificar contra la placa real**, hay revisiones
con otro controlador de pantalla (ST7789 en vez de ILI9341, la de dos USB):

| Qué | Pines |
|---|---|
| Pantalla ILI9341 240×320 (SPI) | SCLK 14, MOSI 13, MISO 12, CS 15, DC 2 |
| Backlight (PWM) | 21 |
| Táctil XPT2046 (bus SPI **aparte**) | CLK 25, MOSI 32, MISO 39, CS 33, IRQ 36 |
| Sensor de luz (LDR) | 34 |

**Stack:** PlatformIO (o Arduino IDE) con el core de ESP32, `TFT_eSPI`
configurado para esta placa (o LovyanGFX) y `XPT2046_Touchscreen`. LVGL es
opcional; para seis botones y tres líneas de texto no hace falta.

Decisiones, en el mismo espíritu que la app:

- **Vertical, 240×320**, para que se lea igual que el teléfono (pedido de
  Emilio). Botones grandes: con táctil **resistivo** y a las 3 de la mañana, el
  piso es el de `--tap` del teléfono o más.
- **Nunca dice "guardado" si no lo está** (CLAUDE.md §5.5). Sin wifi, o con un
  error del servidor, el botón muestra el error y no cambia el estado de
  arriba. **v1 no tiene cola offline**: el pañal se vuelve a tocar cuando vuelve
  el wifi, o se carga desde el teléfono.
- **Antirrebote:** el táctil resistivo da dobles toques. Un toque bloquea los
  botones de su grupo hasta que vuelve la respuesta (y ~2 s más). Para pañales,
  el `id` de §4 cubre el reintento de red; para lactancia no (ver §8).
- **Noche:** el backlight baja solo con el LDR del pin 34 (o por horario si el
  LDR resulta ruidoso). Tema oscuro siempre, colores tomados de los tokens del
  tema oscuro de `app/globals.css`.
- **HTTPS de verdad:** `WiFiClientSecure` con el bundle de CAs del core
  (`setCACertBundle`), **nunca `setInsecure()`** — sin verificar el certificado,
  cualquiera en el medio se queda con el token.
- **Secretos fuera del git:** wifi y token en un `secrets.h` ignorado (o en NVS
  con un portal de configuración, más adelante).
- **Idioma:** los textos de la pantalla no pasan por `lib/i18n` (no es la app),
  pero la casa usa los dos. Un `#define LANG` con las dos tablas alcanza.

---

## 8. Riesgos y lo que esto NO resuelve

- **Lactancia no es idempotente.** `/api/quick/nurse` es un **toggle**: si la
  respuesta se pierde y la pantalla reintenta, el segundo pedido corta lo que el
  primero arrancó. Regla del firmware: **nunca reintentar un toque de
  lactancia**; ante un timeout, releer `/api/quick/status` y mostrar lo que hay.
  Hacerlo idempotente en serio es §4 de `device-tokens-and-idempotency.md`, que
  sigue abierta.
- **El techo por IP** (§5) y su `Map` en memoria siguen como están (CLAUDE.md
  §7, pregunta 4).
- **No hay push hacia la pantalla.** Lo que el otro padre registra desde el
  teléfono aparece en la pantalla en ≤ 30 s, no al instante.
- **Una placa robada** tiene un token con tres scopes (§6). Se revoca; no hay
  forma de evitar que se lea de la flash.

---

## 9. Preguntas para Emilio

1. ¿Los textos de la pantalla en español, en inglés, o un botón para cambiar?
2. ¿"Ambos" como tercer botón de pañal, o solo Mojado / Sucio y "ambos" desde el
   teléfono? (Cada botón menos es un botón más grande.)
3. ¿La pantalla muestra también "próxima comida en …" (`feed_due`) o solo lo
   que pasó?
4. Carpeta del firmware: ¿`AMELIA SOFTWARE/changer-display/` está bien?

---

## 10. Orden de implementación, cuando se apruebe

1. Migración (número libre siguiente) + `DEVICE_SCOPES` + `POST /api/quick/diaper`
   + `GET /api/quick/status` + `lib/device/server.ts`.
2. Tests de integración, mismo molde que `tests/integration/quick-nurse.test.ts`:
   auth y scopes (sin token 401, sin el scope 403), tipo inválido 400, el mismo
   `id` dos veces = una fila, un `id` de otra familia no se toca, no cruza de
   familia ni de bebé, `status` con y sin lactancia corriendo, y que `feed_due`
   coincida con lo que calcula `lib/schedule.ts`.
3. Versión **MINOR** + entrada en `CHANGELOG.md` (CLAUDE.md §0.1).
4. Push → Vercel. **Aplicar la migración en la nube a mano** (sin eso, crear el
   token falla por el CHECK) y verificar con
   `select pg_get_constraintdef(oid) from pg_constraint where conname = 'device_tokens_scopes_check';`.
5. Crear el token (§6). Firmware (§7), flashear, calibrar el táctil.
6. Prueba en el cambiador: tocar "Mojado" y verlo en History del teléfono; arrancar
   lactancia desde la pantalla y cortarla desde Today.
