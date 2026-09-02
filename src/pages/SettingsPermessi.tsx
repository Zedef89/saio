/**
 * Permessi — cosa una sessione può fare da sé, e cosa deve chiedere (owner-only).
 *
 * Una riga per azione, una colonna per progetto: si spunta dove la regola vale. Nessun
 * progetto spuntato = vale ovunque.
 *
 * Gli owner non compaiono in questa pagina come soggetti, ed è voluto: sulla produzione
 * decidono loro, e un permesso chiesto a chi lo concede è un giro a vuoto. Misurato il
 * 02/09: con il cancello attivo anche per loro, in cinque ore 25 blocchi hanno prodotto
 * 4 richieste vere e 12 abbandoni silenziosi.
 */
import { useState } from 'react'
import {
  usePermessi,
  useModificaRegola,
  useDecidiRichiesta,
  type RegolaPermesso,
} from '@/hooks/usePermessi'
import { Button } from '@/components/ui/button'

function Riga({ r, progetti }: { r: RegolaPermesso; progetti: string[] }) {
  const modifica = useModificaRegola()
  const [aperto, setAperto] = useState(false)

  function toggleProgetto(p: string) {
    const next = r.progetti.includes(p) ? r.progetti.filter((x) => x !== p) : [...r.progetti, p]
    modifica.mutate({ id: r.id, progetti: next })
  }

  return (
    <div className="border-b border-border last:border-0">
      <div className="flex items-start gap-3 px-4 py-3">
        <button
          onClick={() => modifica.mutate({ id: r.id, attiva: !r.attiva })}
          disabled={modifica.isPending}
          className={`mt-0.5 shrink-0 w-11 h-6 rounded-full transition-colors ${
            r.attiva ? 'bg-emerald-600' : 'bg-muted'
          }`}
          aria-label={r.attiva ? 'Disattiva' : 'Attiva'}
        >
          <span
            className={`block w-5 h-5 bg-white rounded-full transition-transform ${
              r.attiva ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{r.titolo}</span>
            {!r.attiva && <span className="text-xs text-muted-foreground">(spenta)</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {r.valeOvunque ? 'Vale in tutti i progetti' : `Vale in: ${r.progetti.join(', ')}`}
          </p>
          <button
            onClick={() => setAperto(!aperto)}
            className="text-xs text-muted-foreground underline mt-1"
          >
            {aperto ? 'nascondi' : 'perché esiste, e cosa si può fare invece'}
          </button>
          {aperto && (
            <div className="mt-2 space-y-2 text-xs">
              <p>
                <span className="font-medium">Perché: </span>
                {r.perche}
              </p>
              <p>
                <span className="font-medium">Invece: </span>
                {r.invece}
              </p>
              {r.nota && <p className="text-muted-foreground">{r.nota}</p>}
              {progetti.length > 0 && (
                <div className="pt-1">
                  <p className="font-medium mb-1">In quali progetti vale</p>
                  <div className="flex flex-wrap gap-1.5">
                    {progetti.map((p) => (
                      <button
                        key={p}
                        onClick={() => toggleProgetto(p)}
                        disabled={modifica.isPending}
                        className={`px-2 py-0.5 rounded border text-xs ${
                          r.progetti.includes(p)
                            ? 'bg-emerald-600/15 border-emerald-600/40'
                            : 'border-border text-muted-foreground'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <p className="text-muted-foreground mt-1">
                    Nessuno selezionato = vale ovunque.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function SettingsPermessiPage() {
  const { data, isLoading, error } = usePermessi()
  const decidi = useDecidiRichiesta()

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Permessi</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cosa una sessione può fare da sé, e cosa deve chiedere. Vale per chi{' '}
          <strong>non è owner</strong>: chi ha l'autorità sulla produzione non incontra
          nessuna di queste regole, perché un permesso chiesto a chi lo concede è solo
          attrito — e l'attrito si aggira.
        </p>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Carico…</div>}
      {error && <div className="text-sm text-red-500">Errore nel caricamento.</div>}

      {data && data.inAttesa.length > 0 && (
        <div className="border border-amber-600/40 rounded-lg bg-amber-500/5 overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-600/30">
            <h2 className="text-sm font-semibold">
              {data.inAttesa.length} richieste aspettano una decisione
            </h2>
          </div>
          <div className="divide-y divide-border">
            {data.inAttesa.map((x) => (
              <div key={x.id} className="px-4 py-3 space-y-2">
                <div className="text-sm font-medium">{x.titolo}</div>
                <div className="text-xs text-muted-foreground">
                  {x.persona} · {x.sessione} · {x.dove}
                </div>
                <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto">{x.cosa}</pre>
                <p className="text-xs">
                  <span className="font-medium">Perché: </span>
                  {x.perche}
                </p>
                {x.prova && (
                  <p className="text-xs">
                    <span className="font-medium">Prova: </span>
                    {x.prova}
                  </p>
                )}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => decidi.mutate({ id: x.id, approva: true, perSessione: true })}
                    disabled={decidi.isPending}
                  >
                    Approva per questa sessione
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decidi.mutate({ id: x.id, approva: true })}
                    disabled={decidi.isPending}
                  >
                    Solo una volta
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => decidi.mutate({ id: x.id, approva: false })}
                    disabled={decidi.isPending}
                  >
                    Nega
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="border border-border rounded-lg bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">Azioni che richiedono un permesso</h2>
          </div>
          {data.regole.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">Nessuna regola definita.</div>
          )}
          {data.regole.map((r) => (
            <Riga key={r.id} r={r} progetti={data.progetti} />
          ))}
        </div>
      )}

      {data && data.abbozzate > 0 && (
        <p className="text-xs text-muted-foreground">
          {data.abbozzate} blocchi non sono mai diventati una richiesta: nessuno ha scritto
          il perché. È il numero da guardare — un blocco che non arriva a una persona
          diventa una verifica non fatta che nessuno sa essere mancata.
        </p>
      )}

      <p className="text-xs text-muted-foreground border-t border-border pt-4">
        Queste regole non sono un confine di sicurezza: tutto gira come root e l'hook
        fallisce aperto di proposito, perché un hook rotto non deve fermare il lavoro di
        nessuno. Servono a far emergere quello che oggi succede in silenzio. Il confine vero
        resta un utente di sistema separato per persona.
      </p>
    </div>
  )
}
