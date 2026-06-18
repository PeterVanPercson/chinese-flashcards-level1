/* ============================================================
   Ten-Level Chinese — Flashcards
   Vanilla JS, single page, hash router, localStorage progress
   ============================================================ */

'use strict';

const STORAGE_KEY = 'tlc.v1';
const SETTINGS_KEY = 'tlc.settings.v1';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const html = String.raw;
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------- state ---------------------- */
const state = {
  data: null,
  view: 'home',
  lessonId: null,
  mode: null,            // vocab | sentences | characters
  queueType: null,       // null | 'due' | 'weak' | 'random'
  deck: [],
  index: 0,
  totalUnique: 0,        // unique cards at session start ("Again" requeues grow the deck)
  pendingIndex: null,    // deep-link card index from the route (search)
  flipped: false,
  shuffled: false,
  finished: false,
  reviewed: new Set(),
  grades: {},            // cardKey -> grade (this session)
  autoplayTimer: null,   // pending autoplay timeout — cancelled on every re-render
  gradeTimer: null,      // pending 220ms grade-advance — blocks re-entry, cancelled on nav
  audioManifest: null,   // { cardText: "file.mp3" }
  audioEl: null,         // shared HTMLAudioElement
  audioPlaying: false,   // true only while a REAL clip/TTS is playing
  audioUnlocked: false,  // true once the element has been blessed by a user gesture
  settings: loadSettings(),
  progress: loadProgress(),
  searchIndex: null,     // built once after data loads
  writer: null,          // active Hanzi Writer instance
  writerChar: null,      // currently loaded char
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return Object.assign(defaultSettings(), JSON.parse(raw));
  } catch (e) {}
  return defaultSettings();
}
function defaultSettings() {
  return { theme: 'auto', front: 'zh', size: 'l', reduceMotion: false, autoplay: true };
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}
function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { lessons: {}, lastStudyDate: null, streak: 0 };
}
function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
}

/* ---------------------- bootstrap ---------------------- */
async function init() {
  applySettings();

  try {
    const r = await fetch('data/lessons.json');
    if (!r.ok) throw new Error('Could not load lessons');
    state.data = await r.json();
  } catch (e) {
    console.error(e);
    document.body.innerHTML = '<main style="padding:48px;text-align:center;font-family:system-ui">Could not load <code>data/lessons.json</code>.<br>Serve this folder over http (e.g. <code>python3 -m http.server 8000</code>) — opening index.html via file:// blocks fetch().</main>';
    return;
  }

  // Audio manifest is optional — the app still works (browser TTS) without it.
  try {
    const ar = await fetch('assets/audio/manifest.json');
    if (ar.ok) state.audioManifest = await ar.json();
  } catch (e) { state.audioManifest = null; }

  bindGlobalEvents();
  bindSettingsDialog();
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);
  // (streak bumps from grade() — studying counts, opening the page doesn't)
}

// Local-timezone calendar date (the audience is UTC+8 — UTC days would
// roll a late-evening session into "tomorrow").
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Called from grade() — a streak day is a day you actually studied,
// not a day you merely opened the page.
function bumpStreak() {
  const today = localDateStr();
  if (state.progress.lastStudyDate !== today) {
    const y = localDateStr(new Date(Date.now() - 86_400_000));
    if (state.progress.lastStudyDate === y) state.progress.streak = (state.progress.streak || 0) + 1;
    else state.progress.streak = 1;
    state.progress.lastStudyDate = today;
    saveProgress();
  }
}

/* ---------------------- router ---------------------- */
function routeFromHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);

  // The skip link sets #main — hand it focus, don't treat it as a route.
  if (parts.length === 1 && parts[0] === 'main') {
    const main = document.getElementById('main');
    if (main) main.focus();
    return;
  }

  $$('.view').forEach((v) => v.hidden = true);
  stopAudio();   // a navigation should always silence the previous card
  if (state.gradeTimer) { clearTimeout(state.gradeTimer); state.gradeTimer = null; }

  if (parts.length === 0) {
    state.view = 'home';
    $('#view-home').hidden = false;
    renderHome();
  } else if (parts[0] === 'lesson' && parts[1]) {
    state.view = 'lesson';
    state.lessonId = +parts[1];
    state.queueType = null;
    $('#view-lesson').hidden = false;
    renderLesson();
  } else if (parts[0] === 'study' && parts[1] && parts[2]) {
    state.view = 'study';
    state.lessonId = +parts[1];
    // Legacy URLs for the removed modes redirect to vocab
    const m = parts[2];
    state.mode = (m === 'listen' || m === 'quiz') ? 'vocab' : m;
    state.queueType = null;
    if (state.mode !== m) { location.hash = `#/study/${parts[1]}/${state.mode}`; return; }
    // Optional 4th segment: a card index to deep-link to (from search).
    state.pendingIndex = parts[3] !== undefined ? parseInt(parts[3], 10) : null;
    $('#view-study').hidden = false;
    startStudy();
  } else if (parts[0] === 'queue' && parts[1]) {
    state.view = 'study';
    state.lessonId = null;
    state.queueType = parts[1];
    state.mode = 'queue';
    state.pendingIndex = null;
    $('#view-study').hidden = false;
    startStudy();
  } else {
    location.hash = '#/';
  }
  window.scrollTo(0, 0);
  closeSearch();
}

/* ---------------------- home view ---------------------- */
function renderHome() {
  // Update lede with REAL totals from the data file (not hardcoded numbers).
  const lede = $('#heroLede');
  if (lede && state.data.meta) {
    const m = state.data.meta;
    lede.textContent = `${m.vocab_total} words, ${m.sentence_total} example sentences, and ${m.character_total} characters from the Level 1 Integrated Textbook, organised by lesson. Front shows Chinese — flip for pinyin and English.`;
  }

  // Stats
  const stats = computeOverallStats();
  $('#statSeen').textContent  = stats.seen;
  $('#statKnown').textContent = stats.known;
  $('#statStreak').textContent = state.progress.streak || 0;

  // Quick-start chip counts
  const due  = dueCards(999).length;
  const weak = weakCards(999).length;
  $('#qsDueCount').textContent  = due;
  $('#qsWeakCount').textContent = weak;
  const qsDue  = $('#qsDue');  if (qsDue)  qsDue.classList.toggle('is-empty', due  === 0);
  const qsWeak = $('#qsWeak'); if (qsWeak) qsWeak.classList.toggle('is-empty', weak === 0);

  // Lesson grid
  const grid = $('#lessonGrid');
  grid.innerHTML = state.data.lessons.map((L) => {
    const p = lessonProgress(L.id);
    // Denominator must match what can be graded: vocab + sentences + characters.
    const totalCards = L.vocab.length + (L.sentences?.length || 0) + (L.characters?.length || 0);
    const pct = totalCards ? Math.min(100, Math.round((p.known / totalCards) * 100)) : 0;
    return html`
      <li>
        <a href="#/lesson/${L.id}" class="lesson-card" aria-label="Lesson ${L.id}: ${escapeHTML(L.title_en)}">
          <span class="lesson-card__num">第 ${L.id} 课 · Lesson ${L.id}</span>
          <h3 class="lesson-card__zh">${escapeHTML(L.title_zh)}</h3>
          <p class="lesson-card__pinyin">${escapeHTML(L.title_pinyin)}</p>
          <p class="lesson-card__en">${escapeHTML(L.title_en)}</p>
          <span class="lesson-card__meta">
            <span><strong>${L.vocab.length}</strong> words</span>
            <span aria-hidden="true">·</span>
            <span><strong>${L.sentences?.length || 0}</strong> sentences</span>
            <span aria-hidden="true">·</span>
            <span><strong>${pct}%</strong> learned</span>
          </span>
          <span class="lesson-card__progress" aria-hidden="true"><i style="width:${pct}%"></i></span>
        </a>
      </li>
    `;
  }).join('');
}

