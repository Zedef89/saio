import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type {
  ITaskScheduler,
  ScheduledTask,
  ScheduleSpec,
  WeekDay,
  OperationResult,
} from '../types'
import { LinuxElevator } from './elevator'

const execAsync = promisify(exec)

/** Timer di sistema Ubuntu: rumore vendor, non automazioni dell'utente. */
const VENDOR_TIMERS =
  /^(apt-daily|dpkg-db-backup|e2scrub|fstrim|logrotate|man-db|motd-news|systemd-|mdcheck|mdmonitor|certbot|snapd|ua-|update-notifier|anacron|plocate|sysstat-|launchpadlib-|apport-)/

const WEEKDAYS: Record<string, { spec: WeekDay; label: string }> = {
  Mon: { spec: 'MON', label: 'lunedì' },
  Tue: { spec: 'TUE', label: 'martedì' },
  Wed: { spec: 'WED', label: 'mercoledì' },
  Thu: { spec: 'THU', label: 'giovedì' },
  Fri: { spec: 'FRI', label: 'venerdì' },
  Sat: { spec: 'SAT', label: 'sabato' },
  Sun: { spec: 'SUN', label: 'domenica' },
}

/**
 * `ExecStart={ path=/bin/bash ; argv[]=/bin/bash /root/script.sh ; ignore_errors=no ; … }`
 * → `/bin/bash /root/script.sh`
 */
function parseExecStart(raw: string | undefined): string {
  if (!raw) return ''
  return /argv\[\]=([^;]+)/.exec(raw)?.[1]?.trim() ?? ''
}

/**
 * Ricava schedule reale e label leggibile dalle proprietà di un `.timer`:
 * - `TimersCalendar={ OnCalendar=*-*-* 23:50:00 Europe/Rome ; next_elapse=… }`
 * - `TimersMonotonic={ OnUnitActiveUSec=15min ; next_elapse=… }`
 * Il fuso è esplicitato in label quando presente nell'unit: la VPS è in UTC ma i
 * timer migrati usano `Europe/Rome`, altrimenti l'orario mostrato sarebbe fuorviante.
 */
function parseTimerSchedule(props: Record<string, string[]>): { spec: ScheduleSpec; label?: string } {
  const calendar = props.TimersCalendar?.map((v) => /OnCalendar=([^;]+)/.exec(v)?.[1]?.trim()).find(Boolean)
  if (calendar) {
    const tokens = calendar.split(/\s+/)
    let dow: string | undefined
    if (tokens[0] && !tokens[0].includes('-') && !tokens[0].includes(':')) dow = tokens.shift()
    const datePart = tokens.find((t) => t.includes('-'))
    const timePart = tokens.find((t) => t.includes(':'))
    const tz = tokens.find((t) => t !== datePart && t !== timePart)
    const suffix = tz ? ` (${tz})` : ''

    const hm = timePart ? /^(\d{1,2}):(\d{2})/.exec(timePart) : null
    // Espressioni tipo `*:0/15` o liste `08,20:00` non stanno in uno ScheduleSpec: si tiene la label grezza.
    if (!hm || /[/,]/.test(timePart ?? '')) {
      return { spec: { type: 'DAILY' }, label: `${calendar}` }
    }
    const time = `${hm[1]!.padStart(2, '0')}:${hm[2]}`

    const day = dow ? WEEKDAYS[dow.split(/[,.]/)[0] ?? ''] : undefined
    if (day) return { spec: { type: 'WEEKLY', time, day: day.spec }, label: `Ogni ${day.label} ${time}${suffix}` }

    const dayOfMonth = datePart ? /-(\d{1,2})$/.exec(datePart)?.[1] : undefined
    if (dayOfMonth) {
      return {
        spec: { type: 'MONTHLY', time, dayOfMonth },
        label: `Ogni mese, giorno ${dayOfMonth}, ${time}${suffix}`,
      }
    }
    return { spec: { type: 'DAILY', time }, label: `Ogni giorno ${time}${suffix}` }
  }

  const monotonic = props.TimersMonotonic ?? []
  const interval = monotonic.map((v) => /OnUnitActiveUSec=([^;]+)/.exec(v)?.[1]?.trim()).find(Boolean)
  if (interval) return { spec: { type: 'DAILY' }, label: `Ogni ${interval}` }
  const boot = monotonic.map((v) => /OnBootUSec=([^;]+)/.exec(v)?.[1]?.trim()).find(Boolean)
  if (boot) return { spec: { type: 'ONCE' }, label: `${boot} dopo il boot` }

  return { spec: { type: 'DAILY' } }
}

