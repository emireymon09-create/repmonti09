import { color, lightColor } from '@/lib/tokens'

// Sin 'use client' a propósito: app/layout.tsx (server) necesita el string,
// no una referencia de cliente. El hook que lo usa vive en lib/theme.ts.

export const THEME_KEY = 'amelia:theme'

/**
 * Runs in <head> before first paint (app/layout.tsx), so a saved light
 * theme never flashes dark on load. Kept tiny and dependency-free on
 * purpose: it is inlined as a string. No saved choice → no attribute →
 * the dark palette, exactly as before the light theme existed.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark'||t==='system'){document.documentElement.setAttribute('data-theme',t);var l=t==='light'||(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',l?'${lightColor.bg}':'${color.bg}')}}catch(e){}})()`
