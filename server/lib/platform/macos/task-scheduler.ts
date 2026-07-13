import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type {
  ITaskScheduler,
  ScheduledTask,
  ScheduleSpec,
  OperationResult,
  TaskState,
} from '../types'
import { MacOSElevator } from './elevator'

const execAsync = promisify(exec)

const PREFIX = 'us.revolutionmarketing.saio.'

/**
 * Prefissi vendor da NON mostrare tra i LaunchAgent esterni gestibili
 * (rumore di sistema/app di terze parti). Tutto il resto in
 * `~/Library/LaunchAgents/` viene esposto come task launchd utente.
 */
const VENDOR_PREFIXES = [
  'com.apple.',
  'com.google.',
  'homebrew.mxcl.',
  'com.docker.',
  'com.microsoft.',
  'com.adobe.',
  'com.macpaw.',
  'com.lwouis.',
]

/** Marker con cui commentiamo (disable) una riga crontab preservandola. */
const CRON_DISABLED_MARKER = '#SAIO-DISABLED# '

/**
 * macOS Task Scheduler. Copre TRE fonti di automazioni utente:
 *
 *  1. **SAIO** — LaunchAgents `~/Library/LaunchAgents/us.revolutionmarketing.saio.*.plist`.
 *     Pienamente gestibili (create/rename/setComment inclusi).
 *  2. **launchd utente esterni** — tutti gli altri `~/Library/LaunchAgents/*.plist`
 *     tranne i prefissi vendor (`VENDOR_PREFIXES`). name = label del plist.
 *  3. **cron utente** — righe di `crontab -l`. name = `cron-<hash8>` (hash stabile
 *     della riga attiva, indipendente da enable/disable).
 *
 * Tutte le voci esterne sono `managed:true`: l'utente ha scelto di gestirle dalla
 * dashboard. La creazione ex-novo resta riservata ai task SAIO.
 *
 * launchctl (API moderna, macOS 10.11+), dominio GUI utente (nessun sudo):
 * - enable  : `launchctl enable gui/<uid>/<label>` + `bootstrap gui/<uid> <plist>`
 * - disable : `launchctl bootout gui/<uid>/<label>` + `disable gui/<uid>/<label>`
 * - run     : `launchctl kickstart -k gui/<uid>/<label>`
 * - stato   : `launchctl list` (loaded + PID → running)
 *
 * cron: enable/disable = commenta/decommenta la riga (riscrittura crontab via
 * `crontab -` da stdin, preservando le altre righe); run = esegue il comando in
 * background via `/bin/zsh -lc`. Backup crontab prima di ogni riscrittura.
 */
export class MacOSTaskScheduler implements ITaskScheduler {
  private agentDir: string
  private logDir: string
  private uid: number

  constructor(_elevator: MacOSElevator) {
    this.agentDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    this.logDir = path.join(os.homedir(), 'Library', 'Logs', 'saio')
    this.uid = typeof process.getuid === 'function' ? process.getuid() : 501
  }

  // ──────────────── list / get (unione 3 fonti) ────────────────

  async list(): Promise<ScheduledTask[]> {
    const [saio, launchd, cron] = await Promise.all([
      this.listSaio(),
      this.listExternalLaunchd(),
      this.listCron(),
    ])
    return [...saio, ...launchd, ...cron]
  }

  async get(name: string): Promise<ScheduledTask | null> {
    return (await this.list()).find((t) => t.name === name) || null
  }

  /** Fonte 1: LaunchAgents SAIO (prefisso `us.revolutionmarketing.saio.`). */
  private async listSaio(): Promise<ScheduledTask[]> {
    try {
      const files = await fs.readdir(this.agentDir)
      const loaded = await this.loadedLabels()
      const tasks: ScheduledTask[] = []
      for (const f of files) {
        if (!f.startsWith(PREFIX)) continue
        if (!f.endsWith('.plist')) continue
        const name = f.slice(PREFIX.length).replace(/\.plist$/, '')
        const filePath = path.join(this.agentDir, f)
        const content = await fs.readFile(filePath, 'utf-8').catch(() => '')
        const task = this.parsePlist(name, content)
        if (!task) continue
        const label = `${PREFIX}${name}`
        const info = loaded.get(label)
        task.state = !info ? 'disabled' : info.running ? 'running' : 'ready'
        task.source = 'saio'
        task.managed = true
        tasks.push(task)
      }
      return tasks
    } catch {
      return []
    }
  }

