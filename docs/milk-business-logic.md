# Lógica de negocio — inventario de leche y tomas de biberón (0014)

Cómo funciona **de verdad**, en el código de la rama `feat/milk-inventory-v3`
(4 oct 2026). Las reglas que se pidieron están en `docs/spec-feeding-v3.md`
§1; las lecturas que se eligieron donde el pedido no alcanzaba, en §2. Acá se
describe lo implementado, con dónde vive cada cosa y su estado:
**[VERIFICADO]** = con un comando o una prueba que se corrió (citada);
**[NO VERIFICADO]** = escrito pero no ejercitado en este pase.

> **`0014` está aplicada solo en el stack local** (desde el 4 oct 2026,
> `docs/handoff-2026-10-04.md` §2.1); **en la nube, no**. Antes de desplegar
> hay que aplicarla a mano allá. *(Hasta el 5 oct este recuadro decía que
> ningún entorno la tenía: había quedado viejo.)*

---

## 1. Piezas

| Pieza | Dónde | Qué hace |
|---|---|---|
| Esquema y reglas del servidor | `supabase/migrations/0014_milk_inventory.sql` | Columnas, dos tablas, RLS, guardas, cinco funciones |
| Lógica pura | `lib/milk.ts` | Caducidad, utilizables, etiquetas, sugerencia, reparto, lo que hay, cola offline, texto del desglose, reglas |
| Única puerta a la base | `lib/db.ts` | Lecturas sin límite, las cinco escrituras, `milkErrorText` |
| Cola offline | `lib/queue.ts` | Operación `rpc`, descarte en cascada |
| Constructor de filas | `components/BottleBuilder.tsx` | Uno solo, para Hoy y para `/feeding` |
| Pantallas | `app/pumping`, `app/dashboard`, `components/SectionPage.tsx`, `app/history`, `app/settings` | |

## 2. Extracción

