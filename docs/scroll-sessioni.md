# Scorrimento delle sessioni

Verificato: 2026-10-26. Copre `src/components/projects/EmbeddedChat.tsx`.

Le sessioni che attivano il mouse (Claude) ricevono gli eventi originali della
rotella e il pan touch tradotto in eventi SGR. Se il terminale usa lo schermo
alternato senza richiedere il mouse (Codex), rotella e pan touch inviano invece
PageUp/PageDown: lo storico è gestito dalla CLI e il buffer locale non scorre.
La soglia è 80 pixel per pagina; il normale buffer del terminale resta a xterm.
Ctrl+rotella non viene intercettato. I listener vengono rimossi alla chiusura.

Prova: Chromium con xterm reale, schermo alternato e mouse spento: rotella su/giù
e pan touch generano PageUp/PageDown. Con mouse attivo o buffer normale nessun
PageUp/PageDown viene generato. Build TypeScript/Vite verde. Nella sessione live
Codex `nicola-riordino-gruppi`, PageUp ha riportato a schermo la risposta precedente.

Aggiornamento dello stesso giorno: il replay PTY (massimo 1 MB) può non
contenere più l'escape iniziale dello schermo alternato. In assenza di mouse,
il footer Codex attiva lo stesso percorso anche nel buffer normale ricostruito.
Prova Chromium aggiuntiva: buffer normale con footer GPT, PageUp generato.
I listener touch usano la fase capture; touch-action:none impedisce al browser
di cancellare il pan prima della soglia. Pulsanti ↑/↓ inviano esplicitamente
PageUp/PageDown, anche nelle sessioni già aperte.