  /** Fonte 2: LaunchAgents utente esterni (non-SAIO, non-vendor). */
  private async listExternalLaunchd(): Promise<ScheduledTask[]> {
    try {
      const files = await fs.readdir(this.agentDir)
      const loaded = await this.loadedLabels()
      const tasks: ScheduledTask[] = []
      for (const f of files) {
        if (!f.endsWith('.plist')) continue
        const label = f.replace(/\.plist$/, '')
        if (label.startsWith(PREFIX)) continue // fonte SAIO
        if (VENDOR_PREFIXES.some((p) => label.startsWith(p))) continue // rumore vendor
        const content = await fs.readFile(path.join(this.agentDir, f), 'utf-8').catch(() => '')
        if (!content) continue
        const { command, commandIsFile } = this.parseProgramArguments(content)
        const { spec, label: schedLabel } = this.parseLaunchdSchedule(content)
        const info = loaded.get(label)
        const state: TaskState = !info ? 'disabled' : info.running ? 'running' : 'ready'
        tasks.push({
          name: label,
          command,
          commandIsFile,
          schedule: spec,
          scheduleLabel: schedLabel,
          state,
          source: 'launchd',
          managed: true,
          description: `LaunchAgent utente: ${label}`,
        })
      }
      return tasks
    } catch {
      return []
    }
  }

  /** Fonte 3: righe di `crontab -l`. */
  private async listCron(): Promise<ScheduledTask[]> {
    const lines = await this.readCrontab()
    if (!lines) return []
    const tasks: ScheduledTask[] = []
    for (const raw of lines) {
      const parsed = this.parseCronEntry(raw)
      if (!parsed) continue
      const cron = this.parseCronLine(parsed.active)
      if (!cron) continue
      tasks.push({
        name: this.cronId(parsed.active),
        command: cron.command,
        commandIsFile: false,
        schedule: cron.spec,
        scheduleLabel: cron.label,
        state: parsed.disabled ? 'disabled' : 'ready',
        source: 'cron',
        managed: true,
        description: `Cron utente: ${cron.schedule}`,
      })
    }
    return tasks
  }

  // ──────────────── create / rename / setComment (solo SAIO) ────────────────