function computeOverallStats() {
  let seen = 0, known = 0;
  for (const L of state.data.lessons) {
    const p = lessonProgress(L.id);
    seen += p.seen;
    known += p.known;
  }
  return { seen, known };
}

function lessonProgress(id) {
  const lp = state.progress.lessons[id] || {};
  const seen = Object.keys(lp).length;
  const known = Object.values(lp).filter((rec) => {
    const g = typeof rec === 'string' ? rec : rec.g;
    return g === 'good' || g === 'easy';
  }).length;
  return { seen, known };
}

/* ---------------------- SRS (very simple SM-2-ish) ---------------------- */
const DAY = 24 * 60 * 60 * 1000;
function srsRecord(cardKey, lessonId) {
  const lp = state.progress.lessons[lessonId] || {};
  const r = lp[cardKey];
  if (!r) return { g: null, ivl: 0, ease: 2.5, reps: 0, due: 0 };
  if (typeof r === 'string') return { g: r, ivl: 0, ease: 2.5, reps: 0, due: 0 };
  return Object.assign({ g: null, ivl: 0, ease: 2.5, reps: 0, due: 0 }, r);
}
function srsApply(prev, grade) {
  const now = Date.now();
  let { ivl, ease, reps } = prev;
  if (grade === 'again') {
    ivl = 0;                                  // see again very soon
    ease = Math.max(1.3, ease - 0.2);
    reps = 0;
  } else if (grade === 'hard') {
    ivl = Math.max(1, Math.round((ivl || 1) * 1.2));
    ease = Math.max(1.3, ease - 0.15);
    reps = (reps || 0) + 1;
  } else if (grade === 'good') {
    ivl = reps < 1 ? 1 : reps < 2 ? 3 : Math.round((ivl || 1) * ease);
    reps = (reps || 0) + 1;
  } else if (grade === 'easy') {
    ivl = reps < 1 ? 3 : Math.round((ivl || 2) * ease * 1.3);
    ease = ease + 0.15;
    reps = (reps || 0) + 1;
  }
  ivl = Math.min(ivl, 365);                    // cap
  const due = grade === 'again' ? now + 60_000 : now + ivl * DAY;
  return { g: grade, ivl, ease, reps, due };
}
function allCardsFlat() {
  // Lazy: build once. Includes vocab + sentences + characters.
  if (state._flat) return state._flat;
  const flat = [];
  for (const L of state.data.lessons) {
    for (let i = 0; i < L.vocab.length; i++) {
      const v = L.vocab[i];
      flat.push({
        lessonId: L.id, lessonTitle: L.title_zh, type: 'vocab',
        key: `L${L.id}.v.${i}`,
        front_zh: v.chinese, pinyin: v.pinyin, english: v.english, pos: v.pos || '',
      });
    }
    for (let i = 0; i < (L.sentences || []).length; i++) {
      const s = L.sentences[i];
      flat.push({
        lessonId: L.id, lessonTitle: L.title_zh, type: 'sentence',
        key: `L${L.id}.s.${i}`,
        front_zh: s.chinese, pinyin: s.pinyin, english: s.english, pos: '',
      });
    }
    for (let i = 0; i < (L.characters || []).length; i++) {
      const c = L.characters[i];
      flat.push({
        lessonId: L.id, lessonTitle: L.title_zh, type: 'character',
        key: `L${L.id}.c.${i}`,
        front_zh: c,
        pinyin: (L.char_pinyin || {})[c] || '',
        english: (L.char_gloss || {})[c] || '',
        pos: '',
        compounds: (L.char_compounds || {})[c] || [],
        examples: (L.char_examples || {})[c] || [],
      });
    }
  }
  state._flat = flat;
  return flat;
}
function dueCards(limit = 50) {
  const now = Date.now();
  const all = allCardsFlat();
  const out = [];
  for (const c of all) {
    const r = srsRecord(c.key, c.lessonId);
    if (r.g && r.due && r.due <= now) out.push({ ...c, _due: r.due });
  }
  out.sort((a, b) => a._due - b._due);
  return out.slice(0, limit);
}
function weakCards(limit = 30) {
  const all = allCardsFlat();
  const scored = [];
  for (const c of all) {
    const r = srsRecord(c.key, c.lessonId);
    if (!r.g) continue;
    // weakness = lower ease + recent 'again'/'hard' grades
    const penalty = r.g === 'again' ? 2 : r.g === 'hard' ? 1 : 0;
    const score = penalty - r.ease;
    if (penalty > 0 || r.ease < 2.3) scored.push({ ...c, _score: score });
  }
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit);
}
function randomCards(n = 20) {
  const all = allCardsFlat();
  const picks = [];
  const used = new Set();
  while (picks.length < n && picks.length < all.length) {
    const i = Math.floor(Math.random() * all.length);
    if (!used.has(i)) { used.add(i); picks.push(all[i]); }
  }
  return picks;
}

/* ---------------------- lesson view ---------------------- */
function renderLesson() {
  const L = state.data.lessons.find((x) => x.id === state.lessonId);
  if (!L) { location.hash = '#/'; return; }

  $('#lessonNum').textContent      = `第 ${L.id} 课 · Lesson ${L.id}`;
  $('#lessonTitle').textContent    = L.title_zh;
  $('#lessonPinyin').textContent   = L.title_pinyin;
  $('#lessonEnglish').textContent  = L.title_en;

  $('#cntVocab').textContent       = L.vocab.length;
  $('#cntSentences').textContent   = L.sentences?.length || 0;
  $('#cntChars').textContent       = L.characters?.length || 0;

  // hook mode cards
  $$('.mode-card').forEach((el) => {
    const m = el.dataset.mode;
    el.href = `#/study/${L.id}/${m}`;
  });

  // vocab table
  const tbl = $('#vocabTable');
  tbl.innerHTML = L.vocab.map((v) => html`
    <div class="vocab-row" role="listitem">
      <span class="vocab-row__zh">${escapeHTML(v.chinese)}</span>
      <span class="vocab-row__py">${escapeHTML(v.pinyin)}</span>
      <span class="vocab-row__pos">${escapeHTML(v.pos || '')}</span>
      <span class="vocab-row__en">${escapeHTML(v.english)}</span>
    </div>
  `).join('');
}

