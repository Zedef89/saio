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
  useModificaAccesso,
  useModificaProgetto,
  useDecidiRichiesta,
  type RegolaPermesso,
  type Accesso,
  type Persona,
  type ProgettoVisibilita,
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

/**
 * Una riga per accesso, una colonna per persona: si spunta chi lo vede.
 *
 * Chi amministra non ha una colonna, e non e' una dimenticanza: vede tutto per
 * definizione, come per il cancello. Quello che si decide qui riguarda chi entra dopo.
 */
function RigaAccesso({ a, persone }: { a: Accesso; persone: Persona[] }) {
  const modifica = useModificaAccesso()
  const tutti = a.persone === 'tutti'
  const scelte = tutti ? [] : (a.persone as string[])

  function commuta(slug: string) {
    const nuove = scelte.includes(slug) ? scelte.filter((s) => s !== slug) : [...scelte, slug]
    modifica.mutate({ nome: a.nome, persone: nuove })
  }

  return (
    <div className="px-4 py-3 border-t border-border">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium font-mono">{a.nome}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{a.apre}</div>
          {a.avviso && <div className="text-xs text-amber-500 mt-1">⚠ {a.avviso}</div>}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          <input
            type="checkbox"
            checked={tutti}
            disabled={modifica.isPending}
            onChange={(e) => modifica.mutate({ nome: a.nome, persone: e.target.checked ? 'tutti' : [] })}
          />
          di tutti
        </label>
      </div>
      {!tutti && (
        <div className="flex flex-wrap gap-3 mt-2">
          {persone.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Nessuna persona in anagrafica oltre a chi amministra.
            </span>
          )}
          {persone.map((p) => (
            <label key={p.slug} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={scelte.includes(p.slug)}
                disabled={modifica.isPending}
                onChange={() => commuta(p.slug)}
              />
              {p.nome}
            </label>
          ))}
        </div>
      )}
      {modifica.isError && (
        <div className="text-xs text-red-500 mt-1">{(modifica.error as Error).message}</div>
      )}
    </div>
  )
}

/** Una riga «questo progetto lo vede chi». Vuoto = lo vedono tutti. */
function RigaProgetto({ p, persone }: { p: ProgettoVisibilita; persone: Persona[] }) {
  const modifica = useModificaProgetto()
  const tutti = p.persone.length === 0

  function commuta(slug: string) {
    const nuove = p.persone.includes(slug) ? p.persone.filter((s) => s !== slug) : [...p.persone, slug]
    modifica.mutate({ id: p.id, persone: nuove })
  }

  return (
    <div className="px-4 py-2.5 border-t border-border">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{p.nome}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {tutti ? 'lo vedono tutti' : `solo ${p.persone.join(', ')}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-3 shrink-0 justify-end">
          {persone.map((x) => (
            <label key={x.slug} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={p.persone.includes(x.slug)}
                disabled={modifica.isPending}
                onChange={() => commuta(x.slug)}
              />
              {x.nome}
            </label>
          ))}
        </div>
      </div>
      {modifica.isError && (
        <div className="text-xs text-red-500 mt-1">{(modifica.error as Error).message}</div>
      )}
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

      {data && data.progettiVisibilita.length > 0 && (
        <div className="border border-border rounded-lg bg-card overflow-hidden">
          <div className="px-4 py-3">
            <h2 className="text-sm font-semibold">Chi vede quale progetto</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Un progetto senza nessuno spuntato <strong>lo vedono tutti</strong>: è com'era
              prima, e restringere è una decisione da prendere, non qualcosa che scatta da
              sola su {data.progettiVisibilita.length} progetti. Spuntando una persona, il
              progetto diventa suo e sparisce agli altri invitati — chi amministra continua a
              vedere tutto. Non si nasconde solo la card: la sessione non si apre nemmeno
              indovinando l'indirizzo.
            </p>
          </div>
          {data.progettiVisibilita.map((p) => (
            <RigaProgetto key={p.id} p={p} persone={data.persone} />
          ))}
        </div>
      )}

      {data && (
        <div className="border border-border rounded-lg bg-card overflow-hidden">
          <div className="px-4 py-3">
            <h2 className="text-sm font-semibold">Chi vede quale accesso</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Chiavi, token e connessioni al database: {data.accessi.length} in tutto. Chi
              amministra li vede tutti e non compare qui. <strong>Chi entra nuovo parte
              senza niente</strong> e i permessi glieli si danno uno per uno — è l'unico
              default che non regala accessi per distrazione.
            </p>
          </div>
          {data.accessi.map((a) => (
            <RigaAccesso key={a.nome} a={a} persone={data.persone} />
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
        Niente di questa pagina è un confine di sicurezza, ed è meglio saperlo: tutto gira
        come root, l'hook del cancello fallisce aperto di proposito — un hook rotto non deve
        fermare il lavoro di nessuno — e chi ha una shell può aprire un <code>.env</code> a
        mano, senza passare da qui. Serve a rendere la strada giusta più comoda di quella
        sbagliata, e a far emergere ciò che oggi succede in silenzio. Il confine vero è un
        utente di sistema separato per persona.
      </p>
    </div>
  )
}
