/**
 * L'etichetta che una sessione mostra nella lista, quando il nome non racconta piu' il lavoro.
 *
 * ## Il problema
 *
 * Il nome di una sessione lo si sceglie all'apertura, quando del lavoro si sa la prima riga.
 * Una sessione tenuta aperta per giorni cambia argomento tre volte, e nella lista resta il
 * nome del primo: davanti a venti voci non si sa piu' quale aprire.
 *
 * ## Perche' un alias e non `tmux rename-session`
 *
 * Il nome della sessione non e' un'etichetta: e' un identificatore. Ci sono appesi il
 * proprietario (`nicola-…`, vedi `session-owner.ts`, che e' anche il controllo di chi puo'
 * chiudere e cambiare account), l'aggancio del PTY (`projectId = tmux-<nome>`), il runtime che
 * dice su che account gira e se e' a limite, e la ripresa dopo il limite. Rinominare la
 * sessione vera li scollegherebbe tutti in una volta, in silenzio.
 *
 * Qui si cambia **solo cio' che si legge**: il nome vero resta quello, l'alias e' una riga in
 * un file a parte. Niente di quello che dipende dal nome se ne accorge.
 *
 * ## Perche' l'alias porta con se' `created`
 *
 * I nomi si riusano: chiusa `nicola-studio-livekit` e riaperta con lo stesso nome, la sessione
 * e' un'altra e l'etichetta di prima sarebbe una bugia. L'istante di creazione della sessione
 * tmux (`session_created`) distingue le due: se non combacia, l'alias non si applica.
 *
 * Storage: `<dataDir>/session-aliases.json`, scrittura atomica.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteFile } from './atomic-write'
import { logger } from './logger'

export interface SessionAlias {
  /** Quello che si legge nella lista al posto del nome. */
  label: string
  /** `session_created` della sessione a cui appartiene: identifica *quella* sessione, non il nome. */
  created: number
}

type AliasFile = Record<string, SessionAlias>

/** Piu' lunga di cosi' non ci sta nella colonna, e smette di essere un'etichetta. */
export const MAX_LABEL = 60

function filePath(dataDir: string): string {
  return path.join(dataDir, 'session-aliases.json')
}

/**
 * Ripulisce quello che arriva dal browser. L'etichetta finisce solo a schermo — non in una
 * riga di comando ne' in un percorso — quindi non serve una whitelist di caratteri: servono
 * una riga sola, niente caratteri di controllo e una lunghezza finita.
 */
export function normalizeLabel(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL)
}

export async function readAliases(dataDir: string): Promise<AliasFile> {
  try {
    const raw = await fs.readFile(filePath(dataDir), 'utf8')
    const parsed = JSON.parse(raw) as AliasFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // File assente al primo uso, o illeggibile: nessun alias e' uno stato valido.
    return {}
  }
}

async function writeAliases(dataDir: string, all: AliasFile): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  await atomicWriteFile(filePath(dataDir), JSON.stringify(all, null, 2))
}

/** L'etichetta di questa sessione, se ce n'e' una ed e' sua (stesso nome *e* stessa nascita). */
export function aliasFor(all: AliasFile, name: string, created: number): string | null {
  const hit = all[name]
  if (!hit || !hit.label) return null
  if (hit.created && created && hit.created !== created) return null
  return hit.label
}

/** Scrive l'etichetta; una stringa vuota la toglie e fa tornare il nome. */
export async function setAlias(
  dataDir: string,
  name: string,
  created: number,
  label: string,
): Promise<string | null> {
  const clean = normalizeLabel(label)
  const all = await readAliases(dataDir)
  if (!clean) delete all[name]
  else all[name] = { label: clean, created }
  await writeAliases(dataDir, all)
  return clean || null
}

/**
 * Butta le etichette delle sessioni che non ci sono piu'. Si chiama dalla lista, che e'
 * l'unico posto che sa quali sessioni esistono davvero; scrive solo se c'e' qualcosa da
 * togliere, e non fa mai fallire la lista.
 */
export async function pruneAliases(
  dataDir: string,
  live: { name: string; created: number }[],
): Promise<void> {
  // Lista vuota = tmux ha singhiozzato, non "nessuno sta lavorando": non si cancella niente.
  if (live.length === 0) return
  try {
    const all = await readAliases(dataDir)
    const vive = new Map(live.map((s) => [s.name, s.created]))
    let cambiato = false
    for (const [name, alias] of Object.entries(all)) {
      const created = vive.get(name)
      if (created === undefined || (alias.created && created && alias.created !== created)) {
        delete all[name]
        cambiato = true
      }
    }
    if (cambiato) await writeAliases(dataDir, all)
  } catch (err) {
    logger.warn(`[session-alias] prune fallito: ${String(err).slice(0, 200)}`)
  }
}