/* ---------------------- study view ---------------------- */
function startStudy() {
  let backHref = '#/';
  let label = '';
  if (state.queueType) {
    state.deck = buildQueueDeck(state.queueType);
    label = queueLabel(state.queueType);
    $('#studyLessonLabel').textContent = label;
    $('#studyModeLabel').textContent = `${state.deck.length} cards across all lessons`;
  } else {
    const L = state.data.lessons.find((x) => x.id === state.lessonId);
    if (!L) { location.hash = '#/'; return; }
    state.deck = buildDeck(L, state.mode);
    backHref = `#/lesson/${L.id}`;
    $('#studyLessonLabel').textContent = `Lesson ${L.id} · ${L.title_zh}`;
    $('#studyModeLabel').textContent = modeLabel(state.mode);
  }
  // Deep link (from search): remember WHICH card before any shuffle,
  // then locate it again afterwards by key.
  let targetKey = null;
  if (state.pendingIndex != null && state.deck[state.pendingIndex]) {
    targetKey = state.deck[state.pendingIndex].key;
  }
  state.pendingIndex = null;

  if (state.shuffled) shuffleInPlace(state.deck);

  $('#studyBack').href = backHref;
  $('#finishedBack').href = backHref;
  $('#studyTotal').textContent = state.deck.length;

  // "Again" requeues grow the deck; progress is measured against the
  // unique card count captured here.
  if (state.gradeTimer) { clearTimeout(state.gradeTimer); state.gradeTimer = null; }
  state.totalUnique = state.deck.length;
  state.index = targetKey ? Math.max(0, state.deck.findIndex((c) => c.key === targetKey)) : 0;
  state.flipped = false;
  state.finished = false;
  state.reviewed.clear();
  state.grades = {};

  renderCard();
}
function modeLabel(m) {
  return ({
    vocab: 'Vocabulary',
    sentences: 'Sentences',
    characters: 'Characters · 读写字',
    test: 'Test · 测验',
  })[m] || m;
}
function queueLabel(t) {
  return ({ due: 'Due today', weak: 'Weakest cards', random: 'Random mix' })[t] || 'Queue';
}
function buildQueueDeck(type) {
  let cards = [];
  if (type === 'due')    cards = dueCards(60);
  if (type === 'weak')   cards = weakCards(30);
  if (type === 'random') cards = randomCards(20);
  // Cards already match the shape we use; ensure key + type fields are set.
  return cards.map((c) => ({ ...c }));
}
function buildDeck(L, mode) {
  if (mode === 'vocab') {
    return L.vocab.map((v, i) => ({
      key: `L${L.id}.v.${i}`,
      type: 'vocab',
      front_zh: v.chinese,
      pinyin: v.pinyin,
      english: v.english,
      pos: v.pos || '',
    }));
  }
  if (mode === 'sentences') {
    return (L.sentences || []).map((s, i) => ({
      key: `L${L.id}.s.${i}`,
      type: 'sentence',
      front_zh: s.chinese,
      pinyin: s.pinyin,
      english: s.english,
      pos: '',
    }));
  }
  if (mode === 'characters') {
    const compounds = L.char_compounds || {};
    const examples  = L.char_examples  || {};
    const charPy    = L.char_pinyin    || {};
    const charGloss = L.char_gloss     || {};
    return (L.characters || []).map((c, i) => {
      const comps = compounds[c] || [];
      const exs   = examples[c]  || [];
      return {
        key: `L${L.id}.c.${i}`,
        type: 'character',
        lessonId: L.id,
        front_zh: c,
        pinyin: charPy[c] || '',
        english: charGloss[c] || '',
        pos: '',
        compounds: comps,
        examples: exs,
      };
    });
  }
  // Test mode: active recall. Vocab → read the hanzi, type the pinyin.
  // Characters → see pinyin+meaning, write the hanzi from memory.
  if (mode === 'test') {
    return [...buildDeck(L, 'vocab'), ...buildDeck(L, 'characters')];
  }
  return [];
}

function renderCard() {
  $('#finished').hidden = true;
  $('#cardStage').style.display = '';
  $('.action-row').style.display = '';
  $('.navrow').style.display = '';
  if (state.autoplayTimer) { clearTimeout(state.autoplayTimer); state.autoplayTimer = null; }

  if (state.deck.length === 0) {
    // Hide controls that can't do anything on an empty deck.
    $('.action-row').style.display = 'none';
    $('.navrow').style.display = 'none';
    const ar = $('.audio-row'); if (ar) ar.style.display = 'none';
    // Reset flip state so the message lands on the VISIBLE front face
    // (a stale .is-flipped from the previous deck would hide it).
    const cardEl = $('#card');
    cardEl.classList.remove('is-flipped', 'is-marked-again', 'is-marked-good');
    cardEl.setAttribute('aria-pressed', 'false');
    state.flipped = false;
    setFaceVisibility();
    const msg = state.queueType === 'due'
      ? 'Nothing due right now — grade some cards in a lesson first, then come back later.'
      : state.queueType === 'weak'
        ? 'No weak cards yet — they appear after you mark cards Again or Hard.'
        : 'This mode has no cards in this lesson yet.';
    const zh = $('#cardChinese');
    zh.textContent = '—';
    zh.setAttribute('lang', 'en');
    $('#cardHint').textContent = msg;          // front face → actually visible
    $('#cardPinyin').textContent = '';
    $('#cardEnglish').textContent = msg;       // back face copy for completeness
    $('#cardPos').textContent = '';
    $('#studyPos').textContent = 0;
    $('#progressBar').style.width = '0%';
    announce(msg);
    return;
  }
  const ar = $('.audio-row'); if (ar) ar.style.display = '';

  stopAudio();   // never let a previous clip bleed into the next card

  const card = state.deck[state.index];
  const cardEl = $('#card');
  cardEl.classList.remove(
    'is-flipped', 'is-marked-again', 'is-marked-good',
    'card--sentence', 'card--character',
    'card--front-en',
    'card--size-m', 'card--size-l', 'card--size-xl'
  );
  cardEl.classList.add(`card--size-${state.settings.size}`);
  if (card.type === 'character') {
    cardEl.classList.add('card--character');
  } else if (card.type === 'sentence' || (card.type === 'vocab' && card.front_zh.length > 4)) {
    cardEl.classList.add('card--sentence');
  }
  cardEl.setAttribute('aria-pressed', 'false');
  state.flipped = false;
  setFaceVisibility();
  $('#cardHint').textContent = 'Tap card or press Space to flip';

  const zhEl = $('#cardChinese');
  const frontPy = $('#cardFrontPy');
  // "Chinese + pinyin" beginner mode: pinyin scaffold on the FRONT face.
  const showFrontPinyin = state.settings.front === 'zhpy';
  if (frontPy) {
    if (showFrontPinyin && card.pinyin) { frontPy.textContent = card.pinyin; frontPy.hidden = false; }
    else { frontPy.textContent = ''; frontPy.hidden = true; }
  }

  const isTest = state.mode === 'test';
  cardEl.classList.toggle('card--test', isTest);
  if (isTest) {
    renderTestPrompt(card, zhEl);
  } else if (card.type === 'character') {
    zhEl.textContent = card.front_zh;
    zhEl.setAttribute('lang', 'zh-CN');
    $('#cardPinyin').textContent  = card.pinyin || '';
    $('#cardEnglish').innerHTML   = renderCharBack(card);
    $('#cardPos').textContent = '读写字';
  } else {
    // 'zh' and 'zhpy' both show Chinese first; only 'en' inverts.
    const englishFront = state.settings.front === 'en';
    if (!englishFront) {
      zhEl.textContent = card.front_zh;
      zhEl.setAttribute('lang', 'zh-CN');
      $('#cardPinyin').textContent  = card.pinyin || '';
      // Single-hanzi vocab gets a stroke-order practice button too.
      if (card.type === 'vocab' && SINGLE_HANZI.test(card.front_zh)) {
        $('#cardEnglish').innerHTML = `<div class="vocab-back__en">${escapeHTML(card.english || '')}</div>` +
          writeBtnHTML(card.front_zh, card.pinyin, card.english);
      } else {
        $('#cardEnglish').textContent = card.english || '';
      }
      $('#cardEnglish').removeAttribute('lang');
    } else {
      cardEl.classList.add('card--front-en');
      zhEl.textContent = card.english || '—';
      zhEl.setAttribute('lang', 'en');
      $('#cardPinyin').textContent  = card.pinyin || '';
      $('#cardEnglish').textContent = card.front_zh;
      $('#cardEnglish').setAttribute('lang', 'zh-CN');
    }
    $('#cardPos').textContent = card.pos || '';
  }

  $('#studyPos').textContent = state.index + 1;
  $('#studyTotal').textContent = state.deck.length;
  const pct = Math.min(100, (state.reviewed.size / (state.totalUnique || state.deck.length)) * 100);
  $('#progressBar').style.width = pct + '%';
  const pb = $('.progress');
  if (pb) pb.setAttribute('aria-valuenow', String(Math.round(pct)));

  // Announce the new card to screen readers (the visual content swap is
  // otherwise silent).
  announce(`Card ${state.index + 1} of ${state.deck.length}`);

  // Audio button is always available — Chinese is always speakable.
  const ab = $('#audioBtn');
  if (ab) ab.disabled = false;
  setAudioBtnState(false);

  // Test mode: gate the answer behind active production; no autoplay (it
  // would leak the answer). For vocab the audio button stays usable as a
  // listening-dictation aid, by choice.
  if (isTest) {
    setupTestCard(card);
    return;
  }
  hideTestPanel();

  // Auto-play this card's pronunciation (silent unlock pattern means
  // this will succeed on every browser as long as the user has tapped
  // anywhere on the page at least once — which they always have by
  // the time they land on a card).
  autoplayIfReady();
}

