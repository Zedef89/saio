#!/usr/bin/env python3
"""Riceve solo la telemetria locale di Claude. Nessuna rete e nessuna credenziale."""
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
from datetime import datetime, timezone


def snapshot(data):
    limits = data.get('rate_limits') or {}
    windows = [limits.get(k) or {} for k in ('five_hour', 'seven_day')]
    # Una finestra mancante non significa quota libera.
    if not all(isinstance(w.get('used_percentage'), (float, int)) and
               math.isfinite(w['used_percentage']) and w['used_percentage'] >= 0 for w in windows):
        return None
    five, week = windows
    def reset(w):
        n = w.get('resets_at')
        return datetime.fromtimestamp(n, timezone.utc).isoformat() if isinstance(n, (float, int)) and math.isfinite(n) else None
    percent = max(five['used_percentage'], week['used_percentage'])
    return {'at': int(time.time() * 1000), 'source': 'claude-statusline', 'usage': {
        'weeklyPercent': week['used_percentage'], 'sessionPercent': five['used_percentage'],
        'weeklyResetsAt': reset(week), 'sessionResetsAt': reset(five),
        'severity': 'critical' if percent >= 95 else 'warning' if percent >= 75 else 'normal',
    }}


def main():
    data = json.load(sys.stdin)
    snap = snapshot(data)
    config = Path(sys.argv[1])
    if snap:
        marker = [data.get('session_id'), (data.get('cost') or {}).get('total_api_duration_ms'),
                  (data.get('context_window') or {}).get('total_output_tokens')]
        dest = config / 'saio-usage-local.json'
        # Rerender della stessa risposta: non ringiovanire il dato a ogni passaggio UI.
        try:
            prev = json.loads(dest.read_text())
        except (OSError, ValueError):
            prev = {}
        if prev.get('observation') != marker or prev.get('usage') != snap['usage']:
            snap['observation'] = marker
            fd, tmp = tempfile.mkstemp(prefix='.saio-usage-', dir=config)
            try:
                with os.fdopen(fd, 'w') as f:
                    json.dump(snap, f)
                os.replace(tmp, dest)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
    model = (data.get('model') or {}).get('display_name') or 'Claude'
    if snap:
        u = snap['usage']
        print(f"{model} · 5h {u['sessionPercent']:g}% · settimana {u['weeklyPercent']:g}%")
    else:
        print(model)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, OverflowError):
        pass  # La barra non deve interrompere la sessione se un dato manca.
