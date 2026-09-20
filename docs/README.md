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
| [`seguridad-operacional.md`](seguridad-operacional.md) | Reglas del servidor, los secretos y las llaves. |

## Y además

| Carpeta | Qué hay |
| --- | --- |
| [`auditorias/`](auditorias/) | Los reportes de cada corrida del prompt de auditoría. |
| [`design/`](design/) | Material de diseño que no es código: la maqueta `preview.html`. |
| [`superpowers/plans/`](superpowers/plans/) | Los planes de batch ejecutados, tal como se escribieron. |