/* ---------------------- test / dictation mode ---------------------- */

// The card never flips in test mode, so the prompt lives entirely on the
// FRONT face (#cardChinese big + #cardFrontPy + #cardHint). Vocab → show the
// hanzi (read it, type the pinyin). Character → show pinyin + meaning, the
// hanzi hidden behind a "？" (write it from memory).
function renderTestPrompt(card, zhEl) {
  const fp = $('#cardFrontPy');
  // Back face is unused in test mode — clear it.
  $('#cardPinyin').textContent = '';
  $('#cardEnglish').textContent = '';
  $('#cardEnglish').removeAttribute('lang');
  $('#cardPos').textContent = '';
  if (card.type === 'character') {
    zhEl.textContent = '？';
    zhEl.setAttribute('lang', 'en');
    if (fp) { fp.textContent = card.pinyin || ''; fp.hidden = !card.pinyin; }
    $('#cardHint').textContent = (card.english ? card.english + ' — ' : '') + 'write this character from memory';
  } else {
    zhEl.textContent = card.front_zh;
    zhEl.setAttribute('lang', 'zh-CN');
    if (fp) { fp.textContent = ''; fp.hidden = true; }
    $('#cardHint').textContent = 'Type the pinyin, then Check';
  }
}

function hideTestPanel() {
  const p = $('#testPanel');
  if (p) p.hidden = true;
}

// Prepare the prompt-and-answer UI for the current test card.
function setupTestCard(card) {
  state.testAnswered = false;
  const panel = $('#testPanel'); if (!panel) return;
  panel.hidden = false;
  const inputRow = $('#testInputRow');
  const writeBtn = $('#testWriteBtn');
  const result = $('#testResult');
  const input = $('#testInput');
  result.hidden = true; result.textContent = ''; result.className = 'test-result';
  // Gate grading until the learner has produced an answer.
  $('.action-row').style.display = 'none';

  if (card.type === 'character') {
    inputRow.hidden = true;
    writeBtn.hidden = false;
    writeBtn.textContent = '✍︎ Write it from memory';
  } else {
    writeBtn.hidden = true;
    inputRow.hidden = false;
    input.value = '';
    input.disabled = false;
    // focus after the render settles (mobile keyboards need a real gesture,
    // so this is best-effort and harmless if it no-ops).
    setTimeout(() => { try { input.focus(); } catch (e) {} }, 50);
  }
}

// Check a typed-pinyin answer against the card. Tone-insensitive match counts
// as correct; we still tell the learner whether their tones were exact.
function checkPinyinAnswer() {
  if (state.mode !== 'test' || state.testAnswered) return;
  const card = state.deck[state.index];
  if (!card || card.type === 'character') return;
  const input = $('#testInput');
  const guess = (input.value || '').trim();
  if (!guess) return;
  const want = card.pinyin || '';
  const normGuess = normPinyin(guess).replace(/\s+/g, '');
  const normWant  = normPinyin(want).replace(/\s+/g, '');
  // tone-number input (ni3 hao3) → strip digits for the toneless compare
  const normGuessNoNum = normGuess.replace(/[0-9]/g, '');
  const correct = normGuessNoNum === normWant && normWant.length > 0;
  revealTestAnswer(card, correct, want);
}

// Reveal the answer on the card and show the verdict, then open grading.
function revealTestAnswer(card, correct, answerText) {
  state.testAnswered = true;
  const result = $('#testResult');
  const input = $('#testInput');
  const fp = $('#cardFrontPy');
  if (input) input.disabled = true;
  // Fill the answer in on the FRONT face (the card never flips in test mode).
  if (card.type === 'character') {
    $('#cardChinese').textContent = card.front_zh;
    $('#cardChinese').setAttribute('lang', 'zh-CN');
  }
  if (fp) { fp.textContent = card.pinyin || ''; fp.hidden = !card.pinyin; }
  $('#cardHint').textContent = card.english || '';
  if (result) {
    result.hidden = false;
    result.className = 'test-result ' + (correct ? 'is-correct' : 'is-wrong');
    result.innerHTML = correct
      ? `<span class="test-result__mark">✓</span> Correct — <b>${escapeHTML(answerText)}</b>`
      : `<span class="test-result__mark">✗</span> Answer: <b>${escapeHTML(answerText)}</b>`;
  }
  // Pre-grade hint: correct → Good is the obvious press; wrong → Again.
  $('.action-row').style.display = '';
  announce(correct ? 'Correct' : `Incorrect. Answer ${answerText}`);
  // Let them hear it now.
  if (state.settings.autoplay) playCardAudio({ quiet: true });
}

// Keep the visually-hidden face out of the accessibility tree —
// backface-visibility hides pixels, not content.
function setFaceVisibility() {
  const front = $('#cardFront');
  const back  = $('#cardBack');
  if (!front || !back) return;
  front.setAttribute('aria-hidden', String(state.flipped));
  back.setAttribute('aria-hidden', String(!state.flipped));
}

// Single polite live region for app announcements.
function announce(msg) {
  const el = $('#srAnnounce');
  if (el) el.textContent = msg;
}

/* ---------------------- audio (hybrid) ---------------------- */

// One reusable <audio> element. The first user gesture anywhere
// "unlocks" it (plays a silent WAV), after which programmatic .play()
// calls — like autoplay on each card render — are allowed by iOS
// Safari and mobile Chrome for the rest of the session.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function getAudioEl() {
  if (!state.audioEl) {
    state.audioEl = new Audio();
    state.audioEl.preload = 'auto';
  }
  return state.audioEl;
}

function unlockAudio() {
  if (state.audioUnlocked) return;
  state.audioUnlocked = true;
  const a = getAudioEl();
  try {
    a.muted = true;
    a.src = SILENT_WAV;
    const p = a.play();
    if (p && p.then) {
      p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; })
       .catch(() => { a.muted = false; });
    } else { a.pause(); a.muted = false; }
  } catch (e) { a.muted = false; }
}

function currentSpeakText() {
  const card = state.deck[state.index];
  if (!card) return '';
  // Always speak the Chinese, even in inverted (English-front) mode.
  return card.front_zh || '';
}

function setAudioBtnState(playing) {
  const ab = $('#audioBtn');
  if (!ab) return;
  ab.classList.remove('is-error');
  ab.classList.toggle('is-playing', !!playing);
  ab.setAttribute('aria-label', playing ? 'Stop audio' : 'Play pronunciation');
  const lbl = $('#audioLabel');
  if (lbl) lbl.textContent = playing ? 'Playing — tap to stop' : 'Play pronunciation';
}

let _audioErrTimer = null;
function flashAudioUnavailable() {
  const ab = $('#audioBtn');
  const lbl = $('#audioLabel');
  if (!ab || !lbl) return;
  state.audioPlaying = false;
  ab.classList.remove('is-playing');
  ab.classList.add('is-error');
  lbl.textContent = 'Audio unavailable here';
  clearTimeout(_audioErrTimer);
  _audioErrTimer = setTimeout(() => {
    ab.classList.remove('is-error');
    lbl.textContent = 'Play pronunciation';
  }, 2000);
}

function stopAudio() {
  if (state.autoplayTimer) { clearTimeout(state.autoplayTimer); state.autoplayTimer = null; }
  state.audioPlaying = false;
  if (state.audioEl) { state.audioEl.pause(); state.audioEl.currentTime = 0; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  setAudioBtnState(false);
}

function speakFallback(text) {
  if (!('speechSynthesis' in window) || !text) { flashAudioUnavailable(); return; }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.9;
    const v = window.speechSynthesis.getVoices()
      .find((x) => /zh(-|_)?CN/i.test(x.lang) || /Chinese/i.test(x.name));
    if (v) u.voice = v;
    let started = false;
    u.onstart = () => { started = true; };
    u.onend = () => { state.audioPlaying = false; setAudioBtnState(false); };
    u.onerror = () => { state.audioPlaying = false; flashAudioUnavailable(); };
    state.audioPlaying = true;
    setAudioBtnState(true);
    window.speechSynthesis.speak(u);
    // If nothing actually started (no usable voice), tell the user.
    setTimeout(() => {
      if (!started && !window.speechSynthesis.speaking) {
        state.audioPlaying = false;
        flashAudioUnavailable();
      }
    }, 700);
  } catch (e) { state.audioPlaying = false; flashAudioUnavailable(); }
}

