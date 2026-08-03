import { Router } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { MCPStatus } from '../../shared/schemas'

interface MCPConfig {
  name: string
  url?: string
  transport?: string
  authBearer?: boolean
  local?: boolean
  source: string
}

async function loadMcpsFromSettings(): Promise<MCPConfig[]> {
  // I server MCP di Claude Code stanno in ~/.claude.json (mcpServers), NON in
  // ~/.claude/settings.json. Leggiamo entrambi e uniamo (dedup per nome), così
  // il conteggio riflette i server realmente configurati.
  const home = os.homedir()
  const sources = [
    { path: path.join(home, '.claude.json'), label: '.claude.json' },
    { path: path.join(home, '.claude', 'settings.json'), label: 'settings.json' },
  ]
  const results: MCPConfig[] = []
  const seen = new Set<string>()
  for (const src of sources) {
    try {
      const raw = await fs.readFile(src.path, 'utf8')
      const parsed = JSON.parse(raw)
      const servers = parsed.mcpServers || {}
      for (const [name, cfg] of Object.entries<any>(servers)) {
        if (seen.has(name)) continue
        seen.add(name)
        const entry: MCPConfig = { name, source: src.label }
        if (cfg.type === 'http' && cfg.url) {
          entry.url = cfg.url
          entry.transport = 'http'
        } else if (cfg.command === 'npx' && Array.isArray(cfg.args)) {
          const idx = cfg.args.indexOf('--streamableHttp')
          if (idx !== -1 && cfg.args[idx + 1]) {
            entry.url = cfg.args[idx + 1]
            entry.transport = 'streamableHttp'
            entry.authBearer = cfg.args.includes('--header')
          } else {
            entry.transport = 'stdio-npx'
            entry.local = true
            entry.url = cfg.args.slice(0, 3).join(' ') + '...'
          }
        } else if (cfg.command) {
          entry.transport = 'stdio'
          entry.local = true
        }
        results.push(entry)
      }
    } catch {
      /* file mancante o non parsabile: skip */
    }
  }
  return results
}

async function probe(target: MCPConfig): Promise<MCPStatus> {
  const now = new Date().toISOString()
  if (target.local || !target.url?.startsWith('http')) {
    return {
      name: target.name,
      url: target.url,
      status: 'healthy',
      latencyMs: 0,
      lastCheck: now,
    }
  }
  const start = Date.now()
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const r = await fetch(target.url, { signal: ctrl.signal }).catch((e) => ({ ok: false, status: 0, error: e } as any))
    clearTimeout(t)
    const latencyMs = Date.now() - start
    const ok = r.ok || r.status === 200 || r.status === 401 || r.status === 405
    return {
      name: target.name,
      url: target.url,
      status: ok ? 'healthy' : 'degraded',
      latencyMs,
      lastCheck: now,
    }
  } catch (err) {
    return {
      name: target.name,
      url: target.url,
      status: 'down',
      lastCheck: now,
      error: String(err),
    }
  }
}

export function mcpRouter() {
  const router = Router()

  router.get('/status', async (_req, res) => {
    const targets = await loadMcpsFromSettings()
    const results = await Promise.all(targets.map(probe))
    res.json({
      mcps: results.map((r, i) => ({ ...r, transport: targets[i].transport })),
      source: 'settings.json',
      count: results.length,
      checkedAt: new Date().toISOString(),
    })
  })

  return router
}
