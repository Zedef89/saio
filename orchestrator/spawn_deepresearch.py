#!/usr/bin/env python3
"""
DeepResearch Spawner — apre una sessione Claude gia' innescata con
/deep-research <query> --mode=<mode>.

Su Windows la sessione e' una nuova finestra CMD; su Linux/macOS (dove SAIO gira
headless sul devbox e non esiste nessun desktop su cui aprire una finestra) e'
una sessione tmux staccata, la stessa che la pagina "Sessioni" sa elencare e a
cui si puo' attaccare dal browser.

Riceve il payload JSON su stdin, scrive il risultato JSON su stdout.
"""

import json
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [deepresearch] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

CREATE_NEW_CONSOLE = 0x00000010

# Stesso ordine di candidati di server/lib/tmux-bin.ts: il PATH della GUI di macOS
# non include /opt/homebrew, su Linux tmux sta in /usr/bin.
TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "/bin/tmux"]


def _clean(s: str) -> str:
    return (
        s.replace('"', "'")
         .replace("^", "-").replace("|", "-")
         .replace("<", "(").replace(">", ")")
    )


def _tmux_bin() -> str:
    for p in TMUX_CANDIDATES:
        if Path(p).exists():
            return p
    return shutil.which("tmux") or "tmux"


def _tmux_has_session(tmux: str, name: str) -> bool:
    return subprocess.run(
        [tmux, "has-session", "-t", f"={name}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0


def _free_session_name(tmux: str, base: str) -> str:
    """Nome libero: se la ricerca sullo stesso topic e' gia' aperta non ci si scrive dentro."""
    if not _tmux_has_session(tmux, base):
        return base
    return f"{base}-{datetime.now().strftime('%H%M%S')}"


def _spawn_tmux(session_name: str, claude_cmd: str, cwd: str, kickoff_msg: str) -> dict:
    """Sessione tmux staccata + claude gia' avviato col prompt di kickoff."""
    tmux = _tmux_bin()
    if not Path(tmux).exists() and not shutil.which("tmux"):
        raise RuntimeError("tmux non trovato: serve per aprire la sessione di ricerca")

    name = _free_session_name(tmux, session_name)
    subprocess.run([tmux, "new-session", "-d", "-s", name, "-c", cwd], check=True)
    # Il prompt viene passato come argomento di claude: cosi' la ricerca parte da sola,
    # senza che qualcuno debba incollarlo a mano nella sessione.
    subprocess.run(
        [tmux, "send-keys", "-t", name, f"{claude_cmd} {shlex.quote(kickoff_msg)}", "Enter"],
        check=True,
    )

    pid = 0
    try:
        out = subprocess.run(
            [tmux, "display-message", "-p", "-t", name, "#{pane_pid}"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        pid = int(out) if out.isdigit() else 0
    except Exception:
        pass

    log.info(f"sessione tmux '{name}' creata in {cwd}")
    return {"name": name, "pid": pid}


def main() -> int:
    raw = sys.stdin.read()
    payload = json.loads(raw)
    title = payload.get("title", "DeepResearch")
    query = payload.get("query", "")
    mode = payload.get("mode", "standard")
    slug = payload.get("slug", "research")
    # Passati dalla route: nome sessione col prefisso del proprietario e comando claude
    # gia' completo di modalita' permessi. Se mancano si usano i default.
    session_name = payload.get("sessionName") or f"deepres-{slug[:40]}"
    claude_cmd = payload.get("claudeCmd") or "claude"
    cwd = payload.get("cwd") or str(Path.home())

    if not query or len(query) < 3:
        print(json.dumps({"spawned": False, "error": "query required"}))
        return 1
    if mode not in ("quick", "standard", "deep", "ultradeep"):
        mode = "standard"

    # Escape query for cmd embedding
    safe_query = _clean(query)[:500]
    terminal_title = f"DeepRes-{slug[:30]}"

    # Build claude prompt that triggers skill with mode hint
    claude_cmd_hint = f"/deep-research {safe_query}"
    kickoff_msg = (
        f"Usa la skill /deep-research in modalita {mode.upper()} sul topic: {safe_query}. "
        f"Output: PDF + Markdown + HTML in ~/Documents/ come da default della skill. "
        f"Se necessario plan mode, procedi autonomo."
    )

    first_line = _clean(f"===== DEEP RESEARCH: {title} =====")
    second_line = _clean(f"Mode: {mode.upper()} · Topic: {safe_query[:80]}")
    third_line = _clean(f"Digita a Claude: {claude_cmd_hint}")

    cmd_inner = (
        f'title {terminal_title}'
        f' && echo.'
        f' && echo {first_line}'
        f' && echo {second_line}'
        f' && echo.'
        f' && echo {third_line}'
        f' && echo.'
        f' && claude'
    )

    try:
        if sys.platform == "win32":
            proc = subprocess.Popen(
                ["cmd.exe", "/k", cmd_inner],
                shell=False,
                creationflags=CREATE_NEW_CONSOLE,
            )
            time.sleep(0.3)
            print(json.dumps({
                "spawned": True,
                "pid": proc.pid,
                "terminalTitle": terminal_title,
                "kickoffMessage": kickoff_msg,
            }))
            return 0

        # Linux/macOS: nessuna console da aprire, la sessione vive in tmux.
        if not Path(cwd).is_dir():
            cwd = str(Path.home())
        res = _spawn_tmux(session_name, claude_cmd, cwd, kickoff_msg)
        print(json.dumps({
            "spawned": True,
            "pid": res["pid"],
            "terminalTitle": res["name"],
            "tmuxSession": res["name"],
            "cwd": cwd,
            "kickoffMessage": kickoff_msg,
        }))
        return 0
    except Exception as e:
        log.exception("spawn_deepresearch failed")
        print(json.dumps({"spawned": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(json.dumps({"spawned": False, "error": str(e)}))
        sys.exit(1)
