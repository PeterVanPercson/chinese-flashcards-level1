#!/usr/bin/env python3
"""Build data/lessons.json (+ audio manifest plan) from tools/_extracted.json.

Input  : tools/_extracted.json  = {"lessons":[{id,title_zh,title_pinyin,title_en,
            characters[], vocab[{chinese,pinyin,pos,english}],
            char_readings[{char,pinyin,gloss}], sentences[{chinese,english}]}]}
Output : data/lessons.json                 (Level-2 schema the app expects)
         assets/audio/manifest.json         (text -> md5[:16].mp3)
         tools/_tospeak.tsv                 (text \t filename, for gen_audio.sh)
         tools/_drill.json                  (per-lesson vocab for listen/ drills)
"""
import json, os, re, hashlib, sys
from pypinyin import lazy_pinyin, Style

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRACTED = os.path.join(ROOT, 'tools', '_extracted.json')
OUT_LESSONS = os.path.join(ROOT, 'data', 'lessons.json')
OUT_MANIFEST = os.path.join(ROOT, 'assets', 'audio', 'manifest.json')
OUT_TSV = os.path.join(ROOT, 'tools', '_tospeak.tsv')
OUT_DRILL = os.path.join(ROOT, 'tools', '_drill.json')

HAN = re.compile(r'[㐀-鿿]')
ALLHAN = re.compile(r'^[㐀-鿿]+$')
PUNCT_MAP = {'，': ', ', '。': '. ', '？': '? ', '！': '! ', '：': ': ', '、': ', ',
            '；': '; ', '（': ' (', '）': ') ', '“': ' "', '”': '" ', '‘': " '",
            '’': "' ", '《': ' "', '》': '" ', '．': '. ', '…': '… '}

CAST = {
    '林娜': 'Lín Nà', '田中': 'Tiánzhōng', '大卫': 'Dàwèi (David)',
    '亚历山大': 'Yàlìshāndà (Alexander)', '马小红': 'Mǎ Xiǎohóng',
    '李大中': 'Lǐ Dàzhōng', '王林': 'Wáng Lín', '沙夏丽': 'Shāxiàlì',
    '王老师': 'Wáng lǎoshī', '王海': 'Wáng Hǎi', '张力': 'Zhāng Lì',
}

def is_han(c):
    return bool(HAN.match(c))

def audio_name(text):
    return hashlib.md5(text.encode('utf-8')).hexdigest()[:16] + '.mp3'

