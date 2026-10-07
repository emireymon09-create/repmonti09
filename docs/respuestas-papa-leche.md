# La leche en Amelia — respuestas de papá

Respuestas a `docs/milk-reglas-para-aprobar.md`. Cada regla dice **Aprobada** o
**Cambiar**, con el cambio explicado. Al final van las funciones nuevas que
salieron al revisarlas.

> Para revisar con Ana antes de mandárselo a Luis.

---

## Respuestas por regla

**Extracción**

1. **Izquierdo y derecho por separado — Aprobada, con aclaración.**
   Toda extracción se vierte en **un solo recipiente**. Al anotarla, la tarjeta
   de "Leche" pregunta **cuánto salió del izquierdo y cuánto del derecho**, cada
   uno con el selector **oz / ml** (el mismo que tiene el biberón en "Hoy").
   La división es solo para estadísticas; el recipiente recibe el total.

2. **Lados vacíos: se anota sin número — Aprobada.**

3. **Cinta propuesta y se puede cambiar — Cambiar.**
   Las M **no son una secuencia**: son **biberones físicos que reusamos**
   (M1–M6) y lavamos. Al anotar una extracción se **elige de un selector** en
   qué biberón quedó. El orden lo dan las horas del registro, no el número: M6
   puede ser la más vieja y M1 la más nueva.

4. **No se repite un número guardado — Aprobada, adaptada a la regla 3.**
   Un biberón que todavía tiene leche no se puede elegir de nuevo hasta que se
   use, se combine, se deseche o se borre.

5. **El número de un borrado se reusa — Aprobada.**
   Cualquier biberón vacío queda libre para volver a usarse.

**Cuánto dura la leche**

6. **Ambiente 4 h, refri 4 días, congelador 6 meses — Aprobada.**

7. **Hoy todo cuenta como refrigerador — Aprobada, con regla nueva.**
   La **hora en que se anota la extracción es la hora en que entra al
   refrigerador**. Con eso la app sabe cuánto lleva guardada, cuándo vence y
   cuándo ya está fría para mezclar (ver "Enfriado" abajo).

8. **Caducada no cuenta ni se ofrece — Aprobada, con agregado.**
   Cuando vence, el biberón muestra **"Caducada"** y un botón **"Desechar"**.
   Al tocarlo se anota como leche tirada (cuenta en estadísticas como
   desperdicio) y **el biberón queda libre**.

**Biberón**

9. **Sugerencia = último biberón, 3 oz si no hubo — Cambiar.**
   Ver "Receta" abajo: la cantidad depende de cuánto pasó desde la última toma.

10. **La leche más vieja primero — Cambiar.**
    La receta usa solo leche que **ya está fría y no venció**, la más vieja
    primero. Además se puede **elegir qué biberones** usar.

11. **Lo que falta, con fórmula — Cambiar.**
    No es solo "leche hasta que se acabe y después fórmula". Se puede fijar
    **cuánta fórmula** lleva (ej. 1 oz) y la app calcula la leche, para
    **repartir** la leche disponible entre las próximas tomas. Si una toma sale
    distinta, la siguiente se recalcula sola.

12. **Cualquier cantidad vale — Aprobada.**

13. **Se supone que se lo terminó — Cambiar.**
    Se puede anotar **"sobró X oz"**. Sirve para estadísticas de cuánto toma de
    verdad.

**Fórmula**

14. **Fórmula sin contar ni bloquear — Cambiar.**
    La app **cuenta la Similac** (ver "Inventario de fórmula" abajo). Sigue sin
    impedir nunca un biberón por falta de fórmula.

**"Lo que hay"**

15. **Solo leche que sirve, en oz — Aprobada.**

16. **La leche vieja no suma — Cambiar.**
    Las tomas anteriores se completan con esta lógica para tener estadísticas
    hacia atrás. Como solo tienen el total, la división leche/fórmula se
    **estima**.

**Corregir o borrar**

17. **Biberón dado: solo cambia la hora — Cambiar.**
    Desde el "⋯" de History se puede editar **todo** de una toma pasada: hora,
    cantidad total y cuánto fue leche y cuánto fórmula. La app reacomoda sola:
    si baja la leche, la diferencia vuelve al biberón de donde salió; si cambia
    la fórmula, se ajusta el inventario. Si se pide más leche de la que hay,
    avisa y no guarda.

18. **El número no se cambia después — Aprobada.**
    Si se eligió el biberón equivocado, se borra y se anota de nuevo.

19. **No se borra una extracción ya dada — Aprobada.**
    Ejemplo: 3 oz en M2, se usaron 2 oz → no se puede borrar M2 ni bajarla a
    menos de 2 oz sin antes corregir esa toma. Subirla o cambiar hora o la
    división izquierdo/derecho siempre se puede.

**Sin internet y con dos celulares**

20. **Sin internet se guarda y cuenta — Aprobada.**
    Es raro (casi siempre extrae en casa), pero la app tiene que funcionar de
    viaje, por ejemplo en Yosemite.

21. **Dos a la vez: gana el primero — Aprobada.**

22. **Mismo número sin internet: se corrige — Aprobada.**
    (Con la regla 3, es "mismo biberón elegido sin internet".)

---

## Funciones nuevas

### Enfriado
- Al anotar una extracción, el biberón queda **"Enfriando"**.
- La app estima cuándo está fría según la cantidad (aprox. 2 oz ≈ 30–45 min,
  3 oz ≈ 45–60 min, 5 oz ≈ 60–90 min, al fondo del refri).
- Se puede confirmar antes con termómetro: lista a unos **40 °F (4 °C)**.
- Leche caliente **nunca** se mezcla con leche fría.

### Combinar biberones
- Se eligen dos o más biberones fríos y vigentes (ej. M5 + M6).
- Se elige en cuál se vierte (ej. M5): recibe el total y la **fecha de
  vencimiento de la leche más vieja**.
- El otro (M6) queda libre.
- "Lo que hay" no cambia; las estadísticas izquierdo/derecho quedan con las
  extracciones originales.

### Receta
- En "Hoy", la tarjeta de comida queda como antes, con una receta corta:
  **"2.5 oz leche + 1 oz Similac"**.
- **Si llora:**
  - Menos de **2 horas** desde la última toma → completar con **1 oz**.
  - **2 horas o más** → toma completa (objetivo normal, ej. 3.5 oz).
  - Los dos números se pueden ajustar.
- Usa solo leche fría y vigente; lo que falta es fórmula. Cada vez que Ana
  extrae, la receta cambia.

### Inventario de fórmula (Similac)
- Se anota la compra: **paquete de 6 botellas de 8 oz** (48 oz).
- Cada biberón descuenta la fórmula que usó.
- Muestra cuánta queda, cuánta toma por día y avisa cuando se está acabando.
- **"Abrí una Similac"** inicia **48 horas**; la receta usa primero la abierta y
  avisa antes de que venza. Inventario: "5 cerradas + 1 abierta con X oz".
- Un biberón empezado (leche o fórmula) dura **1 hora**; lo que sobra se
  descarta.

---

## Aprobación

- Papá: ☑ revisado
- Mamá: ☐ Aprobada ☐ Cambiar: ________
