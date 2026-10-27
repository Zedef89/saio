import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('nessuna rete nelle liste; scelta esplicita condivisa e cache anche su aggiorna', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saio-usage-demand-'))
  const oldHome = process.env.HOME
  const oldData = process.env.DASHBOARD_DATA_DIR
  const oldReader = process.env.SAIO_QUOTA_READER
  process.env.HOME = dir
  process.env.DASHBOARD_DATA_DIR = path.join(dir, 'data')
  const counter = path.join(dir, ".claude", "count")
  const calls = async () => Number(await fs.readFile(counter, "utf8").catch(() => "0"))
  const mode = path.join(dir, ".claude", "mode.json")
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await fs.mkdir(path.join(dir, '.claude'))
    await fs.writeFile(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: 'test-only'}}))
    await fs.mkdir(path.join(dir, '.claude-0', 'projects'), {recursive: true})
    await fs.mkdir(path.join(dir, '.claude-default', 'projects'), {recursive: true})
    const reader = path.join(dir, 'reader.py')
    process.env.SAIO_QUOTA_READER = reader
    await fs.writeFile(mode, JSON.stringify({ok: true}))
    await fs.writeFile(reader, `import sys,json,time
from pathlib import Path
p=Path(sys.argv[1]);counter=p/'count'
counter.write_text(str(int(counter.read_text())+1) if counter.exists() else '1')
time.sleep(.02)
m=json.loads((p/'mode.json').read_text())
if m['ok']:
 print(json.dumps({'result':'ok','usage':{'weeklyPercent':25,'sessionPercent':10,'weeklyResetsAt':None,'severity':'normal'}}))
else:
 print(json.dumps({'result':'no-fresh-telemetry','windows':['rate limited until 2:31am'],'retryAt':m['retryAt']}))
`)
    const { listClaudeAccounts, aggiornaQuoteInBackground, aggiornamentoQuoteInCorso } = await import('../claude-accounts')
    const passive = await Promise.all(Array.from({length: 20}, () => listClaudeAccounts()))
    assert.equal(passive[0].length, 1, 'nessun account fantasma da cartelle projects o duplicato default')
    assert.equal(await calls(), 0, 'la lista sessioni non interroga Anthropic')
    const results = await Promise.all(Array.from({length: 20}, () => listClaudeAccounts(true)))
    assert.equal(await calls(), 1, 'una sola lettura per venti richieste simultanee')
    assert.equal(results[0][0].usage?.weeklyPercent, 25)
    await listClaudeAccounts(true)
    assert.equal(await calls(), 1, 'aggiorna rispetta la cache')
    now += 6 * 60_000
    await listClaudeAccounts()
    assert.equal(await calls(), 1, 'neanche una cache scaduta provoca richieste passive')
    await fs.writeFile(mode, JSON.stringify({ok: false, retryAt: now + 1105_000}))
    await listClaudeAccounts(true)
    assert.equal(await calls(), 2)
    now += 6 * 60_000
    await listClaudeAccounts(true)
    assert.equal(await calls(), 2, 'Retry-After rispettato anche nelle scelte esplicite')
    await fs.writeFile(path.join(dir, '.claude', 'saio-usage-local.json'), JSON.stringify({
      at: now, usage: {weeklyPercent: 78, sessionPercent: 61, weeklyResetsAt: null, severity: 'warning'},
    }))
    const local = await listClaudeAccounts()
    assert.equal(local[0].usage?.weeklyPercent, 78)
    assert.equal(local[0].usage?.sessionPercent, 61)
    assert.equal(local[0].stale, undefined)
    const explicitLocal = await listClaudeAccounts(true)
    assert.equal(explicitLocal[0].usage?.sessionPercent, 61)
    assert.equal(await calls(), 2, 'dati statusline nuovi visibili subito, senza rete anche su aggiorna')
    now += 1
    await fs.writeFile(path.join(dir, '.claude', 'saio-usage-local.json'), JSON.stringify({
      at: now, usage: {weeklyPercent: 72, sessionPercent: null, weeklyResetsAt: null, severity: 'normal'},
    }))
    const partial = await listClaudeAccounts()
    assert.equal(partial[0].usage?.weeklyPercent, 72)
    assert.equal(partial[0].usage?.sessionPercent, null, 'finestra assente non trasformata in zero')
    assert.equal(await calls(), 2)
    now += 21 * 60_000
    await fs.writeFile(mode, JSON.stringify({ok: true}))
    aggiornaQuoteInBackground()
    const during = await listClaudeAccounts()
    assert.equal(during[0].usage?.weeklyPercent, 72, 'la UI riceve subito il vecchio dato con la sua età')
    assert.equal(during[0].stale, true)
    for (let i = 0; i < 100 && aggiornamentoQuoteInCorso(); i++) await new Promise(r => setTimeout(r, 20))
    assert.equal(aggiornamentoQuoteInCorso(), false)
    assert.equal(await calls(), 3)
    const after = await listClaudeAccounts()
    assert.equal(after[0].usage?.weeklyPercent, 25)


  } finally {
    Date.now = realNow
    if (oldReader === undefined) delete process.env.SAIO_QUOTA_READER; else process.env.SAIO_QUOTA_READER = oldReader
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
    if (oldData === undefined) delete process.env.DASHBOARD_DATA_DIR; else process.env.DASHBOARD_DATA_DIR = oldData
    await fs.rm(dir, {recursive: true, force: true})
  }
})