function playCardAudio(opts = {}) {
  const quiet = !!opts.quiet;       // autoplay: never flash "unavailable"
  const text = currentSpeakText();
  if (!text) return;

  // Press again while playing → stop (toggle). Skip for autoplay.
  if (state.audioPlaying && !quiet) { stopAudio(); return; }
  if (state.audioPlaying && quiet)  { stopAudio(); }    // make room for new clip

  const file = state.audioManifest && state.audioManifest[text];
  if (file) {
    const a = getAudioEl();
    a.src = `assets/audio/${file}`;
    a.onended = () => { state.audioPlaying = false; setAudioBtnState(false); };
    a.onerror = () => {
      state.audioPlaying = false;
      if (quiet) setAudioBtnState(false); else speakFallback(text);
    };
    state.audioPlaying = true;
    setAudioBtnState(true);
    const p = a.play();
    if (p && p.catch) p.catch(() => {
      state.audioPlaying = false;
      setAudioBtnState(false);
      if (!quiet) speakFallback(text);
    });
  } else if (!quiet) {
    speakFallback(text);                            // no pre-gen clip → TTS (manual only)
  }
}

function autoplayIfReady() {
  if (!state.settings.autoplay) return;
  if (!state.audioUnlocked) return;          // first gesture hasn't happened yet
  if (!state.deck.length) return;
  // English-front mode: the Chinese is the ANSWER — autoplaying it on
  // render would leak it. flipCard() speaks it on reveal instead.
  // (Character cards always show hanzi on the front, so they still play.)
  const card = state.deck[state.index];
  if (state.settings.front === 'en' && card && card.type !== 'character') return;
  // tiny delay so the flip-reset visual settles before sound starts —
  // tracked so rapid navigation can cancel a stale play.
  state.autoplayTimer = setTimeout(() => {
    state.autoplayTimer = null;
    playCardAudio({ quiet: true });
  }, 60);
}

function renderCharBack(card) {
  // pinyin is already rendered in #cardPinyin — don't duplicate it here
  const compounds = (card.compounds || []).slice(0, 4);
  const examples  = (card.examples  || []).slice(0, 2);

  // Primary: the character's own English meaning.
  let html = card.english
    ? `<div class="char-back__meaning">${escapeHTML(card.english)}</div>`
    : '';

  if (compounds.length) {
    html += `<div class="char-back__section">
      <div class="char-back__label">Appears in</div>
      <ul class="char-back__list">${compounds.map((c) => `
        <li>
          <span class="char-back__zh">${escapeHTML(c.word)}</span>
          <span class="char-back__alt">${escapeHTML(c.pinyin)} — ${escapeHTML(c.english)}</span>
        </li>`).join('')}
      </ul>
    </div>`;
  }

  if (examples.length && !compounds.length) {
    // Only show examples when there are no compounds, to keep the card tidy.
    html += `<div class="char-back__section">
      <div class="char-back__label">In context</div>
      <ul class="char-back__list">${examples.map((e) => `
        <li>
          <span class="char-back__zh">${escapeHTML(e.sentence)}</span>
          <span class="char-back__alt">${escapeHTML(e.english)}</span>
        </li>`).join('')}
      </ul>
    </div>`;
  }

  if (!compounds.length && !examples.length) {
    html += `<div class="char-back__section char-back__section--empty">
      <em>读写字 — introduced here for reading &amp; writing practice.</em>
    </div>`;
  }
  // Practice-writing button for single characters (Hanzi Writer)
  html += writeBtnHTML(card.front_zh, card.pinyin, card.english);
  return html;
}

// Reusable "Practice writing" button — works for character cards AND for
// single-hanzi vocab cards (so 你/我/他/她 etc. are traceable too).
function writeBtnHTML(ch, py, en) {
  return `<div class="char-back__write">
    <button type="button" class="btn btn--ghost char-back__writebtn"
            data-write-char="${escapeHTML(ch)}"
            data-write-py="${escapeHTML(py || '')}"
            data-write-en="${escapeHTML(en || '')}">
      ✍︎ Practice writing
    </button>
  </div>`;
}

// A single CJK character (used to decide whether a vocab card is traceable).
const SINGLE_HANZI = /^[一-鿿]$/;

/* ---------------------- pinyin normalisation ---------------------- */

