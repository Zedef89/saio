/**
 * Registrazione del service worker — 2026-09-15.
 *
 * Il SW non fa cache (vedi public/sw.js): serve solo a rendere SAIO installabile.
 * Chrome su Android mostra "Installa app" — e quindi apre la webapp senza barra
 * URL e senza pull-to-refresh — solo se trova manifest + SW con handler fetch.
 * Senza, "Aggiungi a schermata Home" crea una scorciatoia che riapre il browser.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  // Il SW richiede un contesto sicuro: https, oppure localhost in sviluppo.
  if (!window.isSecureContext) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('[pwa] registrazione service worker fallita:', err)
    })
  })
}

/** True quando SAIO gira come app installata (schermata Home, niente barra URL). */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari non espone display-mode: usa una proprieta' non standard su navigator.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}
