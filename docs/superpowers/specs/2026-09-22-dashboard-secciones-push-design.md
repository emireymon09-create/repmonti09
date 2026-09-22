# Diseño — /dashboard en 3 secciones + aviso push por toma de pecho larga

Fecha: 22 sep 2026. Pedido de Emilio en la sesión del mismo día. Fuente de
verdad de convenciones: `CLAUDE.md` (manda), `design.md`, `PROJECT.md`.

## Hechos verificados antes de diseñar

- La app **no corre** en este VPS: no hay proceso `next`, ni pm2, ni unidad
  systemd, ni contenedor. Lo único que corre es el stack de Supabase
  (`amelia-local-*` en Docker, 127.0.0.1) y un crontab de vigilancia de
  puertos que no es de la app. El deploy previsto es Vercel, sin hacer.
  ⇒ **No hay nada ya corriendo que se pueda reusar** para el disparo periódico.
- El service worker se registra **solo en producción**
  (`components/ServiceWorker.tsx`). Todo lo de push se prueba contra
  `pnpm build && pnpm start`, no contra `next dev`.
- `device_tokens` (0007) ya da auth por dispositivo con scopes, clavada a una
  familia. El check de scopes vive en un CHECK de la tabla.
- `/history` ya tiene editar/borrar de las cuatro categorías con un panel a la
  vez y `useReturnFocus`.
- Migraciones: `0001`…`0008`. La siguiente libre es **`0009`**.

## Parte A — /dashboard

- Se van: el botón "Log a missed session" (y su editor de hora), la tarjeta de
  próximo turno y la tarjeta Today (`buildActivity`). `buildActivity` sigue
  vivo: lo usa `/history`.
- Quedan exactamente 3 tarjetas en el `Grid` (1 columna en teléfono, 3 en la
  pared):
  1. **Feeding / Comida** — lactancia (cronómetro en vivo, Left/Right con el
     lado sugerido, Stop) + biberón (cantidad en la unidad del dispositivo) +
     sólido. `live` si hay lactancia en curso. Leyenda = el último evento entre
     `feedings` y `nursing_sessions` terminadas: hora · tipo (pecho con lado /
     biberón / sólido) · cantidad (biberón) o duración (pecho).
     Mantiene la predicción de próxima toma.
  2. **Diaper / Pañal** — wet/dirty/both. Leyenda: hora · tipo.
  3. **Sleep / Dormir** — cronómetro en vivo, Start / She's awake. Leyenda:
     hora (en que se despertó) · cuánto durmió. Mantiene la predicción de
     siesta.
- Cada tarjeta: `.pending-tag` "Not synced yet" en la sesión en curso y en el
  último evento si están en cola (§5.5); offline sin copia → "—"; link a su
  página.
- Encabezado (fecha, nombre, edad), `SyncBar`, `SeenNote`, `SyncErrorBanner`,
  banners de error/ok: igual que hoy.

**Decisión (anotada, no pedida explícitamente):** al sacar "Log a missed
session" del dashboard, registrar con hora pasada (design.md §5.8) no puede
desaparecer: cada página nueva lleva un formulario "Log a past one" para su
categoría (hora de inicio/fin o del evento). Así §5.8 sigue siendo cierto.

## Parte A — páginas nuevas `/feeding`, `/diapers`, `/sleep`

- **Ventanas de KPI** (TZ del hogar, `America/Los_Angeles`):
  - *Hoy* = desde `startOfHouseholdDay()` hasta ahora.
  - *Semana* = **últimos 7 días**: desde el inicio del día del hogar de hace 6
    días hasta ahora (hoy incluido). Rodante, no semana calendario — sin
    ambigüedad lunes/domingo. El label lo dice ("Last 7 days").
- **KPIs** (funciones puras en `lib/kpis.ts`, testeadas bajo las 4 TZ):
  - Comida: tomas totales (= biberón + sólido + sesiones de pecho **iniciadas**
    en la ventana), desglose por tipo, ml de biberón (en la unidad del
    dispositivo), minutos de pecho (solapamiento de cada sesión
    `[started_at, ended_at ?? ahora]` con la ventana).
  - Pañal: total y por tipo (wet / dirty / both, `both` es su propio tipo).
  - Dormir: horas dormidas (solapamiento con la ventana, incluida la sesión en
    curso hasta ahora) y cantidad de siestas (sesiones **iniciadas** en la
    ventana).
  - Las filas en cola (`pending`) cuentan: son lo que el usuario registró, y la
    página ya marca "not synced yet" donde aparecen. Se dice en la página si
    algún KPI incluye filas sin sincronizar.
- **Lecturas** nuevas en `lib/db.ts` con ventana temporal (`…Since(babyId,
  sinceIso)`), no con `limit`, para que un KPI nunca se corte. El log usa el
  mismo tope que `/history` (200 por tabla).
