/* ============================================================
   역 튜링 테스트 — client
   ============================================================ */
(function () {
'use strict';

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- state ---------------- */
const S = {
  topics: [],
  cast: [],
  topic: null,
  rounds: 3,
  game: null,
  transcript: [],
  schedule: [],
  ptr: 0,
  turnTotal: 0,
  turnDone: 0,
  vote: null,
  composerHTML: '',
  model: 'opus5',
  models: [],
  mix: null,
};

function modelById(id) {
  return (S.models || []).find((m) => m.id === id) || null;
}

function modelLabel(id) {
  if (id === 'mix') return '혼합';
  const m = modelById(id);
  return m ? m.label : id;
}

function loadModel() {
  try {
    const v = localStorage.getItem('rtt.model');
    if (v) return v;
  } catch (e) { /* private mode */ }
  return null;
}

function saveModel(v) {
  try { localStorage.setItem('rtt.model', v); } catch (e) { /* ignore */ }
}

/** Which model a given persona will use under the current selection. */
function turnModelFor(personaId) {
  if (S.model !== 'mix') return S.model;
  const a = ((S.mix && S.mix.assignment) || []).find((x) => x.personaId === personaId);
  return a ? a.modelId : 'opus5';
}

/** Expected seconds for one call under the current selection (slowest if 혼합). */
function expectedSecs() {
  if (S.model === 'mix') {
    const ids = ((S.mix && S.mix.assignment) || []).map((a) => a.modelId);
    const times = ids.map((id) => (modelById(id) || {}).approxMs || 8000);
    return Math.round(Math.max.apply(null, times.concat([0])) / 1000) || 13;
  }
  const m = modelById(S.model);
  return Math.round((m ? m.approxMs : 8000) / 1000);
}

/* ---------------- utils ---------------- */
function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

const ACCENT = '#2f6df6';

/**
 * The avatar circle is the ONLY place a persona colour survives. Raw persona
 * hues are neon on white, so they are desaturated and darkened to a calm
 * mid-tone that still carries white text at accessible contrast.
 */
function calmColor(hex) {
  const h = String(hex || '#888888').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (isNaN(n)) return '#71717a';
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hue = 0;
  const d = max - min;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  hue *= 60;
  if (hue < 0) hue += 360;
  return hslToHex(hue, 0.34, 0.48); // calm, consistent weight on white
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2]);
}

function avatar(p, size) {
  const n = el('div', 'av av--' + (size || 32));
  // "you" is the only strong colour in the transcript
  n.style.background = p && p.isHuman ? ACCENT : calmColor(p && p.color);
  n.textContent = (p.name || '?').trim().charAt(0);
  return n;
}

function show(id) {
  $$('.screen').forEach((s) => s.classList.remove('is-active'));
  const t = document.getElementById(id);
  if (t) t.classList.add('is-active');
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('is-on');
    setTimeout(() => { t.hidden = true; }, 320);
  }, 3200);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function byId(id) {
  return (S.game && S.game.roster.find((p) => p.id === id)) || null;
}

/* ============================================================
   INTRO
   ============================================================ */
async function boot() {
  S.composerHTML = $('#composer').innerHTML;

  try {
    const meta = await api('/api/topics');
    S.topics = meta.topics || [];
    S.cast = meta.cast || [];
    S.models = meta.models || [];
    S.mix = meta.mix || null;
    // saved choice wins; otherwise the server default (MODEL env, else opus5)
    S.model = loadModel() || meta.defaultModel || 'opus5';
  } catch (e) {
    S.topics = ['라면은 꼬들면이 정답인가, 퍼진 면이 정답인가?'];
    S.cast = [];
    S.models = [];
    S.mix = null;
    S.model = loadModel() || 'opus5';
    toast('서버와 연결하지 못했습니다.');
  }
  // guard against a stale localStorage id from an older build
  if (S.model !== 'mix' && S.models.length && !modelById(S.model)) S.model = 'opus5';

  renderCast();
  renderModels();
  renderTopics();
  wire();
}