// Strip tone marks (and "ü"→"u") + lowercase + collapse spaces.
function normPinyin(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')           // diacritics
    .replace(/ü|ü/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')                // punctuation/ellipsis → space
    .trim();
}

/* ---------------------- Hanzi Writer ---------------------- */

function openWriter(ch, py, en) {
  const dlg = $('#writerDialog');
  if (!dlg) return;
  // A blind challenge may have hidden these — restore for normal practice.
  const ab = $('#writerAnimate'); if (ab) ab.style.display = '';
  const qb = $('#writerQuiz');    if (qb) qb.style.display = '';
  $('#writerChar').textContent = ch;
  $('#writerSubtitle').textContent = [py, en].filter(Boolean).join(' · ');
  $('#writerStatus').textContent = 'Tap Show strokes to watch, or Trace to practice.';
  const stage = $('#writerStage');
  stage.innerHTML = '';
  state.writerChar = ch;
  state.writer = null;

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', 'open');

  // Defer instantiation slightly so the modal sizes correctly first.
  setTimeout(() => initWriter(ch), 80);
}
function initWriter(ch) {
  if (!window.HanziWriter) {
    $('#writerStatus').textContent = 'Loading stroke-order library…';
    // Retry after the CDN script loads
    let tries = 0;
    const iv = setInterval(() => {
      if (window.HanziWriter) { clearInterval(iv); initWriter(ch); }
      else if (++tries > 30) { clearInterval(iv); $('#writerStatus').textContent = 'Could not load stroke data. Check your connection.'; }
    }, 200);
    return;
  }
  // Hanzi Writer accepts colors as literal SVG values — CSS vars don't work
  // inside SVG fill/stroke attributes, so use concrete colors.
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (document.documentElement.getAttribute('data-theme') !== 'light'
        && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  try {
    state.writer = window.HanziWriter.create('writerStage', ch, {
      width: 280,
      height: 280,
      padding: 12,
      showOutline: true,
      showCharacter: true,
      strokeAnimationSpeed: 1,
      delayBetweenStrokes: 120,
      drawingWidth: 30,
      strokeColor:    isDark ? '#F0EBDD' : '#1B1A18',
      radicalColor:   '#B43A2E',
      outlineColor:   isDark ? 'rgba(240,235,221,0.25)' : 'rgba(0,0,0,0.18)',
      highlightColor: '#B43A2E',
      drawingColor:   isDark ? '#F0EBDD' : '#1B1A18',
      onLoadCharDataSuccess: () => { $('#writerStatus').textContent = 'Tap Show strokes to watch, or Trace to practice.'; },
      onLoadCharDataError: () => { $('#writerStatus').textContent = `No stroke data for "${ch}" — sorry.`; },
    });
  } catch (e) {
    $('#writerStatus').textContent = 'Could not start writing practice.';
  }
}
function closeWriter() {
  const dlg = $('#writerDialog');
  if (!dlg) return;
  if (state.writer && typeof state.writer.cancelQuiz === 'function') {
    try { state.writer.cancelQuiz(); } catch (e) {}
  }
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
  state.writer = null;
  state.writerChar = null;
  $('#writerStage').innerHTML = '';
  // Restore the watch/trace buttons in case a blind challenge hid them.
  const ab = $('#writerAnimate'); if (ab) ab.style.display = '';
  const qb = $('#writerQuiz');    if (qb) qb.style.display = '';
}

// Test mode: a BLIND writing challenge — no outline, no character shown.
// You must produce the strokes from memory; passing reveals the answer.
function openWriterChallenge(card) {
  const dlg = $('#writerDialog');
  if (!dlg) return;
  const ch = card.front_zh;
  $('#writerChar').textContent = '？';
  $('#writerSubtitle').textContent = [card.pinyin, card.english].filter(Boolean).join(' · ');
  $('#writerStatus').textContent = 'Draw the character stroke by stroke.';
  $('#writerStage').innerHTML = '';
  state.writerChar = ch; state.writer = null;
  const ab = $('#writerAnimate'); if (ab) ab.style.display = 'none';
  const qb = $('#writerQuiz');    if (qb) qb.style.display = 'none';
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', 'open');
  setTimeout(() => startChallenge(ch, card), 80);
}
function startChallenge(ch, card) {
  if (!window.HanziWriter) {
    $('#writerStatus').textContent = 'Loading stroke-order library…';
    let tries = 0;
    const iv = setInterval(() => {
      if (window.HanziWriter) { clearInterval(iv); startChallenge(ch, card); }
      else if (++tries > 30) { clearInterval(iv); $('#writerStatus').textContent = 'Could not load stroke data.'; }
    }, 200);
    return;
  }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (document.documentElement.getAttribute('data-theme') !== 'light'
        && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  try {
    state.writer = window.HanziWriter.create('writerStage', ch, {
      width: 280, height: 280, padding: 12,
      showOutline: false, showCharacter: false, drawingWidth: 30,
      strokeColor:  isDark ? '#F0EBDD' : '#1B1A18',
      radicalColor: '#B43A2E', highlightColor: '#B43A2E',
      drawingColor: isDark ? '#F0EBDD' : '#1B1A18',
      onLoadCharDataError: () => { $('#writerStatus').textContent = `No stroke data for "${ch}".`; },
    });
    state.writer.quiz({
      showHintAfterMisses: 3,
      onMistake: () => { $('#writerStatus').textContent = 'Try that stroke again…'; },
      onCorrectStroke: ({ strokesRemaining }) => {
        $('#writerStatus').textContent = strokesRemaining > 0
          ? `${strokesRemaining} stroke${strokesRemaining === 1 ? '' : 's'} to go.` : 'Last stroke!';
      },
      onComplete: ({ totalMistakes }) => {
        const pass = totalMistakes <= 1;
        $('#writerChar').textContent = ch;
        $('#writerStatus').textContent = pass
          ? '✓ Nicely written! Close to grade it.'
          : `Done — ${totalMistakes} mistakes. Close and mark it Again.`;
        if (!state.testAnswered) revealTestAnswer(card, pass, ch);
      },
    });
  } catch (e) { $('#writerStatus').textContent = 'Could not start the writing challenge.'; }
}

function flipCard() {
  if (!state.deck.length || state.finished) return;
  if (state.mode === 'test') return;   // test mode reveals via Check / Write, not a flip
  state.flipped = !state.flipped;
  const c = $('#card');
  c.classList.toggle('is-flipped', state.flipped);
  c.setAttribute('aria-pressed', String(state.flipped));
  setFaceVisibility();

  if (state.flipped) {
    // Announce the revealed answer to screen readers.
    const py = $('#cardPinyin').textContent;
    const en = $('#cardEnglish').textContent;
    announce(`${py}. ${en}`.slice(0, 200));
    // In English-front mode the Chinese is the ANSWER — speak it only now.
    const card = state.deck[state.index];
    if (state.settings.autoplay && state.settings.front === 'en' &&
        card && card.type !== 'character') {
      playCardAudio({ quiet: true });
    }
  }
}

function grade(g) {
  if (!state.deck.length || state.finished) return;
  // Re-entry guard: ignore grades while the 220ms advance is pending
  // (double-click / held key would otherwise grade the same card twice
  // and splice duplicate "again" copies).
  if (state.gradeTimer) return;

  // Can't grade a card you haven't seen the answer to — first press flips.
  if (!state.flipped) { flipCard(); return; }

  const card = state.deck[state.index];
  state.grades[card.key] = g;

  // "Again" = the card comes back a few positions later THIS session.
  // It doesn't count as reviewed until it earns a passing grade.
  if (g === 'again') {
    const reinsertAt = Math.min(state.index + 1 + 4, state.deck.length);
    state.deck.splice(reinsertAt, 0, { ...card });
    $('#studyTotal').textContent = state.deck.length;
  } else {
    state.reviewed.add(card.key);
  }

  // Persist with SRS schedule. Cards from cross-lesson queues carry their
  // own lessonId; in normal study we fall back to state.lessonId.
  // Same-day guard: a non-"again" regrade of a card that's not due yet
  // (re-studying a lesson you crammed an hour ago) must NOT compound the
  // interval — keep the existing schedule and only let "again" reset it.
  const lessonId = card.lessonId || state.lessonId;
  if (lessonId != null) {
    const lp = state.progress.lessons[lessonId] || {};
    const prev = srsRecord(card.key, lessonId);
    // "Not yet due" guard stops same-day cramming from compounding the
    // interval — but a lapsed ('again') record must always accept its
    // recovery grade, even within the 60s relearn window.
    const notYetDue = prev.g && prev.g !== 'again' && prev.due && prev.due > Date.now();
    if (g === 'again' || !notYetDue) {
      lp[card.key] = srsApply(prev, g);
    }
    state.progress.lessons[lessonId] = lp;
    saveProgress();
    state._flat = null;          // invalidate flat cache (counts may change)
  }

  bumpStreak();                  // a streak day = a day with at least one grade

  const cEl = $('#card');
  if (g === 'again') cEl.classList.add('is-marked-again');
  if (g === 'good' || g === 'easy') cEl.classList.add('is-marked-good');

  state.gradeTimer = setTimeout(() => {
    state.gradeTimer = null;
    nextCard(/*afterGrade=*/true);
  }, 220);
}

function nextCard(afterGrade) {
  if (!state.deck.length || state.finished) return;
  // Completion check FIRST, at any position — grading the last
  // unreviewed card mid-deck (after skips/loop-backs) must finish too.
  if (afterGrade && state.reviewed.size >= state.totalUnique) {
    showFinished();
    return;
  }
  if (state.index < state.deck.length - 1) {
    state.index++;
    renderCard();
    return;
  }
  // At the end of the deck with manual Next:
  if (state.reviewed.size >= state.totalUnique) {
    showFinished();                  // everything reviewed — never dead-end
    return;
  }
  // Cards were skipped (or requeued) — loop back to the first unreviewed
  // card instead of freezing on the last one.
  const firstUnreviewed = state.deck.findIndex((c) => !state.reviewed.has(c.key));
  if (firstUnreviewed !== -1 && firstUnreviewed !== state.index) {
    state.index = firstUnreviewed;
    renderCard();
  }
}
function prevCard() {
  if (state.finished) return;
  if (state.index > 0) {
    state.index--;
    renderCard();
  }
}

function showFinished() {
  state.finished = true;
  stopAudio();
  const total = state.totalUnique;
  const counts = { good: 0, easy: 0, hard: 0, again: 0 };
  Object.values(state.grades).forEach((g) => { if (g in counts) counts[g]++; });
  $('#cardStage').style.display = 'none';
  $('.action-row').style.display = 'none';
  $('.navrow').style.display = 'none';
  $('#finished').hidden = false;
  $('#finishedStats').textContent =
    `${counts.good + counts.easy} good · ${counts.hard} hard · ${counts.again} lapsed — ${total} cards.`;

  // Offer a focused redo of the cards that gave trouble this session.
  const missedKeys = Object.entries(state.grades)
    .filter(([, g]) => g === 'again' || g === 'hard')
    .map(([k]) => k);
  const redoBtn = $('#finishedRedo');
  if (redoBtn) {
    redoBtn.hidden = missedKeys.length === 0;
    redoBtn.textContent = `Redo ${missedKeys.length} tricky card${missedKeys.length === 1 ? '' : 's'}`;
    redoBtn.dataset.keys = JSON.stringify(missedKeys);
  }

  // Move focus (and the announcement) to the completion heading.
  const ft = $('#finishedTitle');
  if (ft) { ft.setAttribute('tabindex', '-1'); ft.focus(); }
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------------- events ---------------------- */
function bindGlobalEvents() {
  // Unlock audio on the very first user interaction (any kind). Capture
  // phase so it runs even before route changes consume the event.
  const UNLOCK = ['pointerdown', 'touchstart', 'mousedown', 'click', 'keydown'];
  const unlockOnce = () => {
    unlockAudio();
    UNLOCK.forEach((ev) => document.removeEventListener(ev, unlockOnce, true));
  };
  UNLOCK.forEach((ev) => document.addEventListener(ev, unlockOnce, true));

  $('#card').addEventListener('click', flipCard);

  $('#audioBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    playCardAudio();
  });

  // Test mode controls
  const testCheck = $('#testCheck');
  if (testCheck) testCheck.addEventListener('click', (e) => { e.stopPropagation(); checkPinyinAnswer(); });
  const testInput = $('#testInput');
  if (testInput) testInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); checkPinyinAnswer(); }
  });
  const testWriteBtn = $('#testWriteBtn');
  if (testWriteBtn) testWriteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const card = state.deck[state.index];
    if (card) openWriterChallenge(card);
  });

  $('#btnPrev').addEventListener('click', prevCard);
  $('#btnNext').addEventListener('click', () => nextCard(false));

  // Shuffle / restart rebuild the deck via startStudy() — that both
  // restores original order when shuffle turns OFF and purges any
  // requeued "Again" duplicates from the previous run.
  $('#btnShuffle').addEventListener('click', (e) => {
    state.shuffled = !state.shuffled;
    e.currentTarget.setAttribute('aria-pressed', String(state.shuffled));
    if (state.view === 'study') startStudy();
  });

  $('#btnReset').addEventListener('click', () => {
    if (state.view === 'study') startStudy();
  });

  $('#btnAgain').addEventListener('click', () => grade('again'));
  $('#btnHard').addEventListener('click', () => grade('hard'));
  $('#btnGood').addEventListener('click', () => grade('good'));
  $('#btnEasy').addEventListener('click', () => grade('easy'));

  $('#finishedRestart').addEventListener('click', () => {
    if (state.view === 'study') startStudy();
  });

  // Focused redo of this session's Again/Hard cards.
  const redoBtn = $('#finishedRedo');
  if (redoBtn) redoBtn.addEventListener('click', () => {
    let keys = [];
    try { keys = JSON.parse(redoBtn.dataset.keys || '[]'); } catch (e) {}
    const cards = [];
    const seen = new Set();
    for (const c of state.deck) {
      if (keys.includes(c.key) && !seen.has(c.key)) { seen.add(c.key); cards.push({ ...c }); }
    }
    if (!cards.length) { startStudy(); return; }
    state.deck = cards;
    state.totalUnique = cards.length;
    state.index = 0;
    state.flipped = false;
    state.finished = false;
    state.reviewed.clear();
    state.grades = {};
    $('#studyTotal').textContent = cards.length;
    renderCard();
  });

  // Delegation: "Practice writing" button on character card back
  $('#cardEnglish').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-write-char]');
    if (!btn) return;
    e.stopPropagation();
    openWriter(btn.dataset.writeChar, btn.dataset.writePy, btn.dataset.writeEn);
  });

  // Writer dialog controls
  const wDlg = $('#writerDialog');
  if (wDlg) {
    $('#writerAnimate').addEventListener('click', () => {
      if (!state.writer) return;
      try { state.writer.cancelQuiz(); } catch (e) {}
      $('#writerStatus').textContent = 'Watch the strokes…';
      state.writer.animateCharacter({ onComplete: () => { $('#writerStatus').textContent = 'Now try tracing it.'; } });
    });
    $('#writerQuiz').addEventListener('click', () => {
      if (!state.writer) return;
      $('#writerStatus').textContent = 'Trace each stroke in order…';
      state.writer.quiz({
        showHintAfterMisses: 3,
        onMistake: () => { $('#writerStatus').textContent = 'Almost — try that stroke again.'; },
        onCorrectStroke: ({ strokesRemaining }) => {
          $('#writerStatus').textContent = strokesRemaining > 0
            ? `${strokesRemaining} stroke${strokesRemaining === 1 ? '' : 's'} to go.`
            : 'Last stroke!';
        },
        onComplete: ({ totalMistakes }) => {
          $('#writerStatus').textContent = totalMistakes === 0
            ? '✓ Perfect — no mistakes.'
            : `✓ Done. ${totalMistakes} mistake${totalMistakes === 1 ? '' : 's'}.`;
        },
      });
    });
    $('#writerClose').addEventListener('click', closeWriter);
    $('#writerDone').addEventListener('click', closeWriter);
    wDlg.addEventListener('cancel', (e) => { e.preventDefault(); closeWriter(); });
    wDlg.addEventListener('click', (e) => {
      // click on backdrop (the dialog element itself, not its inner content)
      if (e.target === wDlg) closeWriter();
    });
  }

  // Search
  bindSearch();

  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  const dialogOpen = !!document.querySelector('dialog[open]');
  // Global: "/" opens the search FAB from anywhere — except over a modal.
  if (e.key === '/' && !dialogOpen && !e.target.matches('input, textarea, [contenteditable]')) {
    e.preventDefault();
    openSearch();
    return;
  }
  // Esc closes the open search panel
  if (e.key === 'Escape') {
    const panel = $('#searchPanel');
    if (panel && !panel.hidden) { closeSearch(); return; }
  }
  if (state.view !== 'study') return;
  if (e.target.matches('input, textarea, select, [contenteditable]')) return;
  if (dialogOpen) return;              // dialogs own the keyboard
  const k = e.key.toLowerCase();
  // On a focused button/link, ONLY Enter/Space belong to the element
  // (native activation). All other shortcuts must keep working —
  // otherwise one tap on any button kills the keyboard for the session.
  const onInteractive = e.target.closest && e.target.closest('button, a, [role="button"]');
  if (onInteractive && (k === ' ' || k === 'enter')) return;
  if (e.repeat && ['1', '2', '3', '4'].includes(k)) return;   // held key ≠ many grades
  if (k === ' ' || k === 'enter') { e.preventDefault(); flipCard(); return; }
  if (k === 'arrowright' || k === 'arrowdown' || k === 'j') { e.preventDefault(); nextCard(false); return; }
  if (k === 'arrowleft'  || k === 'arrowup'   || k === 'k') { e.preventDefault(); prevCard(); return; }
  if (state.finished) return;          // no silent re-grading on the finish screen
  if (k === '1') { grade('again'); return; }
  if (k === '2') { grade('hard'); return; }
  if (k === '3') { grade('good'); return; }
  if (k === '4') { grade('easy'); return; }
  if (k === 'p') { e.preventDefault(); playCardAudio(); return; }
  if (k === 's') { $('#btnShuffle').click(); return; }
  if (k === 'r') { $('#btnReset').click(); return; }
}

