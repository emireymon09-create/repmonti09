# Documentación local — Amelia App

Esto es doc **para trabajar**, no para entender el proyecto. Si venís a
entender qué es Amelia y cómo está armada, el orden es otro y está abajo.

---

## Regla de oro

**Investigá antes de hablar.** Si la documentación y el código no coinciden, el
código es la verdad y la documentación es el bug. Reportá la diferencia en vez
de elegir en silencio cuál de los dos creer.

Esto no es una frase de adorno en este repo. El 20 de septiembre de 2026, una
auditoría encontró que el README declaraba "no construidas" cuatro cosas que
estaban construidas y funcionando, y que `PROJECT.md` afirmaba que había tests
de timezone cuando no había **un solo test** en todo el repo. Las dos cosas se
corrigieron ese día. La próxima mentira se va a escribir igual: el hábito de
verificar es lo único que la agarra.

Si no pudiste verificar algo, decilo: *"no lo verifiqué"*. Nunca rellenes el
hueco con una suposición presentada como hecho.

---

## Orden de lectura

1. **`CLAUDE.md`** (raíz) — las reglas duras. Si algo de acá lo contradice,
   manda CLAUDE.md, y hay que avisar de la contradicción.
2. **`PROJECT.md`** (raíz) — arquitectura y estado; documento de traspaso hacia
   la sesión del Hub.
3. **`design.md`** (raíz) — UI/UX: tokens, escala, componentes, patrones.
4. **Estas cuatro páginas**, según lo que estés por hacer.

---

## Las cuatro páginas

| Página | Para qué |
| --- | --- |
| [`manual-buenas-practicas.md`](manual-buenas-practicas.md) | Cómo se escribe código en este repo y por qué. Lectura de una vez, consulta después. |
| [`checklist-cada-cambio.md`](checklist-cada-cambio.md) | La lista que se recorre **en cada cambio**, antes y después de escribir. |
| [`prompt-auditoria-codigo.md`](prompt-auditoria-codigo.md) | El prompt pegable para auditar el repo entero. Reporta, no corrige. |
| [`seguridad-operacional.md`](seguridad-operacional.md) | Reglas del servidor, los secretos y las llaves. Incluye §10, el procedimiento de backup de la base de producción. |
| [`aplicar-en-la-nube.md`](aplicar-en-la-nube.md) | **Para Luis, a mano, una sola vez.** Aplicar 0009/0010/0011 en el proyecto Supabase de la nube y prender el cron del aviso de toma larga. El agente no puede: este VPS no tiene credenciales de producción. |
| [`aplicar-en-la-nube-0012.md`](aplicar-en-la-nube-0012.md) | **Para Luis, a mano, una sola vez, DESPUÉS del anterior.** Aplicar 0012 (umbrales de familia, recordatorio de cita, feed de calendario). Es un solo paso: no hay secretos de Vault ni cron nuevo. |
| [`handoff-metodologia.md`](handoff-metodologia.md) | El **proceso** con el que se construyó esto: dos sesiones con roles separados, dos mensajes por tarea, el flujo de 4 roles, las reglas de honestidad. No describe el producto. |
| [`handoff-2026-09-25.md`](handoff-2026-09-25.md) | La auditoría de handoff del 25 sep 2026: 19 secciones, cada afirmación etiquetada como confirmada por test, por lectura o **no verificada**, y al final una lista única de todo lo que no se sabe. |
| [`spec-feeding-v3.md`](spec-feeding-v3.md) | Especificación del inventario de leche y las tomas v3 (4 oct 2026): las reglas del dueño, los 22 supuestos elegidos donde el pedido no alcanzaba, y el plan por archivos. |
| [`progreso-feeding-v3.md`](progreso-feeding-v3.md) | Estado por hitos de ese pase, con qué comando se verificó cada cosa, y la tabla de hallazgos de la revisión independiente con su resolución. |
| [`milk-business-logic.md`](milk-business-logic.md) | Cómo funciona **de verdad** el inventario de leche (0014): extracciones, caducidad, tomas, lo que hay, sin conexión — cada afirmación etiquetada verificada o no. |
| [`handoff-2026-10-04.md`](handoff-2026-10-04.md) | Handoff del pase del inventario sobre la base vieja (`9824e26`). **Superado por el del 6 oct** en versión y despliegue (su "0.11.0" y su orden de despliegue ya no valen). |
| [`handoff-2026-10-06.md`](handoff-2026-10-06.md) | El inventario v3 montado sobre producción v0.12.1 (rama `feat/milk-inventory-v3-release`). **Superado por el handoff v4** para desplegar: v3 no se publica sola. Sigue valiendo como historia de la integración. |
| [`comparacion-v0.12.1.md`](comparacion-v0.12.1.md) | Qué cambió el papá entre `9824e26` y v0.12.1, qué es nuestro, cada conflicto (textual y semántico) y cómo se resolvió. |
| [`compatibilidad-leche.md`](compatibilidad-leche.md) | La app v0.12.1 corriendo contra la base con 0014: la superficie de la migración, la matriz de casos con resultado y lo que ve el usuario, el rollback solo de la app, cómo acortar la ventana. |
| [`runbook-despliegue-leche.md`](runbook-despliegue-leche.md) | El runbook de v3 (migraciones 0013/0014). **No seguir: lo reemplaza `runbook-despliegue-v4.md`.** |
| [`verificar-antes-leche.sql`](verificar-antes-leche.sql) | Solo lectura: qué migraciones están de verdad en la nube, por sus objetos. |
| [`rollback-leche.sql`](rollback-leche.sql) | Deshace 0014 (probado en Postgres efímero); el encabezado dice qué datos se pierden. |
| [`reglas-de-uso-familia.md`](reglas-de-uso-familia.md) | Para papá y mamá, sin términos técnicos: cómo se usan la leche guardada y los biberones en la app. **Actualizado a v4** (marca lo que cambió respecto de v3). |
| [`milk-reglas-para-aprobar.md`](milk-reglas-para-aprobar.md) | Las 22 reglas de v3 que papá contestó en `respuestas-papa-leche.md`. Historia: lo vigente para firmar es `milk-v4-para-aprobar.md`. |
| [`respuestas-papa-leche.md`](respuestas-papa-leche.md) | Las respuestas de papá a las 22 reglas y las funciones nuevas que pidió. **Fuente de verdad de v4.** |