function renderModels() {
  const seg = $('#engine-seg');
  seg.innerHTML = '';
  const list = (S.models || []).slice();
  list.forEach((m) => {
    const b = el('button', 'ebtn');
    b.type = 'button';
    b.dataset.engine = m.id;
    b.appendChild(el('span', 'edot'));
    b.appendChild(el('span', null, m.label));
    b.appendChild(el('span', 'emodel', Math.round(m.approxMs / 1000) + 's'));
    b.title = m.model + ' — ' + m.vendor;
    b.addEventListener('click', () => setModel(m.id));
    seg.appendChild(b);
  });
  if (S.mix) {
    const b = el('button', 'ebtn ebtn--mix');
    b.type = 'button';
    b.dataset.engine = 'mix';
    b.appendChild(el('span', 'edot'));
    b.appendChild(el('span', null, S.mix.label || '혼합'));
    b.appendChild(el('span', 'emodel', '4종'));
    b.title = '페르소나마다 다른 모델을 배정합니다.';
    b.addEventListener('click', () => setModel('mix'));
    seg.appendChild(b);
  }
  paintModel();
}

function setModel(id) {
  S.model = id;
  saveModel(id);
  paintModel();
}

function paintModel() {
  $$('.ebtn').forEach((n) => n.classList.toggle('is-on', n.dataset.engine === S.model));
  const note = $('#engine-note');
  if (note) {
    note.innerHTML = '';
    if (S.model === 'mix' && S.mix) {
      note.appendChild(el('span', null, '페르소나마다 다른 모델이 붙습니다 — '));
      (S.mix.assignment || []).forEach((a, i) => {
        if (i) note.appendChild(el('span', null, ' · '));
        const s = el('span', null, a.personaName + ' ' + a.modelLabel);
        note.appendChild(s);
      });
      note.appendChild(el('span', null, '. 투표는 동시 실행이라 가장 느린 모델 기준 약 ' + expectedSecs() + '초.'));
    } else {
      const m = modelById(S.model);
      note.textContent = m
        ? m.vendor + ' · ' + m.model + ' — 호출당 약 ' + Math.round(m.approxMs / 1000) + '초 (' + m.speed + ')'
        : '';
    }
  }
  const badge = $('#badge-model');
  if (badge) {
    const m = modelById(S.model);
    badge.textContent = S.model === 'mix' ? '혼합 패널' : (m ? m.model : S.model);
  }
}

function renderCast() {
  const row = $('#cast-row');
  row.innerHTML = '';
  S.cast.forEach((p, i) => {
    const item = el('div', 'cast__item');
    item.style.animation = 'msgIn .5s ' + (i * 0.07) + 's cubic-bezier(.2,.9,.3,1) both';
    item.appendChild(avatar(p, 28));
    const b = el('div');
    b.appendChild(el('div', 'nm', p.name));
    b.appendChild(el('div', 'tg', p.tag));
    item.appendChild(b);
    row.appendChild(item);
  });
}

function renderTopics() {
  const grid = $('#topic-grid');
  grid.innerHTML = '';
  S.topics.forEach((t, i) => {
    const c = el('button', 'tcard', t);
    c.type = 'button';
    c.style.animation = 'msgIn .45s ' + (i * 0.03) + 's cubic-bezier(.2,.9,.3,1) both';
    c.addEventListener('click', () => selectTopic(t, c));
    grid.appendChild(c);
  });
}

function selectTopic(t, node) {
  S.topic = t;
  $$('.tcard').forEach((n) => n.classList.toggle('is-on', n === node));
  $('#btn-start').disabled = false;
}

function wire() {
  $('#btn-to-topic').addEventListener('click', () => show('screen-topic'));
  $('#btn-back-intro').addEventListener('click', () => show('screen-intro'));

  $('#rounds-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg__btn');
    if (!b) return;
    S.rounds = parseInt(b.dataset.rounds, 10);
    $$('.seg__btn').forEach((n) => n.classList.toggle('is-on', n === b));
  });

  $('#btn-random').addEventListener('click', () => {
    const cards = $$('.tcard');
    if (!cards.length) return;
    const i = Math.floor(Math.random() * cards.length);
    selectTopic(S.topics[i], cards[i]);
    cards[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    toast('랜덤 주제가 선택되었습니다.');
  });

  $('#btn-start').addEventListener('click', startGame);

  const input = $('#input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(110, input.scrollHeight) + 'px';
    $('#btn-send').disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitHuman(); }
  });
  $('#btn-send').addEventListener('click', submitHuman);

  // #btn-reveal 은 개표가 끝난 뒤에만 생성된다 (mountRevealButton 참고).
  $('#btn-again').addEventListener('click', resetAll);
  $('#btn-log').addEventListener('click', showLog);
}

