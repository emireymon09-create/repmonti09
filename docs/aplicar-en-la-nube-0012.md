# Aplicar `0012` en la nube — para Luis, a mano, una sola vez

**Qué habilita:** la cuenta regresiva configurable de Today, los avisos de
comida y siesta vencidas, el recordatorio de cita 24 h antes, y el feed de
calendario `.ics`.

**Cuánto lleva:** un solo `psql`/SQL Editor, sin secretos que cargar.

**Por qué lo tenés que correr vos y no el agente:** este VPS no tiene
credenciales del proyecto Supabase de la nube. No hay `.vercel/`, no hay CLI de
Supabase, no hay `~/.supabase/access-token`, y `.env.local` apunta a
`127.0.0.1`. Lo mismo que ya pasaba con `docs/aplicar-en-la-nube.md`.

---

## La buena noticia: esta vez es UN solo paso

A diferencia de `0009`/`0010`/`0011`, acá **no hay nada que cargar en Vault, no
hay ningún job de `pg_cron` nuevo y no hay ninguna variable de entorno nueva en
Vercel.** Eso fue una decisión de diseño, no una casualidad:

Los tres checks nuevos (comida vencida, siesta vencida, recordatorio de cita)
se metieron **adentro** del endpoint que ya existe,
`/api/push/nursing-check`, en vez de tener endpoints propios. Dos motivos, con
el mismo criterio con que `CLAUDE.md` §7.6 eligió `pg_cron` sobre Vercel Cron:

- El techo de intentos de `lib/deviceAuth.ts` es **por IP, no por endpoint**
  (20 por minuto, compartido con `/api/ingest` y `/api/quick/nurse` —
  `CLAUDE.md` §7, pregunta 4). Cuatro endpoints llamados una vez por minuto
  desde la misma IP gastarían 4 de esas 20 en vez de 1.
- `0011` ya está escrita con el jobname `nursing-check`, la URL en Vault y el
  token de scope `push_check`. Un endpoint nuevo sería un secreto más en Vault,
  un job más y otra corrida manual tuya.

**Costo asumido:** el nombre `nursing-check` ya no describe todo lo que hace.
Está anotado en el encabezado del handler y en `CLAUDE.md` §6.

> **Requisito previo:** esto **no sirve de nada si `0011` todavía no está
> aplicada** y sus dos secretos de Vault cargados. El job de `pg_cron` es lo
> único que llama al endpoint. Si todavía no lo hiciste, corré primero
> `docs/aplicar-en-la-nube.md` y después esto.

---

## Paso 1 — aplicar la migración

SQL Editor del proyecto de la nube. El archivo es
`supabase/migrations/0012_schedule_appointments_calendar.sql` de este repo:
**pegalo entero, tal cual**. No lo transcribas a mano — los `check`, las
policies y los `grant` son el punto.

Lo que crea:

| Objeto | Qué es |
|---|---|
| tabla `family_settings` | Los dos umbrales del countdown + las marcas de "ya avisé". Scope `family_id` **directo**. |
| columna `doctor_appointments.reminder_sent_at` | La marca del recordatorio de 24 h, una sola vez por cita. |
| tabla `calendar_feeds` | El token opaco del feed `.ics`, guardado como sha-256. |

Las dos tablas nacen con **RLS habilitada, sus policies y los GRANT/REVOKE
explícitos en la misma migración** — el bug de `0005` (sin `GRANT` al rol
`authenticated`, Postgres bloquea antes de evaluar la policy).

---

## Paso 2 — verificar que quedó bien

Las consultas ya escritas, para pegar y comparar:

```sql
-- 1. Las dos tablas existen y tienen RLS PRENDIDA. Las dos tienen que decir 't'.
select relname, relrowsecurity
from pg_class
where relname in ('family_settings', 'calendar_feeds');

-- 2. Las policies. Esperado: 3 en family_settings (select/insert/update)
--    y 4 en calendar_feeds (+ delete).
select tablename, policyname, cmd
from pg_policies
where tablename in ('family_settings', 'calendar_feeds')
order by tablename, cmd;

-- 3. Los GRANT. `authenticated` tiene que aparecer; `anon`, NO APARECER NUNCA.
--    Si ves una fila con grantee = 'anon', algo salió mal: pará y avisá.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_name in ('family_settings', 'calendar_feeds')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- 4. La columna del recordatorio.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'doctor_appointments' and column_name = 'reminder_sent_at';

-- 5. Los defaults de los umbrales: 120 (siesta) y 180 (comida).
select column_name, column_default
from information_schema.columns
where table_name = 'family_settings'
  and column_name in ('nap_threshold_minutes', 'feed_threshold_minutes');
```

**Si el paso 3 devuelve alguna fila con `grantee = 'anon'`, no sigas.** Eso
significaría que `anon` —la llave que viaja en el navegador— tiene acceso a
una tabla que no debería ver, y la migración hace un `revoke all ... from anon`
justamente para que eso no pase.

---

## Paso 3 — que el aviso empiece a salir solo

No hay nada que hacer. El job de `pg_cron` de `0011` ya llama a
`/api/push/nursing-check` cada minuto, y el endpoint corre los cuatro checks
desde el primer deploy que lleve este código.

Para confirmar que está pasando, lo mismo que ya usaste para la toma larga:

```sql
-- El job corre.
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'nursing-check')
order by start_time desc limit 5;

-- Y la app contesta 200. `content` trae ahora una clave `schedule` con
-- { feeding, nap, appointments, sent, failed, removed, skipped }.
select status_code, left(content, 400), created
from net._http_response
order by created desc limit 5;
```

`"skipped": true` adentro de `schedule` es **normal y correcto** si la familia
todavía no tiene ninguna suscripción push: sin nadie a quien avisar no se marca
nada, así que si alguien prende los avisos dentro de un rato, el vencimiento
que sigue abierto le llega igual.

---

## Paso 4 — el feed de calendario, cuando lo quieras usar

No necesita nada de la nube más allá de la migración. Se crea desde la app:

**Settings → Calendar feed → "Create the link".** El link se muestra **una sola
vez**. Copialo y pegalo en el calendario del teléfono o de la compu ("agregar
calendario suscrito"). En iOS también funciona el esquema `webcal://` con la
misma dirección.

**Leé `CLAUDE.md` §5.8 antes de compartirlo con alguien.** Resumido: el link es
el único control de acceso, y quien lo tenga ve título, tipo, hora, doctor y
notas de los turnos médicos — nada de tomas, pañales, sueño ni peso. Si se te
escapa, **"Replace the link"** genera otro y mata el anterior en el acto (hay
que reapuntar los calendarios que estuvieran suscritos).

---

## Lo que NO se pudo verificar desde este VPS, dicho explícitamente

- **Que `0012` quede aplicada en la nube.** Se aplicó y se verificó en el
  Docker local, nada más.
- **Que los tres avisos nuevos lleguen a un teléfono real.** El servicio de
  push real sí se probó en su momento para la toma larga; estos tres no se
  probaron contra un teléfono.
- **El disparo por `pg_cron` de punta a punta acá.** El job corre y encola el
  `net.http_post` —hay evidencia en `cron.job_run_details`— pero en este VPS el
  contenedor de Postgres no puede abrir un TCP contra el host, así que la
  llamada nunca llega. En la nube ese tramo no existe: `pg_net` sale a internet
  contra `amelia-app.vercel.app`. **El endpoint sí se ejercitó directamente** y
  corre los cuatro checks.
- **Que un cliente de calendario real acepte el feed suscrito.** El `.ics` se
  parseó con `ical.js`, que es el parser de Thunderbird, y salió correcto; pero
  nadie lo suscribió en iOS ni en Google Calendar.