/* ---------------------- search ---------------------- */
function buildSearchIndex() {
  // Each entry stores searchable text + a DEEP route (deck + card index),
  // and the haystack carries both spaced and space-collapsed toneless
  // pinyin so 'haojiu' matches data stored as 'hǎo jiǔ'.
  const hay = (zh, py, en) => {
    const np = normPinyin(py);
    return (zh + ' ' + py + ' ' + en).toLowerCase() + ' ' + np + ' ' + np.replace(/ /g, '');
  };
  const idx = [];
  for (const L of state.data.lessons) {
    for (let i = 0; i < L.vocab.length; i++) {
      const v = L.vocab[i];
      idx.push({
        zh: v.chinese, py: v.pinyin, en: v.english,
        sub: `Lesson ${L.id} · ${L.title_zh}`,
        route: `#/study/${L.id}/vocab/${i}`,
        kind: 'word',
        haystack: hay(v.chinese, v.pinyin, v.english),
      });
    }
    for (let i = 0; i < (L.sentences || []).length; i++) {
      const s = L.sentences[i];
      idx.push({
        zh: s.chinese, py: s.pinyin, en: s.english,
        sub: `Lesson ${L.id} · ${L.title_zh}`,
        route: `#/study/${L.id}/sentences/${i}`,
        kind: 'sentence',
        haystack: hay(s.chinese, s.pinyin, s.english),
      });
    }
    const chars = L.characters || [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const py = (L.char_pinyin || {})[c] || '';
      const en = (L.char_gloss || {})[c] || '';
      idx.push({
        zh: c, py, en,
        sub: `Lesson ${L.id} · 读写字`,
        route: `#/study/${L.id}/characters/${i}`,
        kind: 'hanzi',
        haystack: hay(c, py, en),
      });
    }
  }
  state.searchIndex = idx;
}
function openSearch() {
  const panel = $('#searchPanel');
  const fab   = $('#searchFab');
  const inp   = $('#searchInput');
  if (!panel) return;
  panel.hidden = false;
  panel.classList.add('is-open');
  if (fab) fab.setAttribute('aria-expanded', 'true');
  setTimeout(() => inp && inp.focus(), 30);
}
function closeSearch() {
  const panel = $('#searchPanel');
  const fab   = $('#searchFab');
  if (!panel) return;
  // Don't strand keyboard/SR focus inside a hidden subtree.
  const hadFocus = panel.contains(document.activeElement);
  panel.classList.remove('is-open');
  panel.hidden = true;
  if (fab) {
    fab.setAttribute('aria-expanded', 'false');
    if (hadFocus) fab.focus();
  }
  closeSearchResults();
  const inp = $('#searchInput');
  if (inp) inp.value = '';
}
function bindSearch() {
  const inp = $('#searchInput');
  const out = $('#searchResults');
  const fab = $('#searchFab');
  const close = $('#searchClose');
  const panel = $('#searchPanel');
  if (!inp || !out) return;
  if (fab)   fab.addEventListener('click', () => $('#searchPanel').classList.contains('is-open') ? closeSearch() : openSearch());
  if (close) close.addEventListener('click', closeSearch);
  inp.addEventListener('input', () => doSearch(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearch(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = out.querySelector('.searchresult');
      if (first) first.click();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = out.querySelector('.searchresult');
      if (first) first.focus();
    }
  });
  // Arrow keys walk the result list; ArrowUp from the first returns to input.
  out.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(out.querySelectorAll('.searchresult'));
    const i = items.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    if (e.key === 'ArrowDown' && i < items.length - 1) items[i + 1].focus();
    else if (e.key === 'ArrowUp') (i === 0 ? inp : items[i - 1]).focus();
  });
  // A result whose href EQUALS the current hash fires no hashchange —
  // re-route manually so the click is never a silent no-op.
  out.addEventListener('click', (e) => {
    const a = e.target.closest('a.searchresult');
    if (!a) return;
    if (a.getAttribute('href') === location.hash) {
      e.preventDefault();
      routeFromHash();
    }
  });
  // Click outside panel closes
  document.addEventListener('click', (e) => {
    if (!panel || panel.hidden) return;
    if (!e.target.closest('#searchPanel') && !e.target.closest('#searchFab')) {
      closeSearch();
    }
  });
}
function closeSearchResults() {
  const out = $('#searchResults');
  if (out) { out.hidden = true; out.innerHTML = ''; }
}
function doSearch(q) {
  const out = $('#searchResults');
  q = String(q || '').trim().toLowerCase();
  if (!q) { closeSearchResults(); return; }
  if (!state.searchIndex) buildSearchIndex();
  const nq = normPinyin(q);
  const hits = [];
  for (const it of state.searchIndex) {
    if (it.haystack.includes(q) || (nq && it.haystack.includes(nq))) {
      hits.push(it);
      if (hits.length >= 25) break;
    }
  }
  if (!hits.length) {
    out.hidden = false;
    out.innerHTML = `<div class="searchresult searchresult--empty">No matches for "${escapeHTML(q)}".</div>`;
    return;
  }
  out.hidden = false;
  out.innerHTML = hits.map((h) => `
    <a class="searchresult searchresult--${h.kind}" href="${h.route}" role="listitem">
      <span class="searchresult__zh" lang="zh-CN">${escapeHTML(h.zh)}</span>
      <span class="searchresult__py">${escapeHTML(h.py)}</span>
      <span class="searchresult__en">${escapeHTML(h.en)}</span>
      <span class="searchresult__sub">${escapeHTML(h.sub)}</span>
    </a>
  `).join('');
}