/* ============================================================
   GAME START
   ============================================================ */
async function startGame() {
  const btn = $('#btn-start');
  btn.disabled = true;
  btn.textContent = '채팅방 연결 중…';

  let data;
  try {
    data = await api('/api/start', { topic: S.topic, rounds: S.rounds, model: S.model });
  } catch (e) {
    toast('서버 연결 실패. 다시 시도해주세요.');
    btn.disabled = false;
    btn.textContent = '채팅방 입장';
    return;
  }
  btn.innerHTML = '채팅방 입장';
  btn.disabled = false;

  S.game = data;
  S.rounds = data.rounds;
  S.transcript = [];
  S.ptr = 0;
  S.turnDone = 0;

  // flatten the whole game into an ordered schedule
  S.schedule = [];
  for (let r = 1; r <= S.rounds; r++) {
    S.schedule.push({ type: 'round', r: r });
    data.order.forEach((id) => S.schedule.push({ type: 'turn', id: id, r: r }));
  }
  S.schedule.push({ type: 'vote' });
  S.turnTotal = S.schedule.filter((s) => s.type === 'turn').length;

  const human = data.roster.find((p) => p.isHuman);
  $('#chat-topic').textContent = data.topic;
  $('#chat-youname').textContent = human.name;
  $('#chat-round-label').textContent = '라운드 1 / ' + S.rounds;
  $('#chat-stream').innerHTML = '';
  $('#progress-bar').style.width = '0%';
  $('#composer').innerHTML = S.composerHTML;
  rewireComposer();

  const ca = $('#composer-avatar');
  ca.innerHTML = '';
  ca.appendChild(avatar(human, 32));

  renderRoster();
  show('screen-chat');

  addSystem('당신은 <b>' + esc(human.name) + '</b> 이라는 이름의 참가자로 입장했습니다. 정체를 들키지 마세요.');
  await sleep(700);
  step();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRoster() {
  const strip = $('#roster-strip');
  strip.innerHTML = '';
  S.game.order.forEach((id) => {
    const p = byId(id);
    const chip = el('div', 'rchip' + (p.isHuman ? ' is-you' : ''));
    chip.dataset.id = p.id;
    chip.appendChild(avatar(p, 28));
    const nm = el('span', null, p.name + (p.isHuman ? ' (당신)' : ''));
    chip.appendChild(nm);
    strip.appendChild(chip);
  });
}

function markActive(id) {
  $$('.rchip').forEach((c) => c.classList.toggle('is-active', c.dataset.id === id));
}

/* ============================================================
   CHAT ENGINE
   ============================================================ */
function scrollDown() {
  const sc = $('#chat-scroll');
  sc.scrollTop = sc.scrollHeight;
}

function addSystem(html) {
  const n = el('div', 'sys');
  n.innerHTML = html;
  $('#chat-stream').appendChild(n);
  scrollDown();
}

function modelTag(res) {
  if (!res || !res.model) return null;
  const label = res.modelLabel || modelLabel(res.model);
  const t = el('span', 'eng-tag eng-tag--' + res.model, label);
  if (res.fellBack) {
    t.className = 'eng-tag eng-tag--fell';
    t.textContent = modelLabel(res.requestedModel) + '\u2192' + label;
    t.title = modelLabel(res.requestedModel) + ' 호출이 실패해 ' + label + ' 로 대체되었습니다.';
  } else {
    t.title = '이 메시지를 생성한 모델: ' + label;
  }
  return t;
}

function addMessage(p, text, degraded, res) {
  const wrap = el('div', 'msg' + (p.isHuman ? ' msg--me' : ''));
  wrap.appendChild(avatar(p, 36));
  const body = el('div', 'msg__body');

  const top = el('div', 'msg__top');
  const nm = el('span', 'msg__name', p.name);
  top.appendChild(nm);
  top.appendChild(el('span', 'msg__tag', '@' + p.handle));
  const et = modelTag(res);
  if (et) top.appendChild(et);
  body.appendChild(top);

  const bub = el('div', 'msg__bubble');
  bub.textContent = text;
  if (degraded) {
    const f = el('span', 'msg__flag', 'OFFLINE');
    bub.appendChild(f);
  }
  body.appendChild(bub);
  wrap.appendChild(body);
  $('#chat-stream').appendChild(wrap);
  scrollDown();

  S.transcript.push({ playerId: p.id, name: p.name, text: text });
}

function showTyping(p) {
  const wrap = el('div', 'typing');
  wrap.id = 'typing-node';
  wrap.appendChild(avatar(p, 36));
  const body = el('div');
  const top = el('div', 'msg__top');
  const nm = el('span', 'msg__name', p.name);
  top.appendChild(nm);
  top.appendChild(el('span', 'msg__tag', '입력 중…'));
  body.appendChild(top);
  const b = el('div', 'typing__bubble');
  b.appendChild(el('i')); b.appendChild(el('i')); b.appendChild(el('i'));
  body.appendChild(b);
  wrap.appendChild(body);
  $('#chat-stream').appendChild(wrap);
  scrollDown();
}

function hideTyping() {
  const n = document.getElementById('typing-node');
  if (n) n.remove();
}

function setStatus(text, isTurn) {
  $('#composer-status-text').textContent = text;
  $('#composer-status').classList.toggle('is-turn', !!isTurn);
}

/**
 * Runs fn(elapsedSeconds) every second until the returned stopper is called.
 * Slow models (Terra/Luna ~13s, and the 혼합 vote phase) would otherwise look hung.
 */
function ticker(fn) {
  const t0 = Date.now();
  fn(0);
  const h = setInterval(() => fn(Math.round((Date.now() - t0) / 1000)), 1000);
  return () => clearInterval(h);
}

function setComposerEnabled(on) {
  const input = $('#input');
  input.disabled = !on;
  $('#btn-send').disabled = !on || !input.value.trim();
  if (on) setTimeout(() => input.focus(), 60);
}

function bumpProgress() {
  S.turnDone++;
  $('#progress-bar').style.width = Math.round((S.turnDone / S.turnTotal) * 100) + '%';
}

async function step() {
  if (S.ptr >= S.schedule.length) return;
  const node = S.schedule[S.ptr++];

  if (node.type === 'round') {
    $('#chat-round-label').textContent = '라운드 ' + node.r + ' / ' + S.rounds;
    addSystem('━━  라운드 <b>' + node.r + '</b> / ' + S.rounds + '  ━━');
    await sleep(450);
    return step();
  }

  if (node.type === 'vote') {
    markActive(null);
    setStatus('대화 종료. 투표 집계 중…', false);
    setComposerEnabled(false);
    addSystem('대화가 종료되었습니다. AI들이 투표를 시작합니다…');
    await sleep(1100);
    return runVote();
  }

  const p = byId(node.id);
  markActive(p.id);

  if (p.isHuman) {
    setStatus('당신의 차례입니다 — AI처럼 말하세요', true);
    setComposerEnabled(true);
    return;
  }

  setComposerEnabled(false);
  showTyping(p);
  const eta = expectedSecs();
  const stopTick = ticker((s) => {
    setStatus(p.name + ' 님이 ' + modelLabel(turnModelFor(p.id)) + ' 로 응답 생성 중… ' + s + 's / 약 ' + eta + 's', false);
  });

  let res = null;
  try {
    res = await api('/api/ai-turn', {
      gameId: S.game.gameId,
      playerId: p.id,
      topic: S.game.topic,
      roster: S.game.roster,
      transcript: S.transcript,
      model: S.model,
    });
  } catch (e) {
    res = null;
  }
  stopTick();
  hideTyping();

  if (!res || !res.text) {
    addMessage(p, '…연결이 잠시 끊겼습니다.', true, null);
    toast(p.name + ' 응답 실패 — 대체 메시지로 진행합니다.');
  } else {
    addMessage(p, res.text, res.live === false, res);
    if (res.live === false) toast(p.name + ' 은(는) 오프라인 대체 응답을 사용했습니다.');
    else if (res.fellBack) toast(modelLabel(res.requestedModel) + ' 실패 → ' + modelLabel(res.model) + ' 로 대체했습니다.');
  }
  bumpProgress();
  await sleep(520);
  return step();
}

function submitHuman() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  const human = S.game.roster.find((p) => p.isHuman);
  input.value = '';
  input.style.height = 'auto';
  setComposerEnabled(false);
  setStatus('전송됨 — AI들이 읽는 중…', false);
  addMessage(human, text, false, null);
  bumpProgress();
  setTimeout(step, 620);
}

