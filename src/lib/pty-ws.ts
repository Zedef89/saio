/**
 * Costruisce l'URL WebSocket per la sessione PTY (`/api/pty/<projectId>`).
 *
 * Tre contesti di esecuzione:
 *  - Pagina HTTPS (accesso via Cloudflare Tunnel, es. https://saio.nicolamele.com):
 *    usa `wss://` sullo STESSO host/porta della pagina (443). Il tunnel inoltra a
 *    127.0.0.1:3031. Un `ws://` da pagina HTTPS è mixed content e viene bloccato dal
 *    browser con "The operation is insecure." (SecurityError) → crash del render.
 *  - Dev browser (http://127.0.0.1:3030): backend Express su :3031 → `ws://127.0.0.1:3031`.
 *  - Webview desktop (tauri://localhost): la CSP autorizza solo 127.0.0.1 → `ws://127.0.0.1:3031`.
 */
export function ptyWsUrl(projectId: string, params?: URLSearchParams): string {
  const qs = params && params.toString() ? `?${params.toString()}` : ''
  const path = `/api/pty/${encodeURIComponent(projectId)}${qs}`
  if (window.location.protocol === 'https:') {
    return `wss://${window.location.host}${path}`
  }
  return `ws://127.0.0.1:3031${path}`
}
