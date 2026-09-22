# Aplicar las migraciones y prender el cron en el proyecto de la nube

**Para Luis, para correr una sola vez, en el SQL Editor de Supabase.**

Este archivo existe porque el agente **no puede hacer esto**: desde el VPS de
desarrollo no hay credenciales del proyecto de la nube (sin `.vercel/`, sin CLI
de Supabase, sin `~/.supabase/access-token`, y `.env.local` apunta a
127.0.0.1). Todo lo demás del aviso push está hecho y probado; falta esto.

- **Proyecto Supabase:** `ituurekoybqjqpuycweh`
  (verificado el 22 sep 2026 — sale del bundle público del cliente).
- **App en producción:** `https://amelia-app.vercel.app`
  (verificado: 200 en `/login`, `<title>Amelia</title>`).

Son cinco pasos. El 1 y el 5 son de lectura; solo el 2, 3 y 4 escriben.

---

## Paso 1 — ¿Qué hay aplicado hoy? (solo lee)

```sql
select
  to_regclass('public.push_subscriptions')                       as tabla_0009,
  (select count(*) from information_schema.columns
    where table_name = 'nursing_sessions'
      and column_name = 'long_alert_sent_at')                    as col_0009,
  (select count(*) from information_schema.columns
    where table_name = 'push_subscriptions'
      and column_name = 'consecutive_403')                       as col_0010,
  (select count(*) from cron.job where jobname = 'nursing-check') as job_0011,
  (select count(*) from pg_extension
    where extname in ('pg_cron', 'pg_net'))                      as extensiones;
```

Lectura del resultado:

| Columna | Si da… | Quiere decir |
|---|---|---|
| `tabla_0009` | `null` | **0009 no está aplicada.** Hay que correrla (paso 2). |
| `col_0009` | `0` | idem |
| `col_0010` | `0` | **0010 no está aplicada** (paso 2). |
| `job_0011` | `0` | el cron todavía no existe (paso 2). |
| `extensiones` | `< 2` | falta `pg_cron` y/o `pg_net`; 0011 las crea. |

Si `cron.job` no existe todavía, esa subconsulta va a dar error — es esperable,
significa que `pg_cron` no está instalada. Corré el resto igual.

---

## Paso 2 — Aplicar las migraciones que falten

Pegá el contenido **completo** del archivo, en este orden, y solo las que el
paso 1 marcó como faltantes:

1. `supabase/migrations/0009_push.sql`
2. `supabase/migrations/0010_push_forbidden_streak.sql`
3. `supabase/migrations/0011_push_cron.sql`

Las tres son seguras de volver a correr salvo 0009 (crea la tabla). 0010 usa
`add column if not exists`; 0011 es idempotente (`cron.schedule` con un nombre
que ya existe lo reemplaza) y no agenda nada si faltan las extensiones.

Después de 0011 tendría que aparecer el `NOTICE`:

```
0011: job "nursing-check" agendado (* * * * *)
```

**En este punto el job ya corre cada minuto y NO llama a nadie**, porque los
secretos todavía no existen. Eso es a propósito.

---

## Paso 3 — Crear el token de dispositivo (desde tu máquina, no acá)

El endpoint resuelve la familia **desde el token**, así que el token tiene que
existir en la base de la nube. Con un `.env.local` que apunte al proyecto de la
nube:

```bash
pnpm device-token families        # para sacar el uuid de la familia
pnpm device-token create --family <uuid-de-la-familia> \
  --scope push_check --label "pg_cron nube"
```

Imprime el token en claro **una sola vez**. Copialo: la base guarda solo el hash.

> Si preferís no apuntar tu `.env.local` a producción ni por un minuto, se
> puede hacer por SQL, pero hay que generar el token y su sha-256 a mano.
> Decime y te paso el comando.

---

## Paso 4 — Cargar los dos secretos en Vault

```sql
select vault.create_secret(
  'https://amelia-app.vercel.app/api/push/nursing-check',
  'amelia_push_check_url',
  'Amelia: endpoint del check de toma larga en produccion');

select vault.create_secret(
  'PEGAR-ACA-EL-TOKEN-DEL-PASO-3',
  'amelia_push_check_token',
  'Amelia: device_token scope push_check que usa pg_cron');
```

**El token no va a ningún archivo del repo.** Vive solo acá.

La URL no es un secreto (es la dirección pública del sitio); va por Vault igual
para que cambiar de dominio no obligue a editar y re-aplicar la migración.

⚠️ Tiene que ser la URL **estable**. La de cada deployment
(`amelia-<hash>-emireymon09-create.vercel.app`) cambia en cada push y serviría
un solo deploy.

Para rotar cualquiera de los dos, sin tocar el job:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'amelia_push_check_token'),
  'el-token-nuevo');
```

---

## Paso 5 — Verificar que anda (solo lee)

Esperá **dos minutos** y corré esto. **Esta es la evidencia que falta** — si me
la pasás, cierro los objetivos 3 y 4 del pase:

```sql
-- (a) el job existe y está activo
select jobid, jobname, schedule, active from cron.job
 where jobname = 'nursing-check';

-- (b) está corriendo, cada minuto
select runid, status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'nursing-check')
 order by start_time desc limit 10;

-- (c) qué contestó la app  ← lo más importante
select status_code, content, created
  from net._http_response
 order by created desc limit 10;
```

Qué tendrías que ver:

- **(b)** `status = succeeded` y `return_message = 1 row` en cada corrida. Si
  dice `0 rows`, alguno de los dos secretos no está cargado (paso 4) y el job
  está haciendo lo correcto: nada.
- **(c)** `status_code = 200` y un `content` como
  `{"subscriptions":0,"marked":0,...}`. Con 0 suscripciones es lo normal y ya
  prueba que la cadena entera funciona.
  - `401` → el token no es válido en esa base, o no tiene scope `push_check`.
  - `503` → faltan las variables VAPID en Vercel
    (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`).
  - `status_code` en null con `timed_out = t` → la base no llega a la app.

### La prueba de verdad (opcional, 30 minutos)

Prendé "Nursing alerts" en un teléfono, empezá una toma de pecho y **no la
pares**. A los 30 minutos tiene que llegar la notificación sola. Nadie llama a
nada: el único disparador es `cron.job`.

---

## Para apagarlo

```sql
select cron.unschedule('nursing-check');
```

O, sin tocar el job, borrar un secreto: el job sigue corriendo y deja de llamar.

---

## Qué ya está probado y no hace falta volver a probar

Contra el stack local, el 22 sep 2026, con evidencia en el `output.txt` de ese
pase: `pg_cron` disparó solo cada minuto, el endpoint autenticó el token,
encontró una sesión de pecho de 35 minutos, la marcó (`marked: 1`), cifró y
firmó el payload, hizo el POST a `fcm.googleapis.com`, y al recibir un 404
borró la suscripción muerta y devolvió la marca para reintentar
(`removed: 1, released: 1`). Nadie tocó el endpoint a mano.

Lo que **no** se pudo probar en ningún lado: que a un teléfono real le aparezca
la notificación (acá el último salto fue contra una suscripción inventada), y
el clic sobre la notificación.