function rewireComposer() {
  const input = $('#input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(110, input.scrollHeight) + 'px';
    $('#btn-send').disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitHuman(); }
  });
  $('#btn-send').addEventListener('click', submitHuman);
}

/* ============================================================
   VOTE
   ============================================================ */
async function runVote() {
  show('screen-vote');
  $('#vote-title').textContent = 'AI들이 심의 중…';
  $('#vote-sub').textContent = '4개의 인스턴스가 동시에 대화 기록을 분석하고 있습니다.';
  $('#vote-scanner').classList.remove('is-done');
  $('#ballots').innerHTML = '';
  $('#tally').hidden = true;
  $('#tally-rows').innerHTML = '';
  $('#reveal-slot').innerHTML = '';   // 이전 판의 버튼 제거

  const veta = expectedSecs();
  const stopVoteTick = ticker((s) => {
    const sub = $('#vote-sub');
    if (sub) {
      sub.textContent = '4개 인스턴스가 동시에 대화 기록을 분석 중… ' + s + 's'
        + ' (동시 실행, 약 ' + veta + 's 예상)';
    }
  });

  let data = null;
  try {
    data = await api('/api/vote', {
      gameId: S.game.gameId,
      topic: S.game.topic,
      roster: S.game.roster,
      transcript: S.transcript,
      model: S.model,
    });
  } catch (e) {
    data = null;
  }
  stopVoteTick();

  if (!data || !data.votes) {
    $('#vote-title').textContent = '투표 집계 실패';
    $('#vote-sub').textContent = '서버 응답을 받지 못했습니다.';
    $('#vote-scanner').classList.add('is-done');
    toast('투표 요청이 실패했습니다.');
    return;
  }

  S.vote = data;
  $('#vote-scanner').classList.add('is-done');
  $('#vote-title').textContent = '투표 개봉';
  $('#vote-sub').textContent = '각 AI가 인간이라고 지목한 참가자';

  const humanId = data.humanId;
  for (let i = 0; i < data.votes.length; i++) {
    await sleep(i === 0 ? 350 : 1350);
    renderBallot(data.votes[i], humanId);
  }

  await sleep(1000);
  renderTally(data);
  await sleep(1500);
  buildResult(data);        // 결과 화면을 먼저 채우고
  mountRevealButton();      // 그 다음에야 버튼이 생긴다
}

