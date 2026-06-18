#!/usr/bin/env python3
"""Build the Pimsleur-style audio drills for listen/.

Per word:  English prompt -> pause (say it yourself) -> Chinese answer x2.
Per lesson: all words concatenated -> listen/lesson-NN.mp3
Whole set:  every lesson back to back   -> listen/all-vocab-drill.mp3

Reads tools/_drill.json. Caches synthesis in tools/_listen_cache/.
Prints total duration so listen/index.html can be updated.
"""
import os, sys, json, hashlib, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRILL = os.path.join(ROOT, 'tools', '_drill.json')
LISTEN = os.path.join(ROOT, 'listen')
CACHE = os.path.join(ROOT, 'tools', '_listen_cache')
ZH_VOICE = os.environ.get('VOICE', 'Tingting')
EN_VOICE = os.environ.get('EN_VOICE', 'Samantha')
GAP_THINK = 1.6   # pause after English for the learner to answer
GAP_REP = 0.45    # between the two Chinese repetitions
GAP_WORD = 0.7    # between words

os.makedirs(LISTEN, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)

def synth(text, voice):
    key = hashlib.md5(f'{voice}|{text}'.encode('utf-8')).hexdigest()[:16]
    wav = os.path.join(CACHE, f'{key}.wav')
    if os.path.exists(wav) and os.path.getsize(wav) > 0:
        return wav
    with tempfile.NamedTemporaryFile(suffix='.aiff', delete=False) as tf:
        aiff = tf.name
    try:
        run(['say', '-v', voice, '-o', aiff, text])
        run(['ffmpeg', '-nostdin', '-y', '-loglevel', 'error', '-i', aiff,
             '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
    finally:
        try: os.unlink(aiff)
        except OSError: pass
    return wav

def silence(dur):
    wav = os.path.join(CACHE, f'sil_{dur}.wav')
    if not os.path.exists(wav):
        run(['ffmpeg', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi',
             '-i', 'anullsrc=r=24000:cl=mono', '-t', str(dur),
             '-c:a', 'pcm_s16le', wav])
    return wav

def concat_to_mp3(seg_wavs, out_mp3):
    fd, listfile = tempfile.mkstemp(suffix='.txt', dir=CACHE)
    with os.fdopen(fd, 'w') as f:
        for w in seg_wavs:
            f.write(f"file '{w}'\n")
    try:
        run(['ffmpeg', '-nostdin', '-y', '-loglevel', 'error', '-f', 'concat',
             '-safe', '0', '-i', listfile, '-codec:a', 'libmp3lame', '-q:a', '5', out_mp3])
    finally:
        try: os.unlink(listfile)
        except OSError: pass

def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'default=noprint_wrappers=1:nokey=1', path],
                         capture_output=True, text=True).stdout.strip()
    try: return float(out)
    except ValueError: return 0.0

def main():
    drill = json.load(open(DRILL, encoding='utf-8'))
    sil_think, sil_rep, sil_word = silence(GAP_THINK), silence(GAP_REP), silence(GAP_WORD)
    all_segs = []
    total_words = 0
    for lesson in drill:
        segs = []
        for w in lesson['words']:
            zh, en = w['chinese'], w['english']
            if not zh:
                continue
            en_say = en if en else zh
            segs += [synth(en_say, EN_VOICE), sil_think,
                     synth(zh, ZH_VOICE), sil_rep, synth(zh, ZH_VOICE), sil_word]
            total_words += 1
        if not segs:
            continue
        out = os.path.join(LISTEN, f"lesson-{lesson['id']:02d}.mp3")
        concat_to_mp3(segs, out)
        all_segs += segs
        print(f"  lesson-{lesson['id']:02d}.mp3  ({len(lesson['words'])} words, {duration(out):.0f}s)")
    if all_segs:
        allout = os.path.join(LISTEN, 'all-vocab-drill.mp3')
        concat_to_mp3(all_segs, allout)
        total = duration(allout)
        size_mb = os.path.getsize(allout) / 1_000_000
        print(f"all-vocab-drill.mp3  words={total_words}  {total/60:.1f} min  {size_mb:.0f} MB")
        # emit machine-readable summary for listen page patching
        json.dump({'words': total_words, 'minutes': round(total/60),
                   'mb': round(size_mb), 'lessons': len(drill)},
                  open(os.path.join(ROOT, 'tools', '_listen_summary.json'), 'w'))

if __name__ == '__main__':
    main()
