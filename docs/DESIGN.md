# Ten-Level Chinese Flashcards — Design

A single-page, fully-local flashcard app for the **Level 2 Integrated Textbook (拾级汉语 综合课本 第2级)** by BLCU Press.

---

## 1 · Product principles

1. **Look like the source.** The textbook is printed on cream paper with ink-red accents and serif characters. The UI takes the same posture: paper background, serif Chinese, restrained chrome.
2. **Anki-style, not Anki-faithful.** The user wanted "like Anki, for each lesson." So: front-of-card / back-of-card, 4-level grade buttons, keyboard-first — but no SRS scheduling, no cloud sync, no decks of decks. Lessons are the only organising unit.
3. **Local-only.** No accounts, no analytics, no remote calls. Progress lives in `localStorage`. The whole site runs from `file://` after a one-time `python3 -m http.server`.
4. **Touch and keyboard parity.** Every action has both a button and a keyboard shortcut. Touch-only screens hide the keyboard legend.

---

## 2 · Design system

### Tokens (CSS custom properties)

| Group | Token | Light | Dark |
| --- | --- | --- | --- |
| Background | `--bg` | `#FAF6EE` (warm paper) | `#1A1916` (ink black) |
| Elevated surface | `--bg-elev` | `#FFFDF7` | `#22211D` |
| Sunken | `--bg-sunken` | `#F2EDE2` | `#15140F` |
| Text · primary | `--ink` | `#1B1A18` | `#F0EBDD` |
| Text · soft | `--ink-soft` | `#2B2A26` | `#DCD6C5` |
| Text · muted | `--ink-mute` | `#6E6A60` | `#98927F` |
| Text · faint | `--ink-faint` | `#A8A294` | `#5E5A4D` |
| Rule | `--rule` | `#E5DECF` | `#36332B` |
| Brand · ink red | `--accent` | `#B43A2E` | `#E07466` |
| Brand · jade | `--jade` | `#4F7A57` | `#82B08C` |
| Brand · gold | `--gold` | `#B5851F` | `#DCB75A` |
| Grade · again | `--grade-again` | `#C2453B` | (same) |
| Grade · hard | `--grade-hard` | `#B5851F` | (same) |
| Grade · good | `--grade-good` | `#4F7A57` | (same) |
| Grade · easy | `--grade-easy` | `#3D6AA1` | (same) |

Contrast: body text on background is **~16:1**; muted text on background is **~5.5:1** (passes WCAG AA for normal text).

### Typography

| Role | Font | Weight | Size scale |
| --- | --- | --- | --- |
| Chinese display | **Noto Serif SC** → Songti SC → STSong | 700 | `clamp(4rem, 12vw, 9rem)` for flashcards |
| Chinese body / titles | Noto Serif SC | 600 / 700 | 22–36px |
| Pinyin | Inter italic | 400 | 14–28px |
| English / UI | **Inter** | 400 / 500 / 600 / 700 | 12–18px |
| Code, kbd, badges | **JetBrains Mono** | 400 / 500 | 12px |

Type scale tokens are `--t-xs` (12) through `--t-hero` (72). A separate `--t-zh` clamp drives the big card character.

### Spacing & radii

8-pt grid: `--s-1` (4) through `--s-9` (96). Radii are `--r-sm` (6), `--r-md` (10), `--r-lg` (16), `--r-xl` (22), `--r-2xl` (28), `--r-pill` (999). Cards use `--r-2xl`; buttons use `--r-md`; chips use `--r-pill`.

### Shadows

Paper-style, low-spread, two-stop. `--sh-1` for resting; `--sh-3` for hover; `--sh-4` for the flashcard. Dark theme deepens the shadow alpha (~0.5) without changing the silhouette.

### Motion

- **Card flip:** `transform: rotateY(180deg)` over 520ms, easing `cubic-bezier(.2,.7,.2,1)`.
- **Hover lift:** `translateY(-2px)` and shadow swap in 180ms.
- **Grade nudge:** small `shake` on Again, soft `pulseGood` on Good/Easy.
- Honours `prefers-reduced-motion: reduce` and a manual "Reduce motion" toggle in settings.

---

## 3 · Components

### Brand mark
40 × 40 square, accent-red bg, white serif `拾` (Stroke 10 of the textbook title). Doubles as the home link.

### Lesson card
`.lesson-card`
- Compact, ≥260 × 168 with a hairline rule between meta and body.
- Reveals a progress ribbon (jade → accent gradient) along the bottom edge.
- Hover: 2 px lift, deeper shadow, border picks up 30 % accent.
- Full card is the link target; the entire title and English summary are inside the `aria-label`.

### Mode card
`.mode-card`
- Three per lesson: Vocabulary (red), Sentences (jade), Characters (gold). The icon tile uses the same hue as the family it represents.

### Flashcard
`.card` → `.card__inner` → `.card__face`
- 1.55:1 aspect ratio. Front gets a subtle red wash at top; back gets a jade wash so the colour confirms which face you're on.
- Paper grain: tiny radial-gradient dots at 6 px tiling, blended multiply on light, screen on dark.
- Sentence mode adds `.card--sentence` which drops the Chinese to a readable display size and caps width at ~22ch.

### Action row
Four grade buttons (Again / Hard / Good / Easy) with semantic colours and a `<kbd>` chip showing the `1`–`4` shortcut. Collapses to icon-stack on phones.

### Nav row
4-column grid on desktop (Prev — Shuffle — Restart — Next), 2 × 2 on phones. Shuffle is a toggle and uses `aria-pressed`.

### Settings dialog
Native `<dialog>` element with `::backdrop` blur. Settings: theme, card-front direction (Chinese→English vs English→Chinese), Chinese size (M/L/XL), auto-flip on grade, reduce motion, and "Reset all progress" (destructive button, red).

