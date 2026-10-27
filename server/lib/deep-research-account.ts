type ResearchAccount = {
  id: string
  stale?: boolean
  usage: { weeklyPercent: number | null; sessionPercent: number | null } | null
}

/** Non avviare una ricerca sul default esaurito, né scegliere un account alla cieca. */
export function researchAccount(accounts: ResearchAccount[], requested?: string): string {
  const available = accounts.filter(a => !a.stale && a.usage &&
    a.usage.weeklyPercent != null && a.usage.sessionPercent != null && a.usage.weeklyPercent < 100 && a.usage.sessionPercent < 100)
  if (requested) {
    if (!available.some(a => a.id === requested)) throw new Error('Account sconosciuto, esaurito o quota non disponibile')
    return requested
  }
  available.sort((a, b) => Math.max(a.usage!.weeklyPercent ?? 101, a.usage!.sessionPercent ?? 101) -
    Math.max(b.usage!.weeklyPercent ?? 101, b.usage!.sessionPercent ?? 101))
  if (!available.length) throw new Error('Nessun account con quota disponibile: aggiorna gli account prima di avviare la ricerca')
  return available[0].id
}

export function accountCommand(configDir: string, command: string): string {
  return `CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, "'\\''")}' ${command}`
}