/* ---------------------- settings dialog ---------------------- */
function bindSettingsDialog() {
  const dlg = $('#settingsDialog');
  $('#settingsBtn').addEventListener('click', () => {
    $('#setTheme').value         = state.settings.theme;
    $('#setFront').value         = state.settings.front;
    $('#setSize').value          = state.settings.size;
    $('#setAutoplay').checked    = !!state.settings.autoplay;
    $('#setReduceMotion').checked = !!state.settings.reduceMotion;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', 'open');
  });

  $('#setTheme').addEventListener('change', (e) => { state.settings.theme = e.target.value; applySettings(); saveSettings(); });
  $('#setFront').addEventListener('change', (e) => { state.settings.front = e.target.value; saveSettings(); if (state.view === 'study') renderCard(); });
  $('#setSize').addEventListener('change', (e) => { state.settings.size = e.target.value; saveSettings(); if (state.view === 'study') renderCard(); });
  $('#setAutoplay').addEventListener('change', (e) => { state.settings.autoplay = e.target.checked; saveSettings(); });
  $('#setReduceMotion').addEventListener('change', (e) => { state.settings.reduceMotion = e.target.checked; saveSettings(); applySettings(); });

  // Backup / restore — localStorage is not forever (iOS evicts it after
  // ~7 days of Safari non-use), so give users a one-tap escape hatch.
  const expBtn = $('#setExport');
  if (expBtn) expBtn.addEventListener('click', () => {
    const payload = {
      exported: new Date().toISOString(),
      progress: state.progress,
      settings: state.settings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tlc-progress-${localDateStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const impInput = $('#setImportFile');
  const impBtn = $('#setImport');
  if (impBtn && impInput) {
    impBtn.addEventListener('click', () => impInput.click());
    impInput.addEventListener('change', () => {
      const f = impInput.files && impInput.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const p = JSON.parse(r.result);
          if (!p || typeof p !== 'object' || !p.progress || !p.progress.lessons) {
            alert('That file doesn\'t look like a progress backup.');
            return;
          }
          if (!confirm('Replace your current progress with this backup?')) return;
          state.progress = p.progress;
          saveProgress();
          if (p.settings) { state.settings = Object.assign(defaultSettings(), p.settings); saveSettings(); applySettings(); }
          state._flat = null;
          alert('Progress restored.');
          if (state.view === 'home') renderHome();
        } catch (e) { alert('Could not read that file.'); }
        impInput.value = '';
      };
      r.readAsText(f);
    });
  }

  $('#setResetProgress').addEventListener('click', () => {
    if (!confirm('Reset all progress and grades? This cannot be undone.')) return;
    state.progress = { lessons: {}, lastStudyDate: null, streak: 0 };
    saveProgress();
    if (state.view === 'home') renderHome();
  });
}

function applySettings() {
  const html = document.documentElement;
  if (state.settings.theme === 'dark') html.setAttribute('data-theme', 'dark');
  else if (state.settings.theme === 'light') html.setAttribute('data-theme', 'light');
  else html.removeAttribute('data-theme');

  if (state.settings.reduceMotion) html.setAttribute('data-motion', 'reduce');
  else html.removeAttribute('data-motion');
}

/* ---------------------- go ---------------------- */
document.addEventListener('DOMContentLoaded', init);
