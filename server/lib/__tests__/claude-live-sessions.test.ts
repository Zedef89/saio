import {test} from 'node:test'
import assert from 'node:assert/strict'
import {contaSessioniPerAccount, type ProcRow} from '../tmux-runtime'

test('quattro sessioni su c, una su m; window e wrapper contano una volta, Codex e letture quota esclusi', async () => {
 const names=['padre-alberto','madre-nicola','madre-alessandro','menu-situazione','altra','__saio-quota-test','codex']
 const panes=names.map((name,i)=>({name,pid:100+i*10}))
 panes.push({...panes[0]})
 const rows:ProcRow[]=panes.slice(0,7).flatMap((p,i)=>[
  {pid:p.pid,ppid:1,args:'bash'},
  {pid:p.pid+1,ppid:p.pid,args:i===6?'node /usr/bin/codex exec prompt su claude':'/usr/bin/claude'},
 ])
 const counts=await contaSessioniPerAccount(panes,rows,async pid=>pid===141?'/root/.claude-m':'/srv/taskless/account-claude/.claude-c')
 assert.deepEqual(counts,{c:4,m:1})
})
