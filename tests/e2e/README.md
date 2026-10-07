# tests/e2e — la matriz de layout

Mide, en un navegador de verdad, que **nada se encime**: ninguna capa tapa a otra,
ningún texto o control pisa a otro, nada se sale de la ventana. Nació el 7 oct
2026 por un reporte de Luis ("elementos nuevos se enciman en Inicio").

**No corre en `pnpm test:all`**, a propósito: necesita el build de producción, el
stack local y un chrome-headless-shell.

```bash
pnpm db:up                       # stack local con 0001–0016
pnpm build
pnpm test:layout                 # levanta `next start` en 127.0.0.1:3107 si no hay uno
```

Variables (todas opcionales):

| Variable | Default | Para qué |
|---|---|---|
| `E2E_VIEWPORTS` | `360x640,390x844,430x932,768x1024` | anchos×altos |
| `E2E_LANGS` | `es,en` | idioma de la app (`amelia:lang`) |
| `E2E_THEMES` | `dark,light` | tema (`amelia:theme`) |
| `E2E_PAGES` | las 12 pantallas | rutas a medir |
| `E2E_OUT` | `$TMPDIR/amelia-layout.json` | resultado celda por celda |
| `E2E_SHOTS` | — | carpeta: captura de cada celda que falla |
| `E2E_SHOTS_ALL` | — | con `E2E_SHOTS`, captura de todas |
| `E2E_PORT` | `3107` | puerto del `next start` |

## Qué arma

`seed.ts` crea dos familias descartables con **todos los estados de Inicio a la
vez** (el defecto era de combinación): leche caducada, fría, enfriando, una
combinación viva, biberón empezado vencido, Similac abierta por caducar con stock
bajo, sueño abierto, turno en menos de 36 h e historial largo. La familia A tiene
además una lactancia abierta (la receta y el biberón se esconden durante una
toma); la B, el panel del biberón abierto. Las dos, con un pañal anotado **sin
conexión** (cola pendiente, barra de sincronización). El reloj del navegador
queda fijo (`clock.setFixedTime`) un minuto después de la siembra.

Por cada página: tal cual, con el menú abierto (y Escape cierra y devuelve el
foco), y en Historial el ⋯ de la última fila, los dos encadenados (con puntero y
**sin puntero**, que es como activa un lector de pantalla) y Escape del ⋯.

## Qué mide (`audit.browser.js`)

| Medida | FAIL si |
|---|---|
| `hscroll` | la página scrollea en horizontal |
| `overlaps` | dos líneas de texto / controles / íconos del flujo se intersectan > 1 px en las dos dimensiones sin que uno contenga al otro |
| `layers` | dos capas (fixed/sticky/absolute) se intersectan; un menú abierto contra la barra |
| `covered` | un ítem de un menú abierto no es lo que está arriba en su centro (otra cosa lo tapa) |
| `offViewport` | algo se sale del ancho de la ventana, o la caja de un menú abierto del alto |
| `boxOverflow` | un contenedor cuyo contenido se sale (`scrollWidth − clientWidth > 1`) |
| `smallTargets` | un control habilitado de menos de 44 px en alguna dimensión |
| `lowContrast` | texto < 4,5:1 (3:1 si es grande o un glifo-ícono como ✓) con fondo y opacidad compuestos |
| `menusOpen` | más de un menú abierto a la vez |

Criterios que no son obvios y por qué:

- **Un menú abierto tapa lo que tiene debajo**: para eso existe. De un menú se
  mide que quede arriba y entero, no que no toque nada.
- **La barra sticky contra una capa en flujo** (el ícono de una tarjeta) no
  cuenta: cruzarse al scrollear es scroll.
- **Lo que está dentro de un `<details>` cerrado** no se pinta y no se mide
  (`checkVisibility`).
- **Un menú largo en un teléfono bajo scrollea por dentro**: cada ítem se trae a
  la vista dentro del menú antes de preguntar qué tiene encima.

Lo que **no** puede ver: WebKit/iOS, la PWA instalada, el teclado en pantalla y
`safe-area-inset-*` reales (en Chromium valen 0). Ver `docs/revision-ui-v5.md`.
