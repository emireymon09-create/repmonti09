# Checklist de cada cambio — Amelia App

Tres bloques. Se recorren enteros, aunque el cambio parezca de una línea — sobre
todo si parece de una línea.

---

## A. Antes de escribir código

- [ ] **¿Verifiqué contra el código, no contra la documentación?**
      `grep`/`cat` el archivo. Si la doc y el código no coinciden, el código es
      la verdad y la doc es el bug — y la diferencia se reporta.
- [ ] **¿Leí lo que ya está ahí y por qué?** Buena parte de lo que parece raro
      en este repo está comentado con su motivo (los ids del cliente, la
      resolución en dos pasos del DST, el matcher del middleware).
- [ ] **¿El cambio toca datos de una familia?** Entonces tiene que haber un test
      de aislamiento que lo cubra (`tests/integration/rls.test.ts`).
- [ ] **¿El cambio toca el schema?** Si Emilio pidió implementarlo acá,
      migración nueva numerada; si no, propuesta en `proposals/` (CLAUDE.md
      §5.2).
- [ ] **¿El cambio toca algo visual?** El valor sale de un token de
      `app/globals.css`. Si el token no existe, se crea ahí y se espeja en
      `lib/tokens.ts`.
- [ ] **¿Estoy por agregar una tabla cuyo scope sea un join por `baby_id`?**
      No. En fase 2 cada tabla lleva `household_id` directo.
- [ ] **¿Estoy por construir calendario, comidas, tareas o riego?** Eso es del
      Hub, no de este repo.

---

## B. Después de escribir, antes de commitear

### Se corre, no se supone

```bash
pnpm exec tsc --noEmit    # type-check
pnpm lint                 # eslint
pnpm format:check         # prettier
pnpm build                # el build de verdad
pnpm test:all             # unit × 4 TZ + integración (necesita Docker)
```

- [ ] Los cinco en verde. Si uno falla, **se muestra la salida real**, no se
      resume como "hay un problemita".
- [ ] Si `pnpm test:integration` no se pudo correr (Docker apagado), se **dice**
      que no se corrió. No se da por bueno.
- [ ] **Se probó contra el Supabase local**, no solo se leyó. Levantar con
      `pnpm db:up`.

### Lo que se revisa a ojo

- [ ] Sin `console.*` nuevo.
- [ ] Sin `any` ni `as` nuevos.
- [ ] Sin secreto hardcodeado. Sin secreto con prefijo `NEXT_PUBLIC_`.
- [ ] `.env.local.example` actualizado si apareció una variable nueva.
- [ ] **Ninguna query nueva fuera de `lib/db.ts`** (los route handlers,
      `lib/deviceAuth.ts` y `scripts/device-token.mts` — un CLI de admin,
      server-only, que corre con `service_role` para crear/listar/revocar
      tokens de dispositivo — son la excepción).
- [ ] **`lib/supabaseAdmin.ts` no entró a ningún archivo `'use client'`.**
- [ ] Toda lectura nueva de una tabla con `voided_at` filtra con
      `.is('voided_at', null)`.
- [ ] Ningún hex ni px nuevo fuera de `app/globals.css`.
- [ ] Si tocaste el schema: migración nueva (o propuesta), con RLS **y**
      GRANT/REVOKE explícitos, y un test de integración.
- [ ] Nada se presenta como guardado si no lo está.
- [ ] Nada que el servidor haya **rechazado** se encola.

---

## C. Antes del commit

- [ ] **Mensaje:** frase imperativa en inglés, una línea, sin prefijo
      `feat:`/`fix:`/`chore:`, describiendo el efecto para quien usa la app.
      Se acepta `Fix:` informal para un arreglo puro.
- [ ] El commit cierra con:
      `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- [ ] **`npm` y `yarn` están prohibidos en este repo.** Ni en comandos, ni en
      scripts, ni en documentación, ni en el mensaje del commit. Solo `pnpm`.
- [ ] `git status --short`: no se coló `.env.local`, `.env.test`, `output.txt`
      ni `node_modules/`.
- [ ] Si algo quedó **sin verificar**, se dice explícitamente en el reporte.
      "No lo verifiqué" es una respuesta válida; inventar no.

---

## Lo que NO se hace en este repo

De `PROJECT.md`, salvo que Emilio lo pida explícitamente:

- No crear un repo propio en GitHub — va a ser `apps/amelia` en el monorepo del
  Hub.
- No crear un proyecto Supabase en la nube — la base compartida la crea el
  agente del Hub (ADR 0001).
- No construir calendario, comidas, tareas ni riego.
- **Y la regla dura del proyecto entero:** video, imágenes y audio de la cámara
  **nunca** salen de la casa. Solo eventos derivados entran a `/api/ingest`.
  Cualquier propuesta que viole esto se rechaza sin discusión.
