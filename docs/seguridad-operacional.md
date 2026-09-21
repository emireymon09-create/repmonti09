# Seguridad operacional — Amelia App

Reglas del servidor, de los secretos y de las llaves. Todo lo de acá aplica a
**este** proyecto; lo que era de FRUCO y no aplica, no está.

---

## 1. pnpm y solo pnpm

`npm` y `yarn` están prohibidos en este repo. `scripts/only-pnpm.mjs` corre en
`preinstall` y aborta si el gestor no es pnpm.

- En un servidor nuevo: `corepack enable`, y pnpm sale de `packageManager` en
  `package.json`. **Nunca `npm install -g`** de nada.
- El lockfile (`pnpm-lock.yaml`) va commiteado, siempre. Sin lockfile, dos
  builds de la misma rama pueden traer dependencias distintas.
- `pnpm audit` antes de cada deploy.

---

## 2. Nunca `curl | sh`

Bajar, **leer**, y recién entonces ejecutar. Un pipe directo a la shell ejecuta
lo que el servidor de enfrente mande en ese instante, que no tiene por qué ser
lo mismo que mandó cuando alguien lo revisó.

---

## 3. Secretos

- **Fuera del repo y fuera de Notion.** `.env.local` y `.env.test` están en
  `.gitignore` y ahí se quedan.
- Permisos `600` en `.env.local`: `chmod 600 .env.local`.
- **Una contraseña pegada en un chat cuenta como expuesta.** No importa que el
  chat sea privado ni que se borre después: se rota.
- `.env.local.example` lleva los **nombres** de las variables y un valor de
  relleno, nunca un valor real.

---

## 4. Las dos llaves de Supabase

| Llave | Qué puede | Dónde vive |
| --- | --- | --- |
| `anon` | Lo que RLS le permita al usuario logueado. | Browser. Es pública por diseño (`NEXT_PUBLIC_SUPABASE_ANON_KEY`). |
| `service_role` | **Todo.** Salta RLS por completo, en todas las tablas y todas las familias. | Solo servidor (`SUPABASE_SERVICE_ROLE_KEY`, sin prefijo `NEXT_PUBLIC_`). |

**`service_role` es equivalente a la contraseña de superusuario de la base.** Si
se filtra, se filtran los datos de todas las familias.

**Dónde vive hoy:** en esta app, usada por `/api/ingest` y `/api/quick/nurse` a
través de `lib/supabaseAdmin.ts`.

**Y por qué eso está marcado como problema:** la regla del Hub dice que la
`service_role` vive **solo en el servidor del Hub**. Esta app la tiene. Es la
pregunta abierta n.º 1 de `CLAUDE.md` §7: o el ingest se muda a `apps/hub`, o la
regla necesita una excepción escrita. No está resuelto, y no se resuelve acá.

**Rotación:** desde el dashboard de Supabase, regenerando las llaves del
proyecto. Toda instancia desplegada tiene que actualizarse en la misma ventana,
o queda caída.

---

## 5. Secretos de dispositivo

`NUC_DEVICE_SECRET` y `QUICK_TOGGLE_SECRET` autentican a los dos endpoints de
dispositivo. Son **estáticos y compartidos**: identifican "alguien que conoce el
secreto", no *quién*.

**Cómo rotarlos:**

1. `openssl rand -hex 32`
2. Actualizar la variable de entorno donde corra la app.
3. Actualizar el header en la automatización de Home Assistant y en el Shortcut
   de iOS. Los tres pasos van juntos: no hay período de convivencia hasta que se
   implemente `proposals/device-tokens-and-idempotency.md`.

**Qué tapa el rate limiting que hay hoy** (`lib/deviceAuth.ts`, 20 intentos por
minuto y por IP): la fuerza bruta ingenua desde una sola dirección.

**Qué NO tapa, dicho con todas las letras:**

- El contador vive en la memoria de **ese** proceso. Con varias instancias, cada
  una cuenta por su lado; un arranque en frío lo resetea.
- No hay idempotencia: el mismo evento mandado dos veces son dos filas.
- Y lo más importante: **el secreto no dice a qué familia pertenece**. Quien lo
  tenga escribe sobre cualquier `baby_id` de la base (hallazgos C1 y C2 de
  `auditorias/2026-09-20-auditoria-inicial.md`). El arreglo de fondo son tokens
  hasheados por dispositivo, y está propuesto, no implementado.

---

## 6. Puertos y bindings — verificar, no suponer

**`ufw status` no es evidencia de nada.** Lo que importa es en qué interfaz
escucha el proceso:

```bash
ss -tln | grep -E '5432|543[0-9][0-9]'
docker ps --format '{{.Names}}\t{{.Ports}}'
```

- `127.0.0.1:5432->5432/tcp` → solo local. Correcto.
- `0.0.0.0:54322->5432/tcp` → **todas las interfaces**, o sea internet, salvo
  que haya un firewall delante.

### ✅ Resuelto el 21 sep 2026

El stack local ya bindea a `127.0.0.1`: `pnpm db:status` y `ss -tln`
confirmados, ningún `0.0.0.0`.