### Inventario de leche v4 (fases 1 y 2) — rama `feat/milk-inventory-v4`

| Página | Para qué |
| --- | --- |
| [`handoff-2026-10-06-v4.md`](handoff-2026-10-06-v4.md) | **Empezar acá para desplegar la leche.** Qué se hizo, ramas y hashes, qué se verificó, qué **no**, defectos previos, riesgos y limpieza. |
| [`milk-v4-para-aprobar.md`](milk-v4-para-aprobar.md) | **Para mamá y papá, para firmar.** Cada regla en lenguaje cotidiano, las decisiones tomadas a confirmar y lo que viene después. Sin las dos firmas no se despliega. |
| [`runbook-despliegue-v4.md`](runbook-despliegue-v4.md) | Pasos numerados para el dueño: aprobación, verificación previa, backup, migraciones 0013/0014/0015, checklist, versión 0.13.0, PR #1 y #2, push, Node 24, previews, PWA, prueba de humo, vuelta atrás y riesgos. |
| [`comparacion-v4.md`](comparacion-v4.md) | Qué revierte v4 de v3 y por qué, qué agrega, qué no cambia, y los commits de la rama. |
| [`spec-feeding-v4.md`](spec-feeding-v4.md) | Requisitos trazados a cada respuesta de papá, las 25 decisiones D-x, casos límite y enganches para las fases 3–4. |
| [`arquitectura-v4.md`](arquitectura-v4.md) | Diseño: estados del biberón, invariante contable (con la consulta de control), funciones, migración de datos, interfaz, compatibilidad y reversa. |
| [`plan-pruebas-v4.md`](plan-pruebas-v4.md) | Los casos de prueba (unitarios, integración, compatibilidad, navegador, reversa) con su resultado. |
| [`progreso-feeding-v4.md`](progreso-feeding-v4.md) | Estado por hitos, con qué comando se verificó cada cosa y los números de cada corrida. |
| [`compatibilidad-v4.md`](compatibilidad-v4.md) | v4 junto a las apps v0.12.1 y v3 sobre la misma base, la ventana de cambio y la reversa, con evidencia. |
| [`verificar-antes-v4.sql`](verificar-antes-v4.sql) | Solo lectura: qué hay en la nube antes de aplicar 0015, objeto por objeto, y si 0015 va a entrar. |
| [`rollback-leche-v4.sql`](rollback-leche-v4.sql) | Deshace 0015 (deja 0001–0014); encadenable con `rollback-leche.sql`. El encabezado dice qué se pierde. |

## Y además

| Carpeta | Qué hay |
| --- | --- |
| [`auditorias/`](auditorias/) | Los reportes de cada corrida del prompt de auditoría. |
| [`design/`](design/) | Material de diseño que no es código: la maqueta `preview.html`. |
| [`superpowers/plans/`](superpowers/plans/) | Los planes de batch ejecutados, tal como se escribieron. |