/**
 * Linux Task Scheduler: usa **systemd-timer user-level** in
 * `~/.config/systemd/user/`. Non richiede root (user services).
 *
 * Per ogni task crea 2 file:
 * - `<name>.service` — definisce il comando da eseguire
 * - `<name>.timer` — definisce il calendar schedule
 *
 * Esempio nome: `saio-Obsidian-Anthropic-Weekly.timer`
 *
 * Operazioni:
 * - create: scrive .service + .timer files, `systemctl --user daemon-reload`, `systemctl --user enable --now <name>.timer`
 * - delete: `systemctl --user disable --now <name>.timer`, rimuove i file
 * - enable/disable: `systemctl --user enable/disable <name>.timer`
 * - run: `systemctl --user start <name>.service`
 * - list: legge `systemctl --user list-timers`
 *
 * Fallback opzionale a `crontab -l/-e` se systemd non disponibile (raro).
 */
export class LinuxTaskScheduler implements ITaskScheduler {
  private unitDir: string

  constructor(_elevator: LinuxElevator) {
    this.unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  }

  async list(): Promise<ScheduledTask[]> {
    const tasks: ScheduledTask[] = []
    // Due scope: user-level (timer creati da SAIO in ~/.config/systemd/user) e system-level
    // (le automazioni migrate dal Mac — worklog, vault-sync, komanda-* — vivono in /etc/systemd/system).
    for (const userScope of [true, false]) {
      const flag = userScope ? '--user ' : ''
      let stdout = ''
      try {
        ;({ stdout } = await execAsync(`systemctl ${flag}list-timers --all --no-pager --no-legend`, {
          encoding: 'utf-8',
        }))
      } catch {
        continue // scope non disponibile (es. nessuna sessione utente): si prova l'altro
      }

      const rows: { timer: string; next?: string; last?: string }[] = []
      for (const line of String(stdout).split(/\r?\n/)) {
        // Le colonne NEXT/LEFT/LAST/PASSED sono multi-token e variabili ("2h 11min", "2min 7s ago", "-"):
        // ci si ancora agli ultimi due campi (unit + activates), i timestamp si estraggono a parte.
        const m = /(\S+)\.timer\s+(\S+)\.service\s*$/.exec(line.trim())
        if (!m) continue
        const timer = m[1]!
        if (VENDOR_TIMERS.test(timer)) continue
        // "Mon 2026-08-03 12:10:00 UTC" → il primo timestamp è NEXT, il secondo LAST ("-" se assente)
        const stamps = line.match(/[A-Z][a-z]{2}\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\s\S+/g) ?? []
        rows.push({ timer, next: stamps[0], last: stamps[1] })
      }
      if (!rows.length) continue

      // Una sola `systemctl show` per scope: schedule reale (OnCalendar/OnUnitActiveSec) e comando.
      const timerProps = await this.showUnits(flag, rows.map((r) => `${r.timer}.timer`), [
        'Id',
        'Description',
        'UnitFileState',
        'ActiveState',
        'TimersCalendar',
        'TimersMonotonic',
      ])
      const svcProps = await this.showUnits(flag, rows.map((r) => `${r.timer}.service`), ['Id', 'ExecStart'])

      for (const r of rows) {
        const name = r.timer.replace(/^saio-/, '')
        if (tasks.some((t) => t.name === name)) continue
        const p = timerProps.get(`${r.timer}.timer`) ?? {}
        const { spec, label } = parseTimerSchedule(p)
        const fileState = p.UnitFileState?.[0]
        const activeState = p.ActiveState?.[0]
        tasks.push({
          name,
          command: parseExecStart(svcProps.get(`${r.timer}.service`)?.ExecStart?.[0]),
          schedule: spec,
          scheduleLabel: label,
          state: fileState === 'disabled' || (activeState && activeState !== 'active') ? 'disabled' : 'ready',
          // I timer non creati da SAIO sono automazioni utente esterne: `cron` le esclude dal
          // filtro per naming di routes/cron.ts (stesso trattamento dei LaunchAgent su macOS).
          source: r.timer.startsWith('saio-') ? 'saio' : 'cron',
          managed: true,
          description: p.Description?.[0] || `Timer systemd${userScope ? ' utente' : ''}: ${r.timer}`,
          nextRunAt: r.next,
          lastRunAt: r.last,
        })
      }
    }
    return tasks
  }