- **Log** con editar/borrar: patrón de `/growth`/`/history` — soft-delete
  `voided_at`, un panel a la vez, foco vuelve al Edit (`data-edit-for`),
  `window.confirm` que dice qué se conserva. Comida mezcla `feedings` y
  `nursing_sessions` en un solo listado cronológico (reusando
  `buildActivity`/`detail`). La lógica de edición se **extrae** de `/history`
  a un componente compartido sólo si eso no cambia el comportamiento de
  `/history` (el auditor lo compara); si no, se duplica.
- Offline/honestidad: mismo patrón que `/history` (`keepLastGood`,
  `mergePending`, `lastSeen` con `seenKey.page('feeding'|…)`, `SyncBar`,
  `SeenNote`, `SyncErrorBanner`, repintado rápido desde la cola).
- `middleware.ts` protege las tres rutas; `lib/offlinePages.ts` y el
  `PRECACHE` de `public/sw.js` las incluyen (VERSION → `amelia-v4`).
- Nav: sin cambios (5 tabs). A las páginas nuevas se llega desde su tarjeta.

## Parte B — push por toma de pecho larga

- **VAPID**: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (pública), `VAPID_PRIVATE_KEY` y
  `VAPID_SUBJECT` (solo server, jamás `NEXT_PUBLIC_`). Librería `web-push`
  (pnpm). Generación local de claves integrada a `pnpm db:env` o un script
  propio; `.env.local.example` documentado.
- **Migración `0009_push.sql`**:
  - `push_subscriptions`: `id`, `family_id` (scope directo, fase 2),
    `user_id` (`default auth.uid()`), `endpoint`, `p256dh`, `auth`, `lang`
    (`en`/`es`), `created_at`, `updated_at`; `unique (user_id, endpoint)`.
    RLS en la misma migración: cada usuario ve/crea/edita/borra **solo sus**
    filas y solo de una familia de la que es miembro. GRANTs explícitos a
    `authenticated`, `revoke all from anon`.
  - `nursing_sessions.long_alert_sent_at timestamptz` — marca de "ya avisé".
  - `device_tokens`: el CHECK de scopes suma `push_check`.
- **Endpoint de suscripción** `POST/DELETE /api/push/subscription`: con la
  sesión del usuario (cookie, anon key + JWT ⇒ RLS), nunca service_role.
  Guarda/actualiza/borra la suscripción de ese dispositivo.
- **Cliente**: en el menú del engranaje, "Nursing alerts" (On/Off), pedido de
  permiso solo tras el toque. Estados honestos: no soportado (p. ej. iOS sin
  instalar), bloqueado en el navegador, apagado, encendido. Al cerrar sesión
  se desuscribe y borra su fila (pantalla compartida). Al cambiar de idioma se
  actualiza `lang`.
- **Service worker**: handlers `push` (muestra la notificación, `tag` por
  sesión para que un duplicado se colapse) y `notificationclick` (enfoca una
  ventana abierta o abre `/dashboard`). No cambia qué se cachea.
- **Disparo**: `POST /api/push/nursing-check`, autenticado con un token de
  dispositivo de scope `push_check` (`Authorization: Bearer`, mismo camino que
  `/api/ingest`). Para la familia del token: toma **atómicamente** las
  sesiones abiertas, no borradas, iniciadas hace ≥ 30 min y sin
  `long_alert_sent_at` (`update … where long_alert_sent_at is null … returning`
  ⇒ una sola vez por sesión aunque dos checks corran a la vez) y manda el push
  a cada suscripción de la familia (deduplicado por endpoint). Una suscripción
  que el servicio de push da por muerta (404/410) se borra. Si la familia no
  tiene suscripciones, no marca nada. Responde con números (sesiones marcadas,
  envíos ok / fallidos / borrados).
- **Quién llama al check cada minuto: PREGUNTA ABIERTA** (CLAUDE.md §7). No hay
  nada corriendo en el VPS para reusar. Opciones: (a) la caja de la casa
  (NUC o HA Green, ya pendiente de decidir para `/api/ingest`) con un `curl`
  por minuto; (b) Vercel Cron (en Hobby solo corre una vez por día: no sirve;
  en Pro sí por minuto); (c) `pg_cron` + `pg_net` dentro de Supabase (el
  proyecto en la nube es del Hub). El endpoint no depende de la elección.
  Hasta decidirla, **el aviso no llega solo en la vida real**.

## Verificación

- Unit: `lib/kpis.ts` (4 TZ), payload/i18n del push, selección de sesiones.
- Integración (stack local): RLS de `push_subscriptions` entre usuarios y
  familias; el check marca una sola vez, respeta la familia del token y el
  umbral, y manda a un servicio de push falso local (se descifra el payload).
- Auditor, Playwright real: dashboard y páginas nuevas con datos sembrados y
  KPIs contra SQL; en `next start` con permiso de notificaciones otorgado:
  suscripción guardada, check disparado del lado server, notificación mostrada
  por el service worker. Lo que no se pueda probar acá (entrega real por
  FCM/APNs, teléfono bloqueado, iOS) se declara.
