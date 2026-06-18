#!/usr/bin/env python3
"""Generate one MP3 per unique card text using macOS `say` (Tingting zh_CN) -> ffmpeg.

Reads tools/_tospeak.tsv (text<TAB>filename). Idempotent: skips files that exist.
Parallelised with a thread pool. Pure-argv subprocess calls (no shell) so Chinese
text and punctuation are passed safely.
"""
import os, sys, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TSV = os.path.join(ROOT, 'tools', '_tospeak.tsv')
OUT = os.path.join(ROOT, 'assets', 'audio')
VOICE = os.environ.get('VOICE', 'Tingting')
JOBS = int(os.environ.get('JOBS', '6'))

os.makedirs(OUT, exist_ok=True)

def gen(text, fname):
    dest = os.path.join(OUT, fname)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return ('skip', text)
    with tempfile.NamedTemporaryFile(suffix='.aiff', delete=False) as tf:
        aiff = tf.name
    try:
        subprocess.run(['say', '-v', VOICE, '-o', aiff, text],
                       check=True, capture_output=True, timeout=60)
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-loglevel', 'error',
                        '-i', aiff, '-codec:a', 'libmp3lame', '-q:a', '6',
                        '-ar', '24000', '-ac', '1', dest],
                       check=True, capture_output=True, timeout=60)
        return ('ok', text)
    except Exception as e:
        return ('fail', f'{text}: {e}')
    finally:
        try: os.unlink(aiff)
        except OSError: pass

def main():
    rows = []
    with open(TSV, encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line or '\t' not in line:
                continue
            text, fname = line.split('\t', 1)
            rows.append((text, fname))
    print(f'{len(rows)} unique texts, voice={VOICE}, jobs={JOBS}')
    ok = skip = fail = 0
    with ThreadPoolExecutor(max_workers=JOBS) as ex:
        futs = [ex.submit(gen, t, fn) for t, fn in rows]
        for i, fut in enumerate(as_completed(futs), 1):
            status, msg = fut.result()
            if status == 'ok': ok += 1
            elif status == 'skip': skip += 1
            else:
                fail += 1
                print('  FAIL', msg, file=sys.stderr)
            if i % 100 == 0:
                print(f'  {i}/{len(rows)} (ok={ok} skip={skip} fail={fail})')
    made = len([n for n in os.listdir(OUT) if n.endswith('.mp3')])
    print(f'Done. ok={ok} skip={skip} fail={fail}. {made} mp3 in assets/audio/')

if __name__ == '__main__':
    main()
