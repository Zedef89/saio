// SAIO macOS/Tauri fix (beta.7 packaging bug):
// In production the window is served from the tauri:// asset protocol, so relative
// `/api` and `/events` requests hit the asset handler instead of the Express backend
// on 127.0.0.1:3031 — the app is stuck on "Backend non raggiungibile".
// When not running over http(s) (i.e. inside the packaged app), rewrite those
// relative requests to the backend origin. Imported first in main.tsx so the patch
// is installed before any component fires a request.
const isWeb = location.protocol === 'http:' || location.protocol === 'https:'

if (!isWeb && typeof window !== 'undefined') {
  const BACKEND = 'http://127.0.0.1:3031'
  const needsRewrite = (p: string) => p.startsWith('/api') || p.startsWith('/events')

  // fetch()
  const origFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      if (typeof input === 'string') {
        if (needsRewrite(input)) return origFetch(BACKEND + input, init)
      } else if (input instanceof URL) {
        if (needsRewrite(input.pathname)) return origFetch(BACKEND + input.pathname + input.search, init)
      } else if (input instanceof Request) {
        const u = new URL(input.url, location.href)
        if (!u.protocol.startsWith('http') && needsRewrite(u.pathname)) {
          return origFetch(new Request(BACKEND + u.pathname + u.search, input), init)
        }
      }
    } catch { /* fall through to original */ }
    return origFetch(input as RequestInfo | URL, init)
  }) as typeof window.fetch

  // EventSource() — SSE streams on /events and /api/*/stream
  const OrigES = window.EventSource
  if (OrigES) {
    window.EventSource = new Proxy(OrigES, {
      construct(target, args: [string | URL, EventSourceInit?]) {
        try {
          if (typeof args[0] === 'string' && needsRewrite(args[0])) args[0] = BACKEND + args[0]
        } catch { /* ignore */ }
        return new (target as typeof EventSource)(...args)
      },
    })
  }
}

export {}
