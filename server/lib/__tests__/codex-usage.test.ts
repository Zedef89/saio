import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUsageReader, normalizeUsage, readSessionUsage } from '../codex-usage'

const raw = { primary: { used_percent: 77, window_minutes: 10080, resets_at: 123 }, plan_type: 'pro', credits: { has_credits: false, unlimited: false, balance: '0' } }
test('normalizes official and rollout quota, including short window and zero credits', () => {
  const usage = normalizeUsage({ ...raw, secondary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 456 } }, '2026-10-13T00:00:00Z', 'sessions')!
  assert.equal(usage.primary?.usedPercent, 77)
  assert.equal(usage.secondary?.windowMinutes, 300)
  assert.equal(usage.credits?.balance, '0')
  assert.equal(usage.plan, 'pro')
  assert.equal(normalizeUsage({}, '', 'sessions'), null)
})
test('selects latest timestamp across all files, ignores malformed/incomplete events', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'saio-quota-'))
  try {
    await mkdir(path.join(dir, '2026/10/13'), { recursive: true })
    const event = (timestamp: string, used: number) => JSON.stringify({ timestamp, payload: { rate_limits: { ...raw, primary: { ...raw.primary, used_percent: used } } } })
    await writeFile(path.join(dir, '2026/10/13/a.jsonl'), event('2026-10-13T01:00:00Z', 80) + '\n{"rate_limits":\n')
    await writeFile(path.join(dir, 'b.jsonl'), event('2026-10-12T01:00:00Z', 50) + '\n' + event('2026-10-13T03:00:00Z', 90))
    assert.equal((await readSessionUsage(dir))?.primary?.usedPercent, 90)
    assert.equal(await readSessionUsage(path.join(dir, 'missing')), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('shares concurrent refresh, caches for 60s, falls back without changing observation time', async () => {
  let calls = 0, time = 0
  const observation = normalizeUsage(raw, '2026-10-12T00:00:00Z', 'sessions')!
  const read = createUsageReader(async () => { calls++; return null }, async () => observation, () => time)
  const values = await Promise.all([read(), read()])
  assert.equal(calls, 1)
  assert.equal(values[0]?.updatedAt, observation.updatedAt)
  time = 59_999; await read(); assert.equal(calls, 1)
  time = 60_000; await read(); assert.equal(calls, 2)
})