  async create(task: Omit<ScheduledTask, 'state' | 'lastRunAt' | 'lastResult'>): Promise<OperationResult> {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(task.name)) {
      return { ok: false, error: 'name 3-64 char alphanum/dash/underscore' }
    }
    const label = `${PREFIX}${task.name}`
    const filePath = path.join(this.agentDir, `${label}.plist`)
    const logPath = path.join(this.logDir, `${task.name}.log`)
    const plist = this.buildPlist(label, task.command, task.schedule, task.description, logPath, task.commandIsFile)
    try {
      await fs.mkdir(this.agentDir, { recursive: true })
      await fs.mkdir(this.logDir, { recursive: true })
      await fs.writeFile(filePath, plist, 'utf-8')
      await this.launchctl(`enable gui/${this.uid}/${label}`)
      await this.launchctl(`bootout gui/${this.uid}/${label}`)
      const r = await this.launchctl(`bootstrap gui/${this.uid} "${filePath}"`)
      if (!r.ok && !this.isAlreadyLoaded(r.err)) {
        return { ok: false, error: r.err || 'bootstrap failed' }
      }
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async rename(oldName: string, newName: string): Promise<OperationResult> {
    if (this.classify(oldName) !== 'saio') {
      return { ok: false, error: 'rename supportato solo sui task SAIO' }
    }
    const old = await this.get(oldName)
    if (!old) return { ok: false, error: 'task not found' }
    const create = await this.create({
      name: newName,
      command: old.command,
      commandIsFile: old.commandIsFile,
      schedule: old.schedule,
      description: old.description,
      details: old.details,
    })
    if (!create.ok) return create
    return await this.delete(oldName)
  }

  async setComment(name: string, comment: string): Promise<OperationResult> {
    if (this.classify(name) !== 'saio') {
      return { ok: false, error: 'setComment supportato solo sui task SAIO' }
    }
    const label = `${PREFIX}${name}`
    const filePath = path.join(this.agentDir, `${label}.plist`)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const escaped = this.escapeXml(comment)
      let updated: string
      if (content.includes('<key>SaioDescription</key>')) {
        updated = content.replace(
          /<key>SaioDescription<\/key>\s*<string>[^<]*<\/string>/,
          `<key>SaioDescription</key>\n  <string>${escaped}</string>`
        )
      } else {
        updated = content.replace(
          /<\/dict>\s*<\/plist>/,
          `  <key>SaioDescription</key>\n  <string>${escaped}</string>\n</dict>\n</plist>`
        )
      }
      await fs.writeFile(filePath, updated, 'utf-8')
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err as Error).message }
    }
  }

  // ──────────────── delete / enable / disable / run (dispatch per fonte) ────────────────

  async delete(name: string): Promise<OperationResult> {
    switch (this.classify(name)) {
      case 'cron':
        return this.cronToggle(name, 'delete')
      case 'launchd':
        return this.launchdDelete(name, name)
      default:
        return this.launchdDelete(name, `${PREFIX}${name}`)
    }
  }

  async enable(name: string): Promise<OperationResult> {
    switch (this.classify(name)) {
      case 'cron':
        return this.cronToggle(name, 'enable')
      case 'launchd':
        return this.launchdEnable(name)
      default:
        return this.launchdEnable(`${PREFIX}${name}`, true)
    }
  }

  async disable(name: string): Promise<OperationResult> {
    switch (this.classify(name)) {
      case 'cron':
        return this.cronToggle(name, 'disable')
      case 'launchd':
        return this.launchdDisable(name)
      default:
        return this.launchdDisable(`${PREFIX}${name}`)
    }
  }

  async run(name: string): Promise<OperationResult> {
    switch (this.classify(name)) {
      case 'cron':
        return this.cronRun(name)
      case 'launchd':
        return this.launchdRun(name)
      default:
        return this.launchdRun(`${PREFIX}${name}`)
    }
  }

  // ──────────────── launchd (SAIO + esterni) ────────────────

  private async launchdDelete(name: string, label: string): Promise<OperationResult> {
    const filePath = path.join(this.agentDir, `${label}.plist`)
    try {
      await this.launchctl(`bootout gui/${this.uid}/${label}`)
      await fs.unlink(filePath)
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: (err as Error).message }
    }
  }

  private async launchdEnable(label: string, requireFile = false): Promise<OperationResult> {
    const filePath = path.join(this.agentDir, `${label}.plist`)
    if (requireFile) {
      try {
        await fs.access(filePath)
      } catch {
        return { ok: false, error: 'task not found' }
      }
    }
    await this.launchctl(`enable gui/${this.uid}/${label}`)
    const r = await this.launchctl(`bootstrap gui/${this.uid} "${filePath}"`)
    if (!r.ok && !this.isAlreadyLoaded(r.err)) {
      return { ok: false, error: r.err || 'enable failed' }
    }
    return { ok: true }
  }

  private async launchdDisable(label: string): Promise<OperationResult> {
    await this.launchctl(`bootout gui/${this.uid}/${label}`)
    await this.launchctl(`disable gui/${this.uid}/${label}`)
    return { ok: true }
  }

  private async launchdRun(label: string): Promise<OperationResult> {
    const filePath = path.join(this.agentDir, `${label}.plist`)
    await this.launchctl(`bootstrap gui/${this.uid} "${filePath}"`).catch(() => undefined)
    const r = await this.launchctl(`kickstart -k gui/${this.uid}/${label}`)
    if (!r.ok) return { ok: false, error: r.err || 'run failed' }
    return { ok: true }
  }

  // ──────────────── cron ────────────────

  /** enable/disable/delete su una riga crontab identificata da `cron-<hash8>`. */
  private async cronToggle(id: string, op: 'enable' | 'disable' | 'delete'): Promise<OperationResult> {
    const lines = await this.readCrontab()
    if (!lines) return { ok: false, error: 'crontab vuoto o non disponibile' }
    let matched = false
    const out: string[] = []
    for (const raw of lines) {
      const parsed = this.parseCronEntry(raw)
      if (parsed && this.cronId(parsed.active) === id) {
        matched = true
        if (op === 'delete') continue // rimuovi la riga
        if (op === 'disable') {
          out.push(parsed.disabled ? raw : `${CRON_DISABLED_MARKER}${parsed.active}`)
        } else {
          // enable: rimuovi il marker se presente
          out.push(parsed.active)
        }
        continue
      }
      out.push(raw)
    }
    if (!matched) return { ok: false, error: 'cron task not found' }
    return this.writeCrontab(lines, out)
  }

  /** Esegue il comando della riga cron in background (fire-and-forget). */
  private async cronRun(id: string): Promise<OperationResult> {
    const lines = await this.readCrontab()
    if (!lines) return { ok: false, error: 'crontab vuoto o non disponibile' }
    for (const raw of lines) {
      const parsed = this.parseCronEntry(raw)
      if (parsed && this.cronId(parsed.active) === id) {
        const cron = this.parseCronLine(parsed.active)
        if (!cron) return { ok: false, error: 'impossibile parsare la riga cron' }
        try {
          const child = spawn('/bin/zsh', ['-lc', cron.command], {
            detached: true,
            stdio: 'ignore',
          })
          child.unref()
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      }
    }
    return { ok: false, error: 'cron task not found' }
  }

  /** Legge `crontab -l` → array di righe grezze (null se nessun crontab). */
  private async readCrontab(): Promise<string[] | null> {
    try {
      const { stdout } = await execAsync('crontab -l', { encoding: 'utf-8' })
      return stdout.replace(/\n$/, '').split('\n')
    } catch (err: unknown) {
      const e = err as { stderr?: string }
      // "no crontab for <user>" → nessun crontab installato
      if ((e.stderr || '').toLowerCase().includes('no crontab')) return null
      return null
    }
  }

  /**
   * Riscrive il crontab (via `crontab -` da stdin), facendo prima un backup
   * del contenuto corrente in ~/Library/Logs/saio/crontab-backup-<ts>.txt.
   */
  private async writeCrontab(current: string[], next: string[]): Promise<OperationResult> {
    try {
      await fs.mkdir(this.logDir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = path.join(this.logDir, `crontab-backup-${ts}.txt`)
      await fs.writeFile(backupPath, current.join('\n') + '\n', 'utf-8')
    } catch {
      /* backup best-effort: se fallisce, non blocchiamo la scrittura */
    }
    const content = next.join('\n') + '\n'
    return new Promise<OperationResult>((resolve) => {
      const p = spawn('crontab', ['-'])
      let err = ''
      p.stderr.on('data', (d) => (err += d.toString()))
      p.on('error', (e) => resolve({ ok: false, error: e.message }))
      p.on('close', (code) => {
        if (code === 0) resolve({ ok: true })
        else resolve({ ok: false, error: err || `crontab exit ${code}` })
      })
      p.stdin.write(content)
      p.stdin.end()
    })
  }

  /**
   * Classifica una riga crontab grezza.
   * @returns null se è vuota o un commento vero; altrimenti `{active, disabled}`
   *          dove `active` è la riga cron reale (senza marker di disable).
   */
  private parseCronEntry(raw: string): { active: string; disabled: boolean } | null {
    const line = raw.trim()
    if (!line) return null
    if (line.startsWith(CRON_DISABLED_MARKER)) {
      const active = line.slice(CRON_DISABLED_MARKER.length).trim()
      return active ? { active, disabled: true } : null
    }
    if (line.startsWith('#')) return null // commento vero
    return { active: line, disabled: false }
  }

  /** Id stabile per una riga cron attiva (indipendente dallo stato enable/disable). */
  private cronId(active: string): string {
    return 'cron-' + createHash('sha1').update(active.trim()).digest('hex').slice(0, 8)
  }

  /** Parsa una riga cron attiva in { schedule, command, spec, label }. */
  private parseCronLine(
    active: string
  ): { schedule: string; command: string; spec: ScheduleSpec; label: string } | null {
    const line = active.trim()
    // Forme speciali @reboot/@daily/... : primo token + resto = comando.
    if (line.startsWith('@')) {
      const m = /^(@\S+)\s+(.+)$/.exec(line)
      if (!m) return null
      const keyword = m[1]!
      return {
        schedule: keyword,
        command: m[2]!,
        spec: { type: 'DAILY' },
        label: this.cronKeywordLabel(keyword),
      }
    }
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!m) return null
    const fields = [m[1]!, m[2]!, m[3]!, m[4]!, m[5]!]
    const command = m[6]!
    return {
      schedule: fields.join(' '),
      command,
      spec: this.cronToSpec(fields),
      label: this.cronToLabel(fields),
    }
  }

  private cronKeywordLabel(kw: string): string {
    switch (kw) {
      case '@reboot':
        return "all'avvio"
      case '@hourly':
        return 'ogni ora'
      case '@daily':
      case '@midnight':
        return 'ogni giorno'
      case '@weekly':
        return 'ogni settimana'
      case '@monthly':
        return 'ogni mese'
      case '@yearly':
      case '@annually':
        return 'ogni anno'
      default:
        return kw
    }
  }

  private cronToSpec(fields: string[]): ScheduleSpec {
    const [min, hour, dom, , dow] = fields
    const isNum = (s?: string) => /^\d+$/.test(s || '')
    // Pattern "M H * * *" → DAILY con time.
    if (isNum(min) && isNum(hour) && dom === '*' && dow === '*') {
      const time = `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`
      return { type: 'DAILY', time }
    }
    // Pattern "M H * * D" → WEEKLY.
    if (isNum(min) && isNum(hour) && dom === '*' && isNum(dow)) {
      const dayMap: Record<string, import('../types').WeekDay> = {
        '0': 'SUN', '1': 'MON', '2': 'TUE', '3': 'WED', '4': 'THU', '5': 'FRI', '6': 'SAT', '7': 'SUN',
      }
      const time = `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`
      return { type: 'WEEKLY', time, day: dayMap[dow!] || 'MON' }
    }
    // Pattern "M H D * *" → MONTHLY.
    if (isNum(min) && isNum(hour) && isNum(dom)) {
      const time = `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`
      return { type: 'MONTHLY', time, dayOfMonth: dom }
    }
    // Fallback: nessuno spec strutturato affidabile; la label porta la verità.
    return { type: 'DAILY' }
  }

  /** Deriva una label italiana leggibile dai 5 campi cron. */
  private cronToLabel(fields: string[]): string {
    const [min, hour, dom, mon, dow] = fields
    const isNum = (s?: string) => /^\d+$/.test(s || '')
    const stepMatch = (s?: string) => /^\*\/(\d+)$/.exec(s || '')

    // */N * * * *  → ogni N min
    const minStep = stepMatch(min)
    if (minStep && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
      return `ogni ${minStep[1]} min`
    }
    // 0 */N * * *  → ogni N ore
    const hourStep = stepMatch(hour)
    if (isNum(min) && hourStep && dom === '*' && mon === '*' && dow === '*') {
      return `ogni ${hourStep[1]} ore`
    }
    const time = isNum(min) && isNum(hour) ? `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}` : ''
    // M H * * *  → ogni giorno HH:MM
    if (time && dom === '*' && mon === '*' && dow === '*') {
      return `ogni giorno ${time}`
    }
    // M H * * D  → ogni <giorno> HH:MM
    if (time && dom === '*' && isNum(dow)) {
      const days = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom']
      return `ogni ${days[parseInt(dow!, 10)] || dow} ${time}`
    }
    // M H D * *  → giorno D del mese HH:MM
    if (time && isNum(dom)) {
      return `giorno ${dom} del mese ${time}`
    }
    // Fallback: espressione grezza.
    return fields.join(' ')
  }

  // ──────────────── Helpers launchctl / plist ────────────────

  private classify(name: string): 'saio' | 'launchd' | 'cron' {
    if (name.startsWith('cron-')) return 'cron'
    if (name.includes('.')) return 'launchd' // i label esterni sono FQDN-like (contengono punti)
    return 'saio'
  }

  private async launchctl(args: string): Promise<{ ok: boolean; out: string; err: string }> {
    try {
      const { stdout, stderr } = await execAsync(`launchctl ${args}`, { encoding: 'utf-8' })
      return { ok: true, out: stdout, err: stderr }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string; stdout?: string }
      return { ok: false, out: e.stdout || '', err: e.stderr || e.message }
    }
  }

  private isAlreadyLoaded(stderr: string): boolean {
    const s = (stderr || '').toLowerCase()
    return s.includes('already') || s.includes('service is already loaded')
  }

  /** Mappa label → { running } di TUTTI i servizi nel dominio GUI utente. */
  private async loadedLabels(): Promise<Map<string, { running: boolean }>> {
    const map = new Map<string, { running: boolean }>()
    const r = await this.launchctl('list')
    if (!r.ok) return map
    for (const line of r.out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const [pid, , label] = parts
      if (!label || label === 'Label') continue
      map.set(label, { running: /^\d+$/.test(pid || '') })
    }
    return map
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  private shellPath(): string {
    return [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      path.join(os.homedir(), '.local', 'bin'),
    ].join(':')
  }

  private buildPlist(
    label: string,
    command: string,
    schedule: ScheduleSpec,
    description: string | undefined,
    logPath: string,
    commandIsFile?: boolean
  ): string {
    const time = schedule.time && /^\d{2}:\d{2}$/.test(schedule.time) ? schedule.time : '03:00'
    const [hh, mm] = time.split(':').map((n) => parseInt(n, 10))
    const calBlock = this.scheduleToCalendar(schedule, hh!, mm!)
    const desc = this.escapeXml(description || `SAIO scheduled task: ${label}`)
    const progArgs = commandIsFile
      ? `    <string>/bin/zsh</string>
    <string>-l</string>
    <string>${this.escapeXml(command)}</string>`
      : `    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${this.escapeXml(command)}</string>`
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${this.shellPath()}</string>
  </dict>
  ${calBlock}
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${this.escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${this.escapeXml(logPath)}</string>
  <key>SaioDescription</key>
  <string>${desc}</string>
</dict>
</plist>
`
  }

  private scheduleToCalendar(spec: ScheduleSpec, hh: number, mm: number): string {
    switch (spec.type) {
      case 'DAILY':
        return `<key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hh}</integer>
    <key>Minute</key><integer>${mm}</integer>
  </dict>`
      case 'WEEKLY': {
        const dayMap: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }
        const w = dayMap[spec.day || 'MON'] ?? 1
        return `<key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>${w}</integer>
    <key>Hour</key><integer>${hh}</integer>
    <key>Minute</key><integer>${mm}</integer>
  </dict>`
      }
      case 'MONTHLY': {
        const d = parseInt(String(spec.dayOfMonth || '1'), 10)
        return `<key>StartCalendarInterval</key>
  <dict>
    <key>Day</key><integer>${d}</integer>
    <key>Hour</key><integer>${hh}</integer>
    <key>Minute</key><integer>${mm}</integer>
  </dict>`
      }
      case 'ONCE':
      default:
        return `<key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hh}</integer>
    <key>Minute</key><integer>${mm}</integer>
  </dict>`
    }
  }

  /** Estrae comando + commandIsFile dai ProgramArguments di un plist. */
  private parseProgramArguments(content: string): { command: string; commandIsFile: boolean } {
    const cmdMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/m.exec(content)
    if (!cmdMatch) return { command: '', commandIsFile: false }
    const strs = [...cmdMatch[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => this.unescapeXml(m[1]!))
    // zsh -lc "<cmd>" o zsh -l <file> → estrai l'ultimo; altrimenti mostra l'intera riga di comando.
    if (strs[0] === '/bin/zsh' && (strs[1] === '-lc' || strs[1] === '-l')) {
      return { command: strs[strs.length - 1] || '', commandIsFile: strs[1] === '-l' }
    }
    return { command: strs.join(' '), commandIsFile: false }
  }

  /** Deriva { spec, label } dallo scheduling di un plist launchd esterno. */
  private parseLaunchdSchedule(content: string): { spec: ScheduleSpec; label: string } {
    // StartInterval (secondi) → "ogni N min/ore/sec".
    const intMatch = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
    if (intMatch) {
      const secs = parseInt(intMatch[1]!, 10)
      let label: string
      if (secs % 3600 === 0) label = `ogni ${secs / 3600} ore`
      else if (secs % 60 === 0) label = `ogni ${secs / 60} min`
      else label = `ogni ${secs} sec`
      return { spec: { type: 'DAILY' }, label }
    }
    // StartCalendarInterval.
    const hasCalendar = /<key>StartCalendarInterval<\/key>/.test(content)
    if (hasCalendar) {
      const hourMatch = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
      const minMatch = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
      const wMatch = /<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
      const dMatch = /<key>Day<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
      const time =
        hourMatch && minMatch
          ? `${hourMatch[1]!.padStart(2, '0')}:${minMatch[1]!.padStart(2, '0')}`
          : ''
      if (wMatch) {
        const dayMap: Record<string, import('../types').WeekDay> = {
          '0': 'SUN', '1': 'MON', '2': 'TUE', '3': 'WED', '4': 'THU', '5': 'FRI', '6': 'SAT',
        }
        const days = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab']
        return {
          spec: { type: 'WEEKLY', time: time || undefined, day: dayMap[wMatch[1]!] || 'MON' },
          label: `ogni ${days[parseInt(wMatch[1]!, 10)] || ''} ${time}`.trim(),
        }
      }
      if (dMatch) {
        return {
          spec: { type: 'MONTHLY', time: time || undefined, dayOfMonth: dMatch[1] },
          label: `giorno ${dMatch[1]} del mese ${time}`.trim(),
        }
      }
      return { spec: { type: 'DAILY', time: time || undefined }, label: time ? `ogni giorno ${time}` : 'ogni giorno' }
    }
    // Nessuno scheduling: daemon KeepAlive / RunAtLoad.
    if (/<key>KeepAlive<\/key>\s*<true\s*\/>/.test(content)) {
      return { spec: { type: 'DAILY' }, label: 'sempre attivo (KeepAlive)' }
    }
    if (/<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(content)) {
      return { spec: { type: 'ONCE' }, label: "all'avvio" }
    }
    return { spec: { type: 'ONCE' }, label: 'manuale' }
  }

  private parsePlist(name: string, content: string): ScheduledTask | null {
    if (!content) return null
    const { command, commandIsFile } = this.parseProgramArguments(content)
    const descMatch = /<key>SaioDescription<\/key>\s*<string>([^<]*)<\/string>/m.exec(content)
    const description = descMatch?.[1] ? this.unescapeXml(descMatch[1]) : undefined
    const hourMatch = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
    const minMatch = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
    const time =
      hourMatch && minMatch
        ? `${hourMatch[1]!.padStart(2, '0')}:${minMatch[1]!.padStart(2, '0')}`
        : '03:00'
    const wMatch = /<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
    const dMatch = /<key>Day<\/key>\s*<integer>(\d+)<\/integer>/m.exec(content)
    let schedule: ScheduleSpec
    if (wMatch) {
      const dayMap: Record<string, import('../types').WeekDay> = {
        '0': 'SUN', '1': 'MON', '2': 'TUE', '3': 'WED', '4': 'THU', '5': 'FRI', '6': 'SAT',
      }
      schedule = { type: 'WEEKLY', time, day: dayMap[wMatch[1]!] || 'MON' }
    } else if (dMatch) {
      schedule = { type: 'MONTHLY', time, dayOfMonth: dMatch[1] }
    } else {
      schedule = { type: 'DAILY', time }
    }
    const state: TaskState = 'ready'
    return {
      name,
      command,
      commandIsFile,
      schedule,
      state,
      description,
    }
  }

  private unescapeXml(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  }
}