  /**
   * `systemctl show` su più unit in una chiamata sola. Restituisce una mappa
   * unit → proprietà; i valori sono array perché systemd può ripetere la stessa
   * chiave (es. due `TimersMonotonic` per OnUnitActiveSec + OnBootSec).
   */
  private async showUnits(
    flag: string,
    units: string[],
    props: string[],
  ): Promise<Map<string, Record<string, string[]>>> {
    const out = new Map<string, Record<string, string[]>>()
    if (!units.length) return out
    const args = props.map((p) => `-p ${p}`).join(' ')
    let stdout = ''
    try {
      ;({ stdout } = await execAsync(`systemctl ${flag}show ${units.join(' ')} ${args} --no-pager`, {
        encoding: 'utf-8',
      }))
    } catch {
      return out
    }
    // Blocchi separati da riga vuota, uno per unit; `Id=` identifica l'unit.
    for (const block of String(stdout).split(/\n\s*\n/)) {
      const entry: Record<string, string[]> = {}
      for (const line of block.split(/\r?\n/)) {
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq)
        const value = line.slice(eq + 1)
        if (!value) continue
        ;(entry[key] ??= []).push(value)
      }
      const id = entry.Id?.[0]
      if (id) out.set(id, entry)
    }
    return out
  }

  async get(name: string): Promise<ScheduledTask | null> {
    const list = await this.list()
    return list.find((t) => t.name === name) || null
  }

  async create(task: Omit<ScheduledTask, 'state' | 'lastRunAt' | 'lastResult'>): Promise<OperationResult> {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(task.name)) {
      return { ok: false, error: 'name 3-64 char alphanum/dash/underscore' }
    }
    const unitName = `saio-${task.name}`
    const serviceFile = path.join(this.unitDir, `${unitName}.service`)
    const timerFile = path.join(this.unitDir, `${unitName}.timer`)

    const onCalendar = this.scheduleToOnCalendar(task.schedule)
    const description = task.description || `SAIO scheduled task: ${task.name}`

    const serviceContent = `[Unit]
Description=${description}
After=network-online.target

[Service]
Type=oneshot
ExecStart=${task.command}

[Install]
WantedBy=default.target
`

    const timerContent = `[Unit]
Description=Timer for ${unitName}

[Timer]
OnCalendar=${onCalendar}
Persistent=true
Unit=${unitName}.service

[Install]
WantedBy=timers.target
`

    try {
      await fs.mkdir(this.unitDir, { recursive: true })
      await fs.writeFile(serviceFile, serviceContent, 'utf-8')
      await fs.writeFile(timerFile, timerContent, 'utf-8')
      await execAsync('systemctl --user daemon-reload', { encoding: 'utf-8' })
      await execAsync(`systemctl --user enable --now ${unitName}.timer`, { encoding: 'utf-8' })
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error
      return { ok: false, error: e.message }
    }
  }

  async delete(name: string): Promise<OperationResult> {
    const unitName = `saio-${name}`
    try {
      await execAsync(`systemctl --user disable --now ${unitName}.timer`, { encoding: 'utf-8' })
      await fs.unlink(path.join(this.unitDir, `${unitName}.timer`)).catch(() => undefined)
      await fs.unlink(path.join(this.unitDir, `${unitName}.service`)).catch(() => undefined)
      await execAsync('systemctl --user daemon-reload', { encoding: 'utf-8' })
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error
      return { ok: false, error: e.message }
    }
  }

  async enable(name: string): Promise<OperationResult> {
    const unitName = `saio-${name}`
    try {
      await execAsync(`systemctl --user enable --now ${unitName}.timer`, { encoding: 'utf-8' })
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error
      return { ok: false, error: e.message }
    }
  }

  async disable(name: string): Promise<OperationResult> {
    const unitName = `saio-${name}`
    try {
      await execAsync(`systemctl --user disable --now ${unitName}.timer`, { encoding: 'utf-8' })
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error
      return { ok: false, error: e.message }
    }
  }

  async run(name: string): Promise<OperationResult> {
    const unitName = `saio-${name}`
    try {
      await execAsync(`systemctl --user start ${unitName}.service`, { encoding: 'utf-8' })
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error
      return { ok: false, error: e.message }
    }
  }

  async rename(oldName: string, newName: string): Promise<OperationResult> {
    const old = await this.get(oldName)
    if (!old) return { ok: false, error: 'task not found' }
    const create = await this.create({ ...old, name: newName })
    if (!create.ok) return create
    return await this.delete(oldName)
  }

  async setComment(name: string, comment: string): Promise<OperationResult> {
    // systemd: modifico Description nel .service file
    const unitName = `saio-${name}`
    const serviceFile = path.join(this.unitDir, `${unitName}.service`)
    try {
      const content = await fs.readFile(serviceFile, 'utf-8')
      const updated = content.replace(/^Description=.*$/m, `Description=${comment}`)
      await fs.writeFile(serviceFile, updated, 'utf-8')
      await execAsync('systemctl --user daemon-reload', { encoding: 'utf-8' })
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error
      return { ok: false, error: e.message }
    }
  }

  // ──────────────── Helpers ────────────────

  private scheduleToOnCalendar(spec: ScheduleSpec): string {
    const time = spec.time && /^\d{2}:\d{2}$/.test(spec.time) ? spec.time : '03:00'
    switch (spec.type) {
      case 'DAILY':
        return `*-*-* ${time}:00`
      case 'WEEKLY': {
        const dayMap: Record<string, string> = {
          MON: 'Mon',
          TUE: 'Tue',
          WED: 'Wed',
          THU: 'Thu',
          FRI: 'Fri',
          SAT: 'Sat',
          SUN: 'Sun',
        }
        const d = dayMap[spec.day || 'MON']
        return `${d} *-*-* ${time}:00`
      }
      case 'MONTHLY': {
        const dom = String(spec.dayOfMonth || '1').padStart(2, '0')
        return `*-*-${dom} ${time}:00`
      }
      case 'ONCE':
      default:
        return `*-*-* ${time}:00`
    }
  }
}
