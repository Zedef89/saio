/**
 * Di chi e' una sessione tmux.
 *
 * Su una devbox condivisa la lista sessioni e' comune a tutti: senza un segno di chi ha aperto
 * cosa, ci si ritrova davanti a venti nomi senza sapere quali sono i propri. Il proprietario
 * viene messo come **prefisso** del nome (`nicola-komanda-dashboard`), che e' l'unico posto dove
 * sopravvive: tmux non ha metadati per sessione e un registro a parte si disallineerebbe con le
 * sessioni aperte a mano da SSH.
 *
 * Gli slug vengono da `git-identities.json` (lo stesso mapping usato per i worktree e per
 * l'identita' git dei commit), quindi non c'e' una seconda anagrafica da tenere allineata.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { slugFromEmail } from './worktree'

export interface SessionOwner {
  slug: string
  name: string
}

/** Tutti i proprietari conosciuti, dal mapping delle identita' git. */
export async function knownOwners(dataDir: string): Promise<SessionOwner[]> {
  try {
    const raw = await fs.readFile(path.join(dataDir, 'git-identities.json'), 'utf8')
    const all = JSON.parse(raw) as Record<string, { slug?: string; name?: string }>
    const out: SessionOwner[] = []
    for (const [email, v] of Object.entries(all)) {
      const slug = v.slug || slugFromEmail(email)
      out.push({ slug, name: v.name || slug })
    }
    // Slug piu' lunghi per primi: `mario-rossi` non deve essere scavalcato da `mario`.
    return out.sort((a, b) => b.slug.length - a.slug.length)
  } catch {
    return []
  }
}

/** Il proprietario scritto nel nome, se il prefisso corrisponde a qualcuno di conosciuto. */
export function ownerFromName(name: string, owners: SessionOwner[]): SessionOwner | null {
  for (const o of owners) {
    if (name === o.slug || name.startsWith(`${o.slug}-`)) return o
  }
  return null
}

/**
 * Nome della sessione con davanti il proprietario. Idempotente: un nome che ce l'ha gia'
 * (anche di un altro utente, es. si riapre la sessione di un collega) non viene toccato,
 * altrimenti si accumulerebbero prefissi a ogni passaggio.
 */
export async function withOwnerPrefix(name: string, dataDir: string, email: string | null): Promise<string> {
  if (!email || email === 'unknown') return name
  const owners = await knownOwners(dataDir)
  if (ownerFromName(name, owners)) return name
  const mine = owners.find((o) => o.slug === slugFromEmail(email))
  // Chi non e' nel mapping usa comunque lo slug dedotto dall'email: meglio un prefisso brutto
  // che una sessione senza proprietario in mezzo a quelle degli altri.
  const slug = mine?.slug || (await ownerSlugForEmail(dataDir, email))
  return slug ? `${slug}-${name}` : name
}

/**
 * Se questo utente puo' agire (chiudere, cambiare account) su questa sessione.
 *
 * L'owner puo' su tutto: e' lui che tiene in piedi la macchina e deve poter chiudere una
 * sessione impazzita di chiunque. Un guest solo sulle proprie, riconosciute dal prefisso del
 * nome — che e' l'unico posto dove il proprietario e' scritto (vedi in testa a questo file).
 *
 * Le sessioni senza prefisso conosciuto (aperte a mano da SSH) restano fuori portata dei
 * guest: se non si sa di chi sono, il default e' non toccarle.
 */
export async function canActOnSession(
  dataDir: string,
  sessionName: string,
  user: { email: string; role: 'owner' | 'guest' } | undefined,
): Promise<boolean> {
  if (!user) return false
  if (user.role === 'owner') return true
  const owners = await knownOwners(dataDir)
  const owner = ownerFromName(sessionName, owners)
  if (!owner) return false
  return owner.slug === (await ownerSlugForEmail(dataDir, user.email))
}

/** Slug di un'email: quello configurato in git-identities.json, altrimenti dedotto. */
export async function ownerSlugForEmail(dataDir: string, email: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(dataDir, 'git-identities.json'), 'utf8')
    const all = JSON.parse(raw) as Record<string, { slug?: string }>
    const hit = all[email.toLowerCase().trim()]
    if (hit?.slug) return hit.slug
  } catch {
    /* nessun mapping: si usa il fallback */
  }
  return slugFromEmail(email)
}