---

## 4 · Information architecture

```
#/                       Home (hero, stats, 20-lesson grid)
#/lesson/{id}            Lesson page (3 study modes, full vocab table)
#/study/{id}/vocab       Flashcards of 词语 (words & expressions)
#/study/{id}/sentences   Flashcards of example sentences
#/study/{id}/characters  Flashcards of 读写字 characters
```

Routing is hash-based, no server-side anything. Back/forward work natively.

### Data model

```jsonc
{
  "meta": { "title": "...", "title_zh": "...", "publisher": "...", "total_lessons": 20 },
  "lessons": [
    {
      "id": 1,
      "title_zh": "最近在忙什么？",
      "title_pinyin": "Zuìjìn zài máng shénme?",
      "title_en": "What have you been busy doing recently?",
      "characters": ["久", "毕", ...],
      "vocab":     [{ "chinese": "好久不见", "pinyin": "hǎojiǔ bù jiàn", "pos": "", "english": "long time no see" }, ...],
      "sentences": [{ "chinese": "好久不见！", "pinyin": "Hǎojiǔ bù jiàn!", "english": "Long time no see!" }, ...]
    },
    ...20 lessons total
  ]
}
```

### Storage

| Key | Shape | Purpose |
| --- | --- | --- |
| `tlc.settings.v1` | `{ theme, front, size, autoFlip, reduceMotion }` | UI preferences |
| `tlc.v1` | `{ lessons: { [id]: { [cardKey]: grade } }, lastStudyDate, streak }` | Per-card grade + daily streak |

`cardKey` shape is `L{lessonId}.{v|s|c}.{index}` — stable, regenerable from data.

---

## 5 · Interaction map

| Surface | Input | Behaviour |
| --- | --- | --- |
| Card | Click / Tap | Flip (axis Y) |
| Card | `Space` / `Enter` | Flip |
| App-wide (study) | `→` `↓` `J` | Next card |
| App-wide (study) | `←` `↑` `K` | Previous card |
| App-wide (study) | `1` `2` `3` `4` | Grade Again / Hard / Good / Easy, advance 220 ms later |
| App-wide (study) | `S` | Toggle shuffle (re-shuffles deck) |
| App-wide (study) | `R` | Restart the deck |
| Skip link | First Tab | Jump past topbar into `<main>` |

After every grade the card auto-advances. When the last card is graded, a "Deck complete" panel summarises Good / Hard / Again counts and offers Restart or Back-to-lesson.

---

## 6 · Accessibility

- **Skip-link** ("Skip to main content") is the first focusable element.
- **Focus ring** is a 2 px accent outline with 3 px offset, applied via `:focus-visible` so mouse users don't see it.
- **ARIA**:
  - Card has `role="button"`, `aria-label="Flip card"`, `aria-pressed` synced to the flipped state.
  - Progress bar has `role="progressbar"` with `aria-valuemin/max`.
  - The "1 / 28" counter is wrapped in `aria-live="polite"` so screen readers announce position changes.
  - Lesson cards include the lesson title in `aria-label`.
  - Settings opens as a true `<dialog>` (focus trap and backdrop come for free).
- **Reduced motion**: both the system query and a manual toggle disable the 520 ms flip transition; the card swaps state instantly.
- **Touch**: 44 × 44 minimum hit area on all controls; the legend of keyboard hints is hidden under `(pointer: coarse)` or width ≤ 720 px.
- **Colour is never the only signal.** Grade buttons carry text labels and shortcut chips alongside their colour.

---

## 7 · Responsive behaviour

| Breakpoint | Change |
| --- | --- |
| ≥ 1080 px | 4-column lesson grid, 4-column action row, side-by-side hero stats |
| 720 – 1079 px | 3-column lesson grid, 4-column action row |
| 540 – 719 px | 2-column lesson grid, action row stacks label-over-key, nav row collapses to 2 × 2 grid |
| < 540 px | Single-column grids, hero stats wrap, keyboard legend hidden |

Container width caps at 1080 px; horizontal padding is `clamp(16px, 4vw, 48px)`.

---

## 8 · Engineering notes for handoff

- **Stack:** Plain HTML, modern CSS (custom properties, container queries not used), one ES module of vanilla JS. No build step. ~870 LOC total.
- **Hash router** drives `view-home`, `view-lesson`, `view-study` visibility. Each view re-renders on route change.
- **Card deck** is built per-mode from the lesson data and held in `state.deck`. Shuffle is non-destructive of the source data.
- **Storage migration:** key suffixes `v1` are intentional. Bump them when the data shape changes.
- **Performance:** The whole bundle (HTML + CSS + JS + 20-lesson JSON) is ~180 KB uncompressed. The font payload from Google Fonts dominates first load (~300 KB); swap to self-hosted Noto Serif SC subset to trim further.
- **Known limitations:**
  - No spaced-repetition scheduling; grades only mark cards "known" for the lifetime progress.
  - Pinyin is treated as text — no audio yet. Adding TTS would slot into `card__pinyin` (e.g., a button using the Web Speech API).
  - The 20-lesson dataset includes the textbook's *Read & Write* characters and 14–22 example sentences per lesson. Adding the cultural-reading vocab and exercises is a future iteration.

---

## 9 · Future work

1. **Audio.** Add Web Speech `speechSynthesis` (zh-CN) to pronounce the front of any card.
2. **Spaced repetition.** A small SM-2 scheduler keyed off the existing grade data, with a "Due today" deck on the home page.
3. **Stroke-order.** For Characters mode, render an animated SVG via Hanzi Writer.
4. **Search.** A `/` shortcut that surfaces a fuzzy search across all vocab.
5. **Export progress.** Download the `localStorage` blob as JSON for backup or device transfer.
