/**
 * lib/format.ts formatea con el locale del sistema (`[]`). Un locale que no
 * sea en-* cambia el texto de salida y haría fallar los tests por una razón
 * que no es un bug del código. Se verifica una vez, con un mensaje que dice
 * exactamente qué hacer.
 */
export function assertEnglishLocale(): void {
  const locale = new Intl.DateTimeFormat().resolvedOptions().locale
  if (!locale.startsWith('en')) {
    throw new Error(
      `Estos tests asumen un locale en-* y el entorno resolvió "${locale}". ` +
        'Corré la suite con LANG=en_US.UTF-8.',
    )
  }
}

/** La TZ bajo la que corre esta ejecución — las cuatro pasadas la cambian. */
export const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
