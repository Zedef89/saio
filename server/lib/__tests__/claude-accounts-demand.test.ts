import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('nessuna rete nelle liste; scelta esplicita condivisa e cache anche su aggiorna', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saio-usage-demand-'))
  const oldHome = process.env.HOME
  const oldData = process.env.DASHBOARD_DATA_DIR
  const oldFetch = globalThis.fetch
  process.env.HOME = dir
  process.env.DASHBOARD_DATA_DIR = path.join(dir, 'data')
  let calls = 0
  let status = 200
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await fs.mkdir(path.join(dir, '.claude'))
    await fs.writeFile(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: 'test-only'}}))
    globalThis.fetch = async () => {
      calls++
      await new Promise(r => setTimeout(r, 10))
      return new Response(JSON.stringify({seven_day: {utilization: 25}, five_hour: {utilization: 10}}), {
        status, headers: status === 429 ? {'retry-after': '1105'} : {},
      })
    }
    const { listClaudeAccounts } = await import('../claude-accounts')
    await Promise.all(Array.from({length: 20}, () => listClaudeAccounts()))
    assert.equal(calls, 0, 'la lista sessioni non interroga Anthropic')
    const results = await Promise.all(Array.from({length: 20}, () => listClaudeAccounts(true)))
    assert.equal(calls, 1, 'una sola lettura per venti richieste simultanee')
    assert.equal(results[0][0].usage?.weeklyPercent, 25)
    await listClaudeAccounts(true)
    assert.equal(calls, 1, 'aggiorna rispetta la cache')
    now += 6 * 60_000
    await listClaudeAccounts()
    assert.equal(calls, 1, 'neanche una cache scaduta provoca richieste passive')
    status = 429
    await listClaudeAccounts(true)
    assert.equal(calls, 2)
    now += 6 * 60_000
    await listClaudeAccounts(true)
    assert.equal(calls, 2, 'Retry-After rispettato anche nelle scelte esplicite')
  } finally {
    Date.now = realNow
    globalThis.fetch = oldFetch
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
    if (oldData === undefined) delete process.env.DASHBOARD_DATA_DIR; else process.env.DASHBOARD_DATA_DIR = oldData
    await fs.rm(dir, {recursive: true, force: true})
  }
})