// 개표가 끝난 뒤에만 '결과 확인' 버튼을 만들어 붙인다.
// 결과가 준비되기 전에는 DOM 에 아예 존재하지 않으므로 눌릴 수가 없다.
function mountRevealButton() {
  const slot = $('#reveal-slot');
  if (!slot || slot.firstChild) return;
  const btn = el('button', 'btn btn--primary btn--xl', '결과 확인');
  btn.id = 'btn-reveal';
  btn.addEventListener('click', () => { if (S.vote) show('screen-result'); });
  slot.appendChild(btn);
}

function renderBallot(v, humanId) {
  const voter = byId(v.voterId) || { name: v.voterName, color: v.voterColor, handle: v.voterId };
  const target = byId(v.suspectId) || { name: v.suspectName, color: v.suspectColor || '#888', handle: '' };

  const card = el('div', 'ballot' + (v.suspectId === humanId ? ' is-hit' : ''));
  card.appendChild(avatar(voter, 44));

  const b = el('div', 'ballot__b');
  const hd = el('div', 'ballot__hd');
  const vn = el('span', 'ballot__voter', voter.name);
  hd.appendChild(vn);
  hd.appendChild(el('span', 'ballot__arrow', '의 지목 →'));

  const tg = el('span', 'ballot__target');
  tg.appendChild(avatar(target, 28));
  tg.appendChild(el('span', null, target.name));
  hd.appendChild(tg);
  if (v.live === false) hd.appendChild(el('span', 'msg__flag', 'OFFLINE'));
  const et = modelTag(v);
  if (et) hd.appendChild(et);
  b.appendChild(hd);

  b.appendChild(el('div', 'ballot__reason', v.reason));
  card.appendChild(b);
  $('#ballots').appendChild(card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderTally(data) {
  const rows = $('#tally-rows');
  rows.innerHTML = '';
  const max = Math.max(1, Math.max.apply(null, Object.keys(data.tally).map((k) => data.tally[k])));

  S.game.roster.forEach((p) => {
    const n = data.tally[p.id] || 0;
    const row = el('div', 'trow' + (p.isHuman ? ' is-you' : ''));
    row.appendChild(el('div', 'trow__nm', p.name + (p.isHuman ? ' (당신)' : '')));
    const track = el('div', 'trow__track');
    const fill = el('div', 'trow__fill');
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'trow__n', String(n)));
    rows.appendChild(row);
    requestAnimationFrame(() => { fill.style.width = Math.round((n / max) * 100) + '%'; });
  });

  $('#tally').hidden = false;
}

