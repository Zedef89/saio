# Le sessioni dei due account Claude non si vedono fra loro

> ✅ **RISOLTO il 22/08/2026** — `server/lib/session-bridge.ts`, avviato da `server/index.ts`.
> Il documento resta perché spiega *perché* il ponte esiste e cosa lo può rompere.

**Trovato il 22/08/2026 sulla devbox del team.** Non è una teoria: due sessioni stavano
lavorando sullo stesso repo (`komanda-dashboard`) nello stesso momento, una sull'account
`ufficio@` e una su `tech@`, e **nessuna delle due compariva nell'elenco dell'altra**.

Il manuale del progetto impone di annunciarsi alle altre sessioni prima di toccare un
file condiviso. Con i due account separati quella regola **non è applicabile**: la
sessione che si comporta bene e chiama `ListAgents` riceve una lista che non contiene
metà delle persone al lavoro, e ne conclude — in buona fede — di essere sola.

Quella notte è successo esattamente questo: la sessione su `tech@` stava per portare in
produzione un treno di 46 commit senza sapere che la sessione su `ufficio@` aveva quattro
file non committati a metà di una modifica alla stessa area.

## Come funziona la scoperta delle sessioni, oggi

Ogni sessione si registra in un file dentro la **cartella di configurazione del proprio
account**:

```
<config-dir>/sessions/<pid>.json          la scheda: nome, tmux, cwd, stato, protocollo
<config-dir>/sessions/<pid>.<sha256>.key  la chiave per parlarle
```

dove `<config-dir>` è `~/.claude` per l'account di default e `~/.claude-b` per il
secondo. `ListAgents` legge **solo la propria** cartella: da lì la cecità.

La scheda contiene, fra l'altro:

```json
{"pid": 3162210, "sessionId": "…", "cwd": "/root/dev/komanda-dashboard",
 "kind": "interactive", "tmux": "komanda-dashboard-miglioramento-ui:@51.%51",
 "messagingSocketPath": "/tmp/cc-socks/3162210.sock",
 "name": "improve-dashboard-ui", "status": "busy", "peerProtocol": 1,
 "peerFeatures": ["notify_idle"]}
```

## ⭐ Il punto che rende la cosa risolvibile

**Il trasporto è già condiviso.** I socket non stanno dentro le cartelle degli account:
stanno in `/tmp/cc-socks/<pid>.sock`, un percorso comune a tutti. Le due famiglie non
sono separate da un muro tecnico — sono separate **solo dalla scoperta e dalla chiave**.

Quindi non serve toccare il protocollo: basta che ogni sessione veda anche le schede
dell'altro account.

## Cosa può fare SAIO

SAIO è il posto giusto perché **è lui che apre le sessioni** e sa già, per ognuna, quale
account sta usando (`claude` o `claude-b`): l'informazione che manca alle sessioni, lui
ce l'ha in mano prima ancora che partano.

Tre strade, dalla più semplice alla più solida.

1. **Registro condiviso.** Una sola cartella (es. `/run/saio/cc-sessions`) e le
   `sessions/` dei due account che puntano lì. Zero codice, ma va fatto **prima** che le
   sessioni partano: sostituire quella cartella sotto una sessione viva è il modo
   migliore per romperla.

2. **Specchio, a evento.** SAIO copia la coppia `<pid>.json` + `<pid>.*.key` nell'altra
   cartella quando una sessione nasce, e la toglie quando muore. I nomi dei file sono già
   unici per pid, quindi non ci sono collisioni, ed è reversibile: si cancellano le copie
   e si torna com'era. È la strada che consiglierei per prima.

3. **Relè in SAIO.** Nessun file spostato: SAIO espone «manda un messaggio alla sessione
   X» e inoltra lui sul socket giusto. Più lavoro, ma è l'unica che non dipende da un
   formato interno di Claude Code.

## L'avvertenza che va scritta accanto al fix

`sessions/*.json` è un **dettaglio interno**, non un'API pubblica: un aggiornamento di
Claude Code può cambiarne forma o posizione. Qualunque strada si scelga fra la 1 e la 2,
SAIO dovrebbe **verificare il formato all'avvio** e, se non lo riconosce, **smettere di
specchiare** invece di scrivere file che nessuno legge più — o peggio, che qualcuno legge
male. La strada 3 non ha questo problema.

## Nel frattempo

Finché non c'è il fix, l'unico coordinamento possibile fra i due account passa da una
persona. Vale la pena saperlo e dirlo: **`ListAgents` che non mostra nessuno non
significa che non ci sia nessuno.** Per capire se qualcun altro sta lavorando sullo
stesso repo, oggi, i due modi che funzionano davvero sono `tmux ls` e guardare i worktree
altrui con `git -C <worktree> status --porcelain`.

---

## Com'è stato risolto (22/08/2026)

Scelta la **strada 2, lo specchio**: `server/lib/session-bridge.ts` copia ogni 5 secondi le
schede di sessione fra i due registri, nei due versi. Non tocca il protocollo, non sposta
niente, e funziona anche per le sessioni aperte da terminale invece che da SAIO.

Le quattro regole che lo rendono sicuro stanno nel docstring del modulo. La più importante:
**ogni copia ha un marcatore `<pid>.saio-mirror`, e si cancella solo ciò che porta il
marcatore** — una scheda vera non viene mai rimossa, nemmeno per un errore di lettura.

### La guardia ha già lavorato, al primo avvio

Il ponte era puntato per errore sulle *config dir* invece che su `<config-dir>/sessions`,
quindi ha trovato `.credentials.json` e `.claude.json`. Non ha copiato niente: ha
riconosciuto che il formato non era quello atteso, si è **spento da solo** e l'ha scritto
nel log —

    [session-bridge] formato di .credentials.json non riconosciuto (manca "pid"): ponte SPENTO.

È esattamente il comportamento per cui la guardia era stata scritta, arrivato addosso al
suo autore mezz'ora dopo. Vale la pena tenerlo come prova che la protezione funziona: se un
domani Claude Code cambia il formato del registro, il ponte smette invece di sporcare.

### Se un giorno smette di funzionare

Nel log di SAIO (`/var/log/saio.log`) si cerca `session-bridge`. Tre casi:

| cosa si legge | significa |
|---|---|
| «attivo» e nient'altro | tutto a posto, non c'era niente di nuovo da specchiare |
| «N sessioni rese visibili» | ha lavorato |
| «ponte SPENTO» | Claude Code ha cambiato il formato: va riallineato a mano, e fino ad allora si torna a `tmux ls` |
