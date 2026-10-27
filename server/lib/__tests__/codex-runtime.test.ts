import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyScreen, findCodexPid } from '../tmux-runtime'
const footer = '\n› Ask Codex to do anything\nGPT-6.1-Sol default · ~/dev\n← for agents · ? for shortcuts'
test('Codex working, idle and previous question resolved', () => {
  assert.equal(classifyScreen('• Working (11s • esc to interrupt)' + footer).activity, 'working')
  assert.equal(classifyScreen('• Waiting for background terminal (9m 50s • esc to interrupt) · 2 background terminals\n  └ git diff --check; git diff --stat HEAD; rg testi\n  └ Tip: Use /statusline to configure which items appear in the status line.' + footer).activity, 'working')
  assert.equal(classifyScreen('• Correzione completata.\nWorked for 4s' + footer).activity, 'idle')
  assert.equal(classifyScreen('Vuoi che proceda?\n› procedi\n• Modifica completata.' + footer).activity, 'idle')
})
test('Codex approval and explicit pending question', () => {
  assert.equal(classifyScreen('Would you like to run the following command?\n› 1. Yes\n  2. No\nGPT-6.1-Sol').activity, 'waiting')
  assert.equal(classifyScreen('• Confermi che posso procedere?' + footer).activity, 'waiting')
})
test('Codex process in descendants; shell prompt text is not a process', () => {
  assert.equal(findCodexPid([{pid:1,ppid:0,args:'bash -c codex'}, {pid:2,ppid:1,args:'node /usr/bin/codex'}, {pid:3,ppid:2,args:'/opt/codex/codex'}],1),2)
  assert.equal(findCodexPid([{pid:1,ppid:0,args:'bash -c echo codex'}, {pid:2,ppid:1,args:'claude -p fix codex'}],1),null)
})
