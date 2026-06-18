# Ten-Level Chinese — Flashcards (Level 1)

A clean, Anki-style flashcard site for the **Level 1 Integrated Textbook** (拾级汉语 综合课本 第1级) by Beijing Language and Culture University Press. Every lesson is broken into three decks: vocabulary, example sentences, and the 读写字 characters.

Local-only. No accounts. No analytics. Your progress lives in `localStorage`.

This is the Level 1 companion to the [Level 2 site](https://petervanpercson.github.io/chinese-flashcards/) — same app, same keyboard-first design, rebuilt for the first-level textbook.

---

## Run it

The site is fully static, but browsers block `fetch()` from `file://`, so it needs a one-line server:

```bash
cd ~/Desktop/chinese-flashcards-level1
python3 -m http.server 8000
# then open http://localhost:8000
```

…or any other static server you like (`npx serve`, Live Server in VS Code, etc.).

## What's in it

- **16 lessons** transcribed directly from the textbook
- Vocabulary cards with Chinese · pinyin · part of speech · English
- Example sentences drawn from the dialogues, with generated pinyin
- "Read & write" characters (读写字) as character cards with stroke-order practice
- Per-card audio (macOS Tingting voice) + Pimsleur-style audio drills under `/listen`
- Three study modes per lesson · keyboard-first · paper-style design · light / dark themes

## Files

```
chinese-flashcards-level1/
├─ index.html              ← the app
├─ assets/
│   ├─ styles.css          ← design system + components
│   ├─ app.js              ← hash router, deck logic, localStorage
│   └─ audio/              ← per-card mp3 + manifest.json
├─ data/
│   └─ lessons.json        ← all 16 lessons' content
├─ listen/                 ← hands-free audio drills
├─ manifest.json · sw.js   ← installable, offline PWA
└─ tools/                  ← build scripts (not served): build.py, gen_audio.py, gen_listen.py
```

## Rebuilding the data / audio

```bash
# 1. drop the extracted lesson content at tools/_extracted.json, then:
python3 tools/build.py          # -> data/lessons.json + assets/audio/manifest.json
python3 tools/gen_audio.py      # -> per-card mp3s (needs macOS `say` + ffmpeg)
python3 tools/gen_listen.py     # -> listen/lesson-NN.mp3 + all-vocab-drill.mp3
```

## Keyboard

| Key | Action |
| --- | --- |
| `Space` / `Enter` | Flip card |
| `→` `↓` `J` | Next card |
| `←` `↑` `K` | Previous card |
| `1` `2` `3` `4` | Grade Again / Hard / Good / Easy |
| `P` | Play audio |
| `S` | Shuffle the deck |
| `R` | Restart the deck |

## Source

Wu Zhongwei, Xu Jing, Li Lin. *Ten-Level Chinese — Integrated Textbook, Level 1 / 拾级汉语 综合课本 第1级*. Beijing Language and Culture University Press, 2007.
