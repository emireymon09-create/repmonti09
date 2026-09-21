// Sin 'use client' a propósito, igual que lib/themeBoot.ts: app/layout.tsx
// (server) necesita el string. Tiene que decidir EXACTAMENTE lo mismo que
// resolveLang() en lib/i18n/index.ts — tests/unit/i18n.test.ts corre este
// script contra esa función para que no se separen.

export const LANG_KEY = 'amelia:lang'

/**
 * How long the page may stay hidden waiting for the app to switch to a
 * non-English language. Past this it shows anyway (in English until the
 * JavaScript arrives): a blank screen at 3am is worse than a flash.
 */
export const LANG_PENDING_MAX_MS = 1500

/**
 * Runs in <head> before first paint (app/layout.tsx). The server always
 * renders English — pages are static and cached by the service worker, so
 * it can't know a device's saved choice — so when this device resolves to
 * another language the script sets <html lang> and hides the body
 * (`data-lang-pending`, app/globals.css) until I18nProvider has re-rendered
 * in that language. No English→Spanish flash, and no hydration mismatch:
 * React hydrates the English markup it expects, then switches.
 */
export const LANG_BOOT_SCRIPT = `(function(){var d=document.documentElement;var c=null;try{c=localStorage.getItem('${LANG_KEY}')}catch(e){}var l='en';if(c==='en'||c==='es'){l=c}else{try{var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||''];for(var i=0;i<n.length;i++){var p=String(n[i]||'').toLowerCase();if(p.indexOf('es')===0){l='es';break}if(p.indexOf('en')===0)break}}catch(e){}}d.lang=l;if(l!=='en'){d.setAttribute('data-lang-pending','');setTimeout(function(){d.removeAttribute('data-lang-pending')},${LANG_PENDING_MAX_MS})}})()`
