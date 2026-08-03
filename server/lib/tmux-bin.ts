import fsSync from 'node:fs'

/**
 * Path assoluto di tmux, risolto a runtime.
 *
 * Era inchiodato a '/opt/homebrew/bin/tmux' perché il PATH della GUI di macOS non include
 * /opt/homebrew (l'app Tauri non trovava i binari installati con brew). Su Linux quel path
 * non esiste: ogni execFile falliva con ENOENT e la lista delle sessioni tmux risultava
 * vuota, mentre l'attach non partiva affatto.
 *
 * L'ordine dei candidati tiene il path Homebrew per primo così su macOS il comportamento
 * resta identico a prima.
 */
export const TMUX_BIN =
  ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux'].find((p) =>
    fsSync.existsSync(p),
  ) || 'tmux'
