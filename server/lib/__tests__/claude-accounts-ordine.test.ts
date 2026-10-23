import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attesaDopo429, ordineLettura } from '../claude-accounts'

const slots = ['default', 'b', 'c', 'd', 'f', 'i', 'j'].map((id) => ({ id }))
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

test('g634: il giro parte da chi ha la lettura piu\' vecchia, non sempre da default', () => {
  // default, b, c letti un minuto fa; f, i, j fermi da tre ore; d mai letto.
  const snaps = { default: { at: 1_000 }, b: { at: 1_001 }, c: { at: 1_002 }, f: { at: 10 }, i: { at: 11 }, j: { at: 12 } }
  assert.deepEqual(ids(ordineLettura(slots, snaps)), ['d', 'f', 'i', 'j', 'default', 'b', 'c'])
})

test('g634: dopo tre letture e un 429, il giro dopo legge gli altri', () => {
  const snaps: Record<string, { at: number }> = {}
  const letti: string[][] = []
  for (let giro = 1; giro <= 3; giro++) {
    const questi = ids(ordineLettura(slots, snaps)).slice(0, 3) // al quarto arriva il 429
    for (const id of questi) snaps[id] = { at: giro * 100 + questi.indexOf(id) }
    letti.push(questi)
  }
  assert.deepEqual(new Set(letti.flat()), new Set(ids(slots)))
})

test('g634: chi risponde 401 va in fondo, non si mangia il primo posto di ogni giro', () => {
  const snaps = { d: { at: 0 }, f: { at: 10 }, i: { at: 11 } }
  const tre = [{ id: 'd' }, { id: 'f' }, { id: 'i' }]
  assert.deepEqual(ids(ordineLettura(tre, snaps, { d: 500 })), ['f', 'i', 'd'])
})

test('g634: l\'attesa dopo un 429 e\' dell\'account, e rispetta Retry-After quando e\' piu\' lunga', () => {
  assert.equal(attesaDopo429(0, null), 2 * 60_000)
  assert.equal(attesaDopo429(1, null), 5 * 60_000)
  assert.equal(attesaDopo429(9, null), 20 * 60_000)
  assert.equal(attesaDopo429(0, '1105'), 1_105_000) // quel che diceva d alle 16:59
  assert.equal(attesaDopo429(3, '30'), 20 * 60_000) // Retry-After corto: vale la scala
  assert.equal(attesaDopo429(0, 'Fri, 23 Oct 2026 17:20:00 GMT'), 2 * 60_000) // data HTTP: si ignora
})
