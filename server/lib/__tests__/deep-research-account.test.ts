import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { researchAccount, accountCommand } from '../deep-research-account'

const accounts = [
  { id: 'default', usage: { weeklyPercent: 100, sessionPercent: 0 } },
  { id: 'b', usage: { weeklyPercent: 20, sessionPercent: 40 } },
  { id: 'c', usage: { weeklyPercent: 70, sessionPercent: 0 } },
]
test('default esaurito: sceglie un account con entrambe le finestre libere', () => {
  assert.equal(researchAccount(accounts), 'b')
  assert.equal(researchAccount(accounts, 'c'), 'c')
  assert.throws(() => researchAccount(accounts, 'default'))
  assert.throws(() => researchAccount([{ id: 'b', usage: { weeklyPercent: 0, sessionPercent: 100 } }]))
  assert.throws(() => researchAccount([{ id: 'b', usage: null }]))
  assert.throws(() => researchAccount(accounts, '../../altro'))
})
test('la CLI riceve proprio la config selezionata, anche con spazi e apici', () => {
  const dir = "/tmp/account con 'apice'"
  const command = accountCommand(dir, "node -e 'process.stdout.write(process.env.CLAUDE_CONFIG_DIR)' ")
  assert.equal(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }), dir)
})