- Una sesión guarda **izquierda** (`left_ml`) y **derecha** (`right_ml`) por
  separado. El total (`amount_ml`) lo escribe el servidor como la suma; una
  sesión sin nada en ningún lado queda con total vacío y **sin contenedor**.
  Nunca se reparte un total a la mitad: una sesión vieja (anterior a 0014)
  que solo tiene total abre su edición con los dos lados vacíos.
  [VERIFICADO: chequeos SQL "session total = left + right" y "session without
  amount: valid, no container"]
- Con cantidad, `log_pumping_session` crea en la **misma transacción** un
  contenedor con la cinta **que eligió la persona** (5 oct 2026, decisión del
  dueño; spec S-5):
  - Los dos formularios de Leche (terminar el cronómetro y registrar a mano)
    tienen el campo **"Cinta"**, prellenado con la sugerencia
    (`suggestContainerLabel`: una más que la mayor M de los contenedores
    vivos, **cola incluida**; no rellena huecos: M1 + M5 → M6). El caso normal
    es no tocarlo. [VERIFICADO: unit; navegador (a), (b), (f)]
  - Se puede saltar la secuencia (M1 existe → M5 vale). Lo tipeado se
    normaliza con `normalizeTapeLabel` (`m 5`, `M05` → `M5`; hasta 6 dígitos);
    M0 u otro formato da "La cinta es una M y un número desde 1, por ejemplo
    M6." sin llegar al servidor; vacío con cantidad, "Escribí el número de la
    cinta…". [VERIFICADO: unit; navegador (b), (c)]
  - Una cinta con contenedor **vivo** (también uno encolado) se rechaza en la
    pantalla con "M5 ya lo tiene una extracción que sigue guardada. Elegí otro
    número." (`tapeInUse`), y el servidor la rechaza igual
    (`milk_label_taken:M#`, lock por bebé + índice único parcial): **nunca se
    renumera**. Si el choque lo detecta el servidor al guardar en línea (otro
    teléfono la usó y la página no se había releído), se muestra el mismo
    "Elegí otro número" y la página se relee (S-27). [VERIFICADO: unit;
    integración; navegador (c), (h)]
  - La cinta de un contenedor **anulado** se puede volver a usar (S-20).
    [VERIFICADO: unit, integración, navegador (d)]
  - Sin cantidad (los dos lados vacíos) el campo se ignora: no hay
    contenedor y nunca bloquea, aunque tenga basura. [VERIFICADO: integración
    (tolerancia del servidor); navegador (g)]
  - Al guardar, el campo vuelve a la sugerencia nueva — la cinta recién
    guardada ya cuenta aunque la relectura no haya llegado — y el aviso dice
    qué escribir: "Sesión registrada — escribí M5 en la cinta."
    [VERIFICADO: navegador (a), (b)]
  - El servidor no cambió: ya validaba `^M[1-9][0-9]*$` (`milk_bad_input`) y
    la cinta viva repetida; `0014` **no se tocó** en este pase.
  - **No se puede cambiar la cinta de una extracción ya registrada** (no se
    pidió): la salida es borrarla y registrarla de nuevo, que no se puede si ya
    se sirvió leche de ella. El panel de edición no tiene campo "Cinta"; si una
    edición le da cantidad a una sesión sin contenedor, nace con la sugerencia
    (S-25).
- **En vivo**: la hora de arranque se guarda en `localStorage`
  (`amelia:pump-start:<bebé>`) de ese dispositivo y sobrevive a recargar; al
  terminar se registra con esa hora. El otro teléfono no ve el cronómetro.
  **A mano**: con la hora que se elija (no futura). [NO VERIFICADO en un
  navegador — ver §8]
- **Sesiones anteriores a 0014** (solo un total, sin lados): corregirles la
  hora o la nota no toca el total; recién si se escriben los lados nace su
  contenedor (S-22). La pantalla de edición lo avisa. [VERIFICADO: SQL "editing
  only the note/time of a pre-0014 session keeps its total"]
- **Editar** (`update_pumping_session`): el contenedor sigue la cantidad,
  **nunca por debajo de lo servido** (`milk_served_exceeds_amount:M#`); si la
  sesión no tenía cantidad y se le da una, el contenedor nace ahí; si se le
  saca la cantidad a una sesión no servida, su contenedor se anula.
  [VERIFICADO: SQL]
- **Anular** (`void_pumping_session`): anula sesión y contenedor; se **niega**
  si ya se sirvió leche de él (`milk_already_served:M#`). La pantalla lo dice
  antes de mandar nada. [VERIFICADO: SQL]
- **Dónde se corrige o se borra:** en el Historial, con el ⋯ de cada fila —
  la decisión de v0.11.0 (4a3c082). Leche (`/pumping`) es solo para registrar
  y mirar: su tarjeta "Sesiones" lista cada extracción (total, cinta M#,
  izquierda/derecha, lo ya servido) y su esquina lleva al Historial, que pasa
  por las mismas dos funciones y hace los mismos chequeos de lo servido.

## 3. Conservación y caducidad

- Tres reglas por familia, columnas de `babies`: `milk_room_hours` (4),
  `milk_fridge_days` (4), `milk_freezer_months` (6). Se editan en Ajustes →
  "Conservación de la leche", se validan **juntas** (`validateMilkRules`: un
  campo vacío nunca se guarda como 0, meses enteros, topes 24 h / 30 días / 24
  meses) y se guardan **directo**, sin cola: sin conexión no se guarda nada y
  la tarjeta lo dice. [VERIFICADO: unit `validateMilkRules`; la tarjeta NO
  VERIFICADA en pantalla]
- La caducidad la **calcula el servidor** al guardar la extracción, con las
  reglas vigentes: refrigerador = `n × 24 h` exactas; congelador = meses de
  calendario en UTC, recortando al último día del mes (31 ago + 6 meses =
  28 feb). El dispositivo calcula lo mismo (`containerExpiresAt`) solo para
  mostrarla sin conexión. [VERIFICADO: unit (4 husos) y SQL, incluido el
  cambio de horario con la sesión en `America/Los_Angeles`]
- **Utilizable** (`isUsable`) = no anulada, con leche y `expires_at` posterior
  al instante que se mira (al llegar a la hora exacta ya caducó). [VERIFICADO:
  unit]
- Todo va al refrigerador. "Pasar al congelador" no existe; la columna
  `location` y la regla del congelador quedan listas. La regla de ambiente se
  guarda y hoy no la usa nada.

## 4. Toma de biberón

- Una toma = porciones (contenedor + cantidad) + fórmula (una cantidad, puede
  ser 0). `log_bottle_feed` escribe `breast_milk_ml` (suma de porciones),
  `formula_ml` y `amount_ml` (suma + fórmula) **calculados por el servidor**, y
  una fila `milk_drawdowns` por porción. [VERIFICADO: SQL]
- Solo fórmula, solo leche o mezcla: las tres valen; nada de nada no es una
  toma (`milk_bad_input`). [VERIFICADO: SQL]
- **La fórmula no tiene inventario**: no hay tabla, saldo ni rechazo por falta
  de fórmula. Es un número en la toma.
- **No hay "Avent"** ni estándar fijo. `DEFAULT_FIRST_SUGGESTION_ML` (3 oz) es
  solo el valor inicial cuando nunca hubo una toma de biberón.
- **Sugerencia** (`suggestedTotalMl`): el total de la **última** toma de
  biberón con cantidad (vieja o nueva, en cola o no). Hoy la lee aparte
  (`lastBottleFeeding`), porque las más nuevas pueden ser todas de pecho.
  [VERIFICADO: unit]
- **Reparto** (`suggestPlan`): de la extracción utilizable más antigua
  (`stored_at`, después número de M), combinando las que haga falta; el
  faltante, fórmula; sin leche utilizable, todo fórmula. Ejemplo del pedido:
  3 oz con M3 en 1.75 → "M3 1.75 oz + 1.25 oz de fórmula = 3 oz".
  [VERIFICADO: unit, con 1, 2 y 4 contenedores]
- En `/feeding` ("Registrar uno pasado") solo se ofrecen extracciones que ya
  existían y no estaban caducadas **a la hora elegida**.
- Se puede cambiar todo en el constructor: otra extracción, otra cantidad,
  más o menos filas, otra fórmula. Si se tipea exactamente lo que la
  extracción muestra que le queda, se toma **todo** en ml exactos
  (`portionMl`), para que el redondeo de pantalla no deje restos ni provoque
  un rechazo. [VERIFICADO: unit]
- Toda cantidad tiene un tope finito (`< 100 000 ml`): `"NaN"` o `"Infinity"`
  mandados a mano se rechazan (`milk_bad_input`). [VERIFICADO: SQL]
- **Sobregiro**: el servidor bloquea los contenedores (`FOR UPDATE`, en orden
  de id) y rechaza pedir más de lo que hay (`milk_overdraw:M#`), sin recortar.
  Dos teléfonos a la vez sobre el mismo contenedor: entra uno, el otro recibe
  el rechazo y vuelve a elegir. [VERIFICADO: SQL con dos sesiones
  concurrentes]
- Una porción es válida si la extracción **no estaba caducada a la hora de la
  toma**, no a la hora en que llega al servidor (`milk_container_unusable:M#`).
  [VERIFICADO: SQL]
- **Editar** una toma con desglose: solo la hora (`updateFeeding(id,
  {fed_at})`); la pantalla lo explica. **Borrar** (`void_bottle_feed`):
  devuelve cada porción a su contenedor en una sola operación, sin pasar de la
  cantidad inicial; borrar dos veces o algo que nunca llegó no hace nada.
  Las tomas viejas sin desglose se editan enteras como siempre.
  [VERIFICADO: SQL; unit `isInventoryBottleFeed`]
- Un trigger impide, por fuera de las cinco funciones, cambiar cantidad,
  composición o anular una toma con desglose, escribir contenedores o
  porciones, dar de alta una extracción con izquierda o derecha, o tocar algo
  que no sea la nota de una extracción con lados o con contenedor
  (`milk_rpc_only`). [VERIFICADO: SQL]
- **Excepción a propósito — la ventana del deploy (6 oct 2026).** Una
  extracción con la **forma vieja** (un total o nada, **sin** izquierda ni
  derecha y **sin** contenedor vivo) se puede dar de alta, corregir (lado,
  total, hora, nota) y borrar **directo**, sin las funciones. Es exactamente lo
  que hace la app v0.12.1, que los teléfonos siguen corriendo cacheada un rato
  después del deploy: si la base la rechazara, su cola offline quedaría trabada
  hasta descartar la entrada y esa leche registrada se perdería. Una fila así
  es lo mismo que toda sesión de antes de 0014: **no crea contenedor, no mueve
  lo que hay y cuenta 0** en el inventario; la app nueva la muestra como
  sesión vieja ("solo total"). Lo que la regla no deja: que una sesión vieja
  gane izquierda o derecha por fuera (seguiría sin contenedor y parecería
  nueva), que cambie de bebé, o que se toque por fuera una sesión con lados o
  con contenedor. Las tomas viejas de biberón sin desglose ya entraban así y no
  cambiaron. [VERIFICADO: integración `tests/integration/milk.test.ts`, "app
  vieja v0.12.1 durante el deploy", con las llamadas exactas de v0.12.1, y la
  suite de integración de v0.12.1 corrida contra esta base]

## 5. Lo que hay (stash)

- `stashMl` = suma de lo que queda en las extracciones **utilizables**. Solo
  leche materna, en onzas totales (`formatMilkOz`, hasta 2 decimales). Sin
  fórmula y sin "cantidad de tomas". [VERIFICADO: unit]
- Se ve en Leche (lista de M# con lo que queda y "Usar antes del…"; las
  caducadas dicen "Caducada — no cuenta") y en el panel del biberón.
- Las lecturas que lo alimentan (`listContainers`, `listDrawdowns`) **no
  tienen límite**. El total viejo de Leche sumaba las últimas 100 sesiones:
  se reemplazó.
- **Días de reserva**: no existían en `main` (grep), así que no se
  construyeron.
- Las extracciones anteriores a 0014 no tienen contenedor: lo que hay arranca
  en 0 y crece con cada extracción nueva. `babies.pumping_reset_at` ya no
  participa.

## 6. Pantalla de inicio

La tarjeta Comida muestra "Dale X oz" y el botón **Biberón** con el ícono de
la mamila. El botón abre un panel **inline** de ancho completo debajo de las
tres tarjetas (la app no tiene modales con overlay): la sugerencia desglosada,
la leche materna que queda, **Registrar tal cual** (un toque) y el
constructor de filas con **Registrar con cambios** (habilitado solo si algo
cambió de verdad: una fila sin tocar vale los ml exactos de la sugerencia) y
**Cerrar**; Escape también cierra (salvo dentro de una lista desplegable). El
foco entra al panel y vuelve al botón. Si lo que hay cambia mientras alguien
edita las filas, no se le borra lo tipeado: aparece "La sugerencia cambió
mientras editabas" con "Empezar de nuevo desde ahí". Durante una lactancia en
curso la fila del biberón no está (como antes). [VERIFICADO en un navegador:
el panel abre, no entra en bucle (10 ms de CPU en 4 s), lo tipeado sobrevive;
NO VERIFICADO con extracciones reales — ver §8]

## 7. Sin conexión

- Las cinco escrituras son una operación `rpc` de la cola: se guardan en el
  dispositivo, se marcan "Sin sincronizar", y `applyPendingInventory` ya las
  refleja en lo que hay y en la sugerencia (contenedores nuevos, editados,
  anulados; porciones que salen y que vuelven), sin aplicar dos veces lo que
  el servidor ya tiene. [VERIFICADO: unit]
- Se reenvían en orden; un reenvío no duplica (ids del dispositivo + funciones
  idempotentes: mismo id y misma carga = no-op; distinta = excepción
  `milk_idempotency_conflict`). Un reintento que llega mientras la primera
  llamada todavía corre espera un lock por id y termina en no-op.
  [VERIFICADO: SQL, unit de la cola, y concurrencia en el Postgres efímero]
- Una toma nueva se encola detrás solo si alguna porción sale de una
  extracción que todavía está en la cola. Si una anulación encolada todavía no
  devolvió la leche, la toma nueva puede recibir un rechazo visible
  (`milk_overdraw`) en vez de quedar trabada: se vuelve a intentar al
  sincronizar.
- Una edición o un borrado de algo que todavía es un alta en la cola, o una
  toma que sirve de un contenedor que todavía está en la cola, se encola
  detrás (`queueOnly`) en vez de mandarse directo a un servidor que todavía no
  lo conoce. Descartar una extracción rechazada se lleva las tomas que salían
  de su contenedor (`dependentsOf` transitivo). [VERIFICADO: unit]
- Un rechazo del servidor se muestra en palabras (`milkErrorText`), nunca se
  encola. [VERIFICADO: unit]

## 8. Lo que NO se verificó

*(Actualizado el 5 oct 2026: desde el pase de verificación local del 4 oct
—`docs/handoff-2026-10-04.md` §2.1— 0014 está aplicada en el stack local,
la integración corre y las pantallas se recorrieron con datos reales. Lo de
abajo es la lista original del 4 oct; para el estado vigente manda el
handoff §3.)*

- **Las pantallas con datos reales de leche** (Leche, el panel con
  extracciones, `/feeding`, Historial, Ajustes): necesitan 0014 en la base, y
  aplicarla estaba prohibido. Compilan, pasan lint y build, y el panel se vio
  abrir sin bucle; no se vio una toma con porciones registrada desde la
  pantalla.
- **`tests/integration/milk.test.ts`**: escrita, se salta sola sin 0014.
- **Barrido de layout** (390/1440, temas, idiomas) de las pantallas nuevas.
- **El cronómetro en vivo** al recargar, y en un iPhone.
