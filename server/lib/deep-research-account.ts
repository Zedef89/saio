type ResearchAccount = {
  id: string
  usage: { weeklyPercent: number; sessionPercent: number } | null
}

/** Non avviare una ricerca sul default esaurito, né scegliere un account alla cieca. */
export function researchAccount(accounts: ResearchAccount[], requested?: string): string {
  const available = accounts.filter(a => a.usage &&
    a.usage.weeklyPercent < 100 && a.usage.sessionPercent < 100)
  if (requested) {
    if (!available.some(a => a.id === requested)) throw new Error('Account sconosciuto, esaurito o quota non disponibile')
    return requested
  }
  available.sort((a, b) => Math.max(a.usage!.weeklyPercent, a.usage!.sessionPercent) -
    Math.max(b.usage!.weeklyPercent, b.usage!.sessionPercent))
  if (!available.length) throw new Error('Nessun account con quota disponibile: aggiorna gli account prima di avviare la ricerca')
  return available[0].id
}

export function accountCommand(configDir: string, command: string): string {
  return `CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, "'\\''")}' ${command}`
}
