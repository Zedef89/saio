/**
 * Apre una sessione tmux con dentro gia' il lavoro da fare, dalla riga di comando.
 *
 * E' la stessa cosa che fa `POST /system/tmux-sessions` con `prompt`, ma senza passare dal
 * server: serve per provare il giro (e per aprirne una a mano) quando SAIO sta girando con
 * un'altra versione del codice.
 *
 *   npx tsx scripts/apri-sessione-con-prompt.ts <nome> <cwd> <account> <file-del-prompt> [email]
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import { TMUX_BIN } from '../server/lib/tmux-bin'
import { withPermissionMode } from '../server/lib/pty-manager'
import { writeIdentityFile, withIdentityFile } from '../server/lib/session-identity'
import { configDirForAccount } from '../server/lib/claude-accounts'
import { inviaPrompt } from '../server/lib/prompt-in-sessione'

const exec = promisify(execFile)
const DATA = '/root/dev/saio/src-repo/data'

const [nome, cwd, account, fileP, email] = process.argv.slice(2)
const EMAIL = email || null

;(async () => {
  const configDir = await configDirForAccount(account)
  if (!configDir) throw new Error(`account sconosciuto: ${account}`)
  let cmd = `CLAUDE_CONFIG_DIR='${configDir}' claude`
  cmd = withPermissionMode(cmd)
  cmd = withIdentityFile(cmd, await writeIdentityFile(DATA, EMAIL || undefined))

  // `-x`/`-y`: senza nessuno attaccato la pane resta stretta e la CLI tronca la barra di
  // stato, che e' il modo in cui si capisce se sta lavorando. Vedi routes/system.ts.
  await exec(TMUX_BIN, ['new-session', '-d', '-s', nome, '-c', cwd, '-x', '200', '-y', '50'])
  await exec(TMUX_BIN, ['send-keys', '-t', nome, cmd, 'Enter'])
  console.log(`sessione ${nome} creata in ${cwd} (account ${account})`)

  const testo = fs.readFileSync(fileP, 'utf8')
  const esito = await inviaPrompt(DATA, nome, testo)
  console.log('prompt:', JSON.stringify(esito))
})()