```
$ pnpm db:status
amelia-local-auth-1   Up (healthy)
amelia-local-db-1     Up (healthy)   127.0.0.1:54322->5432/tcp
amelia-local-kong-1   Up (healthy)   127.0.0.1:54321->8000/tcp
amelia-local-rest-1   Up

$ ss -tln | grep -E ':5432[0-9]'
LISTEN 0  4096  127.0.0.1:54322  0.0.0.0:*
LISTEN 0  4096  127.0.0.1:54321  0.0.0.0:*
```

Curl a la IP pública del VPS → `000` (sin respuesta); a `127.0.0.1` → `200`.

**Qué cambió:** se sacó el CLI de Supabase (no tenía forma de fijar el bind —
ver evidencia E-3 en
`docs/superpowers/plans/2026-09-21-tokens-crecimiento-stack-versiones.md`) y
`supabase/config.toml`. En su lugar, un `docker-compose.yml` propio en
`supabase/docker/` que publica cada puerto como `127.0.0.1:puerto:puerto`,
operado con `pnpm db:up` / `db:down` / `db:reset` / `db:env` / `db:psql` /
`db:status`. Sin Studio (decisión de Emilio, P-3): menos superficie expuesta.
`next dev` también pasó a `-H 127.0.0.1`.

**Qué hacer de acá en adelante:** el stack propio ya bindea a 127.0.0.1; no
vuelvas al CLI de Supabase.

### Historia — hallazgo original (verificado el 20 sep 2026, cerrado el 21)

El stack local de Supabase que levantaba `pnpm exec supabase start` **bindeaba
a `0.0.0.0`**, no a localhost. Observado, no supuesto:

```
0.0.0.0:54321->8000/tcp     supabase_kong      (API completa)
0.0.0.0:54322->5432/tcp     supabase_db        (Postgres: postgres/postgres)
0.0.0.0:54323->3000/tcp     supabase_studio    (Studio, SIN autenticación)
0.0.0.0:54324->8025/tcp     supabase_inbucket  (mailbox de desarrollo)
0.0.0.0:54327->4000/tcp     supabase_analytics
```

Y desde la IP pública de la máquina, Studio responde (307) y la API responde
(404, que es una respuesta). **No pude verificar si un firewall externo lo tapa:
este usuario no tiene sudo, así que `ufw status` e `iptables -L` fallan.** Lo
digo así porque es lo que sé: el proceso escucha en todas las interfaces y
responde en la IP pública desde la propia máquina.

Por contraste, los contenedores de `fruco-erp` en la misma máquina sí bindean
bien: `127.0.0.1:5432` y `127.0.0.1:6379`.

Los datos que había ahí adentro eran de prueba y las llaves eran las de
desarrollo que Supabase publica en su propia documentación, así que el riesgo
inmediato era bajo. El riesgo real era el otro: un Postgres con
`postgres/postgres` abierto a internet es un punto de apoyo dentro de la
máquina. Ver la solución arriba, en "✅ Resuelto el 21 sep 2026".

---

## 7. La regla dura del proyecto

**Video, imágenes y audio de la cámara nunca salen de la casa.**

A `/api/ingest` solo entran **eventos derivados**: inicio y fin de sueño,
alertas de sonido, movimiento. La lista blanca está en el propio handler
(`EVENT_TYPES`), y `meta` tiene un tope de 2 KB justamente para que nadie meta
un frame codificado ahí adentro.

Cualquier propuesta que viole esto se rechaza sin discusión. No es una
preferencia de arquitectura: es la razón por la que la cámara está donde está.

---

## 8. Despliegue

Todavía no hay deploy (Vercel está previsto, no hecho). Cuando llegue:

- [ ] Las variables de entorno se cargan en el panel de Vercel, no en un archivo
      del repo.
- [ ] `SUPABASE_SERVICE_ROLE_KEY`, `NUC_DEVICE_SECRET` y `QUICK_TOGGLE_SECRET`
      **sin** prefijo `NEXT_PUBLIC_`.
- [ ] `QUICK_TOGGLE_BABY_ID` seteada si la base tiene más de un bebé (si no, el
      endpoint falla cerrado a propósito).
- [ ] `pnpm audit` limpio.
- [ ] `pnpm test:all` en verde contra un stack local antes de subir.
- [ ] Una corrida de `prompt-auditoria-codigo.md`.

---

## 9. Historial de incidentes

Formato:

| Fecha | Qué pasó | Cómo se detectó | Qué se hizo | Qué cambió para que no vuelva |
| --- | --- | --- | --- | --- |
| 20 sep 2026 | Postgres, Studio y la API del stack local de Supabase escuchaban en `0.0.0.0` (todas las interfaces) en vez de `127.0.0.1`, en un VPS sin sudo para confirmar si un firewall lo tapaba | `docker ps` mostrando `0.0.0.0:puerto->...` + `curl` a la IP pública de la máquina respondiendo | Se reemplazó el CLI de Supabase por un stack propio (`supabase/docker/docker-compose.yml`), operado con `pnpm db:up`/`db:down`/`db:reset`/`db:env`/`db:psql`/`db:status`, que publica cada puerto como `127.0.0.1:puerto:puerto` | Se sacó el CLI de Supabase como dependencia y se borró `supabase/config.toml`; `next dev` pasó a `-H 127.0.0.1` |

Un incidente se anota **aunque no haya tenido consecuencias**. El valor del
registro está en los que no pasaron a mayores.