def main():
    data = json.load(open(EXTRACTED, encoding='utf-8'))
    lessons_in = data['lessons']

    # Global vocab pinyin dict (longest-match segmentation for sentence pinyin).
    vocab_py = {}
    for L in lessons_in:
        for v in L.get('vocab', []):
            zh = (v.get('chinese') or '').strip()
            py = (v.get('pinyin') or '').strip()
            if zh and py and ALLHAN.match(zh) and zh not in vocab_py:
                vocab_py[zh] = py
        for cr in L.get('char_readings', []):
            ch = (cr.get('char') or '').strip()
            py = (cr.get('pinyin') or '').strip()
            if ch and py and ch not in vocab_py:
                vocab_py[ch] = py
    # Common bound forms the book joins but that rarely appear as standalone
    # vocab entries — keeps greedy sentence-pinyin from splitting them.
    SUPP = {'我们': 'wǒmen', '你们': 'nǐmen', '他们': 'tāmen', '她们': 'tāmen',
            '它们': 'tāmen', '咱们': 'zánmen', '它': 'tā',
            '这儿': 'zhèr', '那儿': 'nàr', '哪儿': 'nǎr',
            '一点儿': 'yìdiǎnr', '一会儿': 'yíhuìr', '玩儿': 'wánr'}
    for k, v in SUPP.items():
        vocab_py.setdefault(k, v)
    MAXLEN = max((len(k) for k in vocab_py), default=1)

    def sent_pinyin(s):
        toks, i, n = [], 0, len(s)
        while i < n:
            ch = s[i]
            if not is_han(ch):
                toks.append(('p', ch)); i += 1; continue
            hit = None
            for L in range(min(MAXLEN, n - i), 0, -1):
                sub = s[i:i+L]
                if sub in vocab_py:
                    hit = (sub, vocab_py[sub]); break
            if hit:
                toks.append(('w', hit[1])); i += len(hit[0])
            else:
                toks.append(('w', lazy_pinyin(ch, style=Style.TONE, errors='ignore')[0] if lazy_pinyin(ch, style=Style.TONE, errors='ignore') else ch)); i += 1
        out = ''
        for kind, val in toks:
            if kind == 'w':
                if out and not out.endswith((' ', '(', '"', "'")):
                    out += ' '
                out += val
            else:
                out += PUNCT_MAP.get(val, val)
        out = re.sub(r'\s+', ' ', out).strip()
        out = re.sub(r'\s+([,.?!:;])', r'\1', out)
        if out:
            out = out[0].upper() + out[1:]
        return out

    lessons_out = []
    audio_texts = set()
    drill = []
    for L in lessons_in:
        chars = L.get('characters', [])
        vocab = [{'chinese': v.get('chinese', '').strip(),
                  'pinyin': v.get('pinyin', '').strip(),
                  'pos': (v.get('pos') or '').strip(),
                  'english': v.get('english', '').strip()}
                 for v in L.get('vocab', []) if (v.get('chinese') or '').strip()]
        readings = {cr['char']: cr for cr in L.get('char_readings', []) if cr.get('char')}

        sentences = []
        for s in L.get('sentences', []):
            zh = (s.get('chinese') or '').strip()
            if not zh:
                continue
            sentences.append({'chinese': zh,
                              'pinyin': sent_pinyin(zh),
                              'english': (s.get('english') or '').strip()})

        char_pinyin, char_gloss, char_compounds, char_examples = {}, {}, {}, {}
        for c in chars:
            r = readings.get(c, {})
            char_pinyin[c] = (r.get('pinyin') or vocab_py.get(c, '')).strip()
            char_gloss[c] = (r.get('gloss') or '').strip()
            # compounds: multi-char vocab words in THIS lesson containing c
            comps = []
            seen = set()
            for v in vocab:
                w = v['chinese']
                if len(w) > 1 and c in w and ALLHAN.match(w) and w not in seen:
                    seen.add(w)
                    comps.append({'word': w, 'pinyin': v['pinyin'], 'english': v['english']})
            char_compounds[c] = comps[:6]
            # examples: sentences in THIS lesson containing c
            exs = []
            for s in sentences:
                if c in s['chinese'] and len(s['chinese']) <= 18:
                    exs.append({'sentence': s['chinese'], 'pinyin': s['pinyin'], 'english': s['english']})
                if len(exs) >= 3:
                    break
            char_examples[c] = exs

        lessons_out.append({
            'id': L['id'],
            'title_zh': L['title_zh'],
            'title_pinyin': L['title_pinyin'],
            'title_en': L['title_en'],
            'characters': chars,
            'vocab': vocab,
            'sentences': sentences,
            'char_compounds': char_compounds,
            'char_pinyin': char_pinyin,
            'char_examples': char_examples,
            'char_gloss': char_gloss,
        })

        for v in vocab:
            audio_texts.add(v['chinese'])
        for s in sentences:
            audio_texts.add(s['chinese'])
        for c in chars:
            audio_texts.add(c)

        drill.append({'id': L['id'],
                      'words': [{'chinese': v['chinese'], 'english': v['english']} for v in vocab]})

    meta = {
        'title': 'Ten-Level Chinese — Integrated Textbook (Level 1)',
        'title_zh': '拾级汉语 综合课本 第1级',
        'publisher': 'Beijing Language and Culture University Press',
        'editors': 'Wu Zhongwei, Xu Jing, Li Lin',
        'source': 'Level 1 - Integrated Textbook.pdf',
        'total_lessons': len(lessons_out),
        'characters': CAST,
        'vocab_total': sum(len(l['vocab']) for l in lessons_out),
        'sentence_total': sum(len(l['sentences']) for l in lessons_out),
        'character_total': sum(len(l['characters']) for l in lessons_out),
    }

    json.dump({'meta': meta, 'lessons': lessons_out},
              open(OUT_LESSONS, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

    manifest = {t: audio_name(t) for t in sorted(audio_texts)}
    json.dump(manifest, open(OUT_MANIFEST, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)

    with open(OUT_TSV, 'w', encoding='utf-8') as f:
        for t in sorted(audio_texts):
            f.write(f"{t}\t{audio_name(t)}\n")

    json.dump(drill, open(OUT_DRILL, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

    print(f"lessons={len(lessons_out)} vocab={meta['vocab_total']} "
          f"sentences={meta['sentence_total']} chars={meta['character_total']} "
          f"unique_audio={len(manifest)}")

if __name__ == '__main__':
    main()