/* ============================================================
   RESULT
   ============================================================ */
function buildResult(data) {
  const win = data.result === 'win';
  const card = $('#result-card');
  card.classList.toggle('result--lose', !win);

  $('#result-glyph').innerHTML = win
    ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#16a34a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l8 3.5v5.5c0 4.9-3.4 9.2-8 10.5-4.6-1.3-8-5.6-8-10.5V6z"/><path d="M8.6 12.2l2.4 2.4 4.4-4.6"/></svg>'
    : '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#dc2626" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4h.01"/></svg>';

  $('#result-verdict').textContent = win ? 'WIN' : 'LOSE';
  $('#result-title').textContent = win ? '위장 성공' : '정체 발각';

  const top = (data.topIds || []).map((id) => (byId(id) || {}).name || id).join(', ');
  $('#result-body').innerHTML = win
    ? 'AI들은 당신을 최다 득표로 지목하지 못했습니다. 최다 득표자는 <b>' + esc(top || '없음') +
      '</b> 였고, 당신 <b>' + esc(data.humanName) + '</b> 은(는) ' + data.humanVotes +
      '표를 받았습니다.<br>당신은 기계들 사이에서 기계로 통했습니다.'
    : 'AI들은 <b>' + esc(data.humanName) + '</b> 을(를) ' + data.humanVotes +
      '표로 지목했습니다. 인간의 냄새가 새어 나갔습니다.<br>다음엔 감정을 조금 덜 흘려보세요.';

  const stats = $('#result-stats');
  stats.innerHTML = '';
  [
    { n: data.humanVotes + ' / 4', l: '당신 득표' },
    { n: String(S.rounds), l: '라운드' },
    { n: String(S.transcript.length), l: '총 발언' },
  ].forEach((s) => {
    const box = el('div', 'stat');
    const num = el('div', 'stat__n', s.n);
    box.appendChild(num);
    box.appendChild(el('div', 'stat__l', s.l));
    stats.appendChild(box);
  });
}

function showLog() {
  show('screen-chat');
  const comp = $('#composer');
  comp.innerHTML = '';
  const btn = el('button', 'btn btn--ghost', '← 결과로 돌아가기');
  btn.style.width = '100%';
  btn.addEventListener('click', () => show('screen-result'));
  comp.appendChild(btn);
  setTimeout(scrollDown, 60);
}

function resetAll() {
  S.game = null;
  S.transcript = [];
  S.vote = null;
  S.topic = null;
  S.ptr = 0;
  S.turnDone = 0;
  $('#btn-start').disabled = true;
  $$('.tcard').forEach((n) => n.classList.remove('is-on'));
  $('#composer').innerHTML = S.composerHTML;
  rewireComposer();
  show('screen-topic');
}

boot();
})();
