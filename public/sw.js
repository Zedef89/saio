// SAIO service worker — 2026-09-15.
// Esiste per UN motivo solo: senza un SW con handler `fetch`, Chrome su Android
// non offre "Installa app" ma una semplice scorciatoia, che riapre il sito dentro
// il browser (barra URL, pull-to-refresh, scroll del documento).
// NON fa cache di proposito: SAIO parla con un backend locale e dietro Cloudflare
// Access, una risposta servita da cache sarebbe peggio di un errore.
const SW_VERSION = 'saio-v1-nocache'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Butta qualsiasi cache lasciata da versioni precedenti del SW.
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
      await self.clients.claim()
    })()
  )
})

// Passthrough puro: la rete è l'unica fonte di verità.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(fetch(event.request))
})

self.addEventListener('message', (event) => {
  if (event.data === 'sw-version') {
    event.source?.postMessage(SW_VERSION)
  }
})
