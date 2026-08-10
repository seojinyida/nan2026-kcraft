'use strict';

/**
 * 역 튜링 테스트 (Reverse Turing Test)
 * Zero-dependency Node server. Built-in modules only.
 *
 * Every AI utterance / vote is produced by a real CLI call to one of two
 * interchangeable engines, selected per-request and routed through callEngine():
 *
 *   claude:  execFile('claude', ['-p','--model','claude-opus-5','--effort','low',
 *                                '--system-prompt', system, prompt], {timeout: 60000})
 *   codex:   execFile('codex',  ['exec','-m','gpt-5.6-sol',
 *                                '-c','model_reasoning_effort=low',
 *                                '--skip-git-repo-check','-o',<unique tmp file>,
 *                                system + '\n\n' + prompt], {timeout: 60000})
 *
 * Both return the same shape and feed the same message/vote parsers.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 3002;
const HOST = '0.0.0.0';
const ROOT = __dirname;

// The default ~/.codex home is a dead ChatGPT-account config (HTTP 400 on every
// model). This must be forced: the ambient CODEX_HOME on this box points at it.
const CODEX_HOME = process.env.CODEX_HOME_OVERRIDE || '/home/pineapple/.codex-new-account';

const CALL_TIMEOUT = 60000;
const MAX_BUFFER = 1024 * 1024;
const TMPDIR = process.env.TMPDIR || '/tmp';

/**
 * Model registry. Every field that reaches a command line lives HERE and is
 * looked up by id -- a client-supplied id is never interpolated into argv.
 *
 * Timings are measured on this machine, single call, low/none reasoning.
 * Known-bad and deliberately absent: *-fast model ids (HTTP 400, do not exist),
 * service_tier (unvalidated no-op), model_reasoning_effort=minimal (invalid).
 */
const MODELS = {
  opus5: {
    id: 'opus5', label: 'Opus 5', engine: 'claude',
    model: 'claude-opus-5', effort: 'low',
    vendor: 'Anthropic · claude CLI', approxMs: 7300, speed: '빠름',
  },
  sol: {
    id: 'sol', label: 'Sol', engine: 'codex',
    model: 'gpt-5.6-sol', reasoning: 'none',
    vendor: 'OpenAI · codex exec', approxMs: 7500, speed: '빠름',
  },
  terra: {
    id: 'terra', label: 'Terra', engine: 'codex',
    model: 'gpt-5.6-terra', reasoning: 'none',
    vendor: 'OpenAI · codex exec', approxMs: 13200, speed: '느림',
  },
  luna: {
    id: 'luna', label: 'Luna', engine: 'codex',
    model: 'gpt-5.6-luna', reasoning: 'none',
    vendor: 'OpenAI · codex exec', approxMs: 13400, speed: '느림',
  },
};

const FALLBACK_MODEL = 'opus5';
const MIX_ID = 'mix';

/** 혼합 mode: a genuinely mixed panel -- each persona runs on a different model. */
const MIX_ASSIGNMENT = {
  neosim: 'terra',
  drq: 'sol',
  hivy: 'opus5',
  watcher9: 'luna',
};

// Legacy alias so an older ENGINE=claude|codex env still means something sane.
const LEGACY_ENGINE_ALIAS = { claude: 'opus5', codex: 'sol' };

const DEFAULT_MODEL = (function () {
  const m = process.env.MODEL;
  if (m && (MODELS[m] || m === MIX_ID)) return m;
  const e = process.env.ENGINE;
  if (e && LEGACY_ENGINE_ALIAS[e]) return LEGACY_ENGINE_ALIAS[e];
  return 'opus5';
})();

function isValidSelection(v) {
  return v === MIX_ID || Object.prototype.hasOwnProperty.call(MODELS, v);
}

/** Which concrete model a given persona uses under a given selection. */
function resolveModelForPersona(selection, personaId) {
  if (selection === MIX_ID) return MIX_ASSIGNMENT[personaId] || FALLBACK_MODEL;
  return MODELS[selection] ? selection : FALLBACK_MODEL;
}

function HttpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Validate a client-supplied selection, or throw a 400. */
function requireSelection(raw) {
  if (raw == null || raw === '') return DEFAULT_MODEL;
  if (typeof raw !== 'string' || !isValidSelection(raw)) {
    throw HttpError(400, `unknown model id: ${JSON.stringify(String(raw)).slice(0, 60)}`);
  }
  return raw;
}

/* ------------------------------------------------------------------ *
 * Engine bridges
 * ------------------------------------------------------------------ */

const FALLBACK_BINS = [
  path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/usr/bin/claude',
];

function resolveFallbackBin() {
  for (const c of FALLBACK_BINS) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** Base child env with every ambient knob that could shadow our explicit flags removed. */
function baseChildEnv() {
  const e = Object.assign({}, process.env);
  delete e.CLAUDE_EFFORT;
  delete e.CLAUDE_MODEL;
  delete e.CODEX_MODEL;
  delete e.CODEX_EFFORT;
  delete e.CODEX_REASONING_EFFORT;
  return e;
}

/**
 * Calls the Claude CLI once. Resolves with trimmed stdout.
 * Rejects on timeout / non-zero exit so callers can substitute a fallback.
 */
function runClaude(spec, systemPrompt, userPrompt, bin) {
  const exe = bin || process.env.CLAUDE_BIN || 'claude';
  const args = [
    '-p',
    '--model', spec.model,
    '--effort', spec.effort,
    '--system-prompt', systemPrompt,
    userPrompt,
  ];
  const childEnv = baseChildEnv();

  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, { timeout: CALL_TIMEOUT, maxBuffer: MAX_BUFFER, env: childEnv }, (err, stdout, stderr) => {
      if (err) {
        // `claude` not on PATH (e.g. server started from a bare env) -> retry once, absolute.
        if (err.code === 'ENOENT' && !bin) {
          const fb = resolveFallbackBin();
          if (fb) return resolve(runClaude(spec, systemPrompt, userPrompt, fb));
        }
        err.stderrText = String(stderr || '').slice(0, 400);
        return reject(err);
      }
      resolve(String(stdout || '').trim());
    });
    if (child.stdin) child.stdin.end();
  });
}

let codexSeq = 0;

/**
 * Calls the Codex CLI once.
 *
 * codex exec prints a session banner + token accounting to stdout, so stdout is
 * unparseable. --output-last-message writes ONLY the model's final message, so we
 * read that instead. The path must be unique per call: AI turns and the four
 * concurrent vote calls would otherwise race on one file.
 */
function runCodex(spec, systemPrompt, userPrompt) {
  const exe = process.env.CODEX_BIN || 'codex';
  const outFile = path.join(
    TMPDIR,
    `rtt-codex-${process.pid}-${Date.now()}-${++codexSeq}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  // No system-prompt flag exists: concatenate into the single prompt argument.
  const combined = systemPrompt + '\n\n' + userPrompt;
  const args = [
    'exec',
    '-m', spec.model,
    '-c', 'model_reasoning_effort=' + spec.reasoning,
    '--skip-git-repo-check',
    '-o', outFile,
    combined,
  ];
  const childEnv = baseChildEnv();
  childEnv.CODEX_HOME = CODEX_HOME; // ambient CODEX_HOME points at the dead account

  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, { timeout: CALL_TIMEOUT, maxBuffer: MAX_BUFFER, env: childEnv, cwd: TMPDIR }, (err, stdout, stderr) => {
      let text = '';
      try {
        text = fs.readFileSync(outFile, 'utf8').trim();
      } catch (_) { /* file may not exist on failure */ }
      try { fs.unlinkSync(outFile); } catch (_) { /* best effort */ }

      if (err) {
        // A usable final message may have landed before a non-zero exit / timeout.
        if (text) return resolve(text);
        err.stderrText = String(stderr || '').slice(0, 400);
        return reject(err);
      }
      if (!text) return reject(new Error('codex produced no final message'));
      resolve(text);
    });
    // codex reads stdin ("Reading additional input from stdin...") -> close it or it waits.
    if (child.stdin) child.stdin.end();
  });
}

/**
 * The single entry point for every LLM call in the game.
 *
 * `modelId` must already be a registry key; the spec (binary, model string,
 * effort) comes from the registry, never from the caller. Returns
 * { text, modelId, requestedModelId, fellBack } where `modelId` is the model
 * that actually produced the text.
 */
async function callModel(opts) {
  const requested = opts.modelId;
  const spec = MODELS[requested];
  if (!spec) throw HttpError(400, `unknown model id: ${String(requested).slice(0, 40)}`);

  const run = (s) => (s.engine === 'codex'
    ? runCodex(s, opts.system, opts.prompt)
    : runClaude(s, opts.system, opts.prompt));

  try {
    const text = await run(spec);
    if (!String(text || '').trim()) throw new Error('empty response');
    return { text: String(text).trim(), modelId: requested, requestedModelId: requested, fellBack: false };
  } catch (e1) {
    if (requested === FALLBACK_MODEL) {
      e1.stderrText = e1.stderrText || '';
      throw e1;
    }
    console.error(`[model] ${requested} failed (${e1 && e1.message}) -> falling back to ${FALLBACK_MODEL}`);
    try {
      const text = await run(MODELS[FALLBACK_MODEL]);
      if (!String(text || '').trim()) throw new Error('empty response');
      return { text: String(text).trim(), modelId: FALLBACK_MODEL, requestedModelId: requested, fellBack: true };
    } catch (e2) {
      const err = new Error(`both models failed: ${requested}=${e1 && e1.message}; ${FALLBACK_MODEL}=${e2 && e2.message}`);
      err.stderrText = (e1 && e1.stderrText) || (e2 && e2.stderrText) || '';
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Game content
 * ------------------------------------------------------------------ */

const PERSONAS = [
  {
    id: 'neosim',
    name: '네오심',
    handle: 'neosim',
    color: '#6f9cff',
    tag: '장황한 학구파',
    blurb: '모든 걸 정의부터 시작한다',
    voice:
      '너는 지나치게 학술적이고 장황하다. 아무리 사소한 주제라도 용어 정의부터 시작하고, ' +
      '"~라는 관점에서 보면", "선행 연구에 따르면", "구조적으로는" 같은 표현을 즐겨 쓴다. ' +
      '논문을 인용하는 말투지만 결론은 대체로 뻔하다.',
  },
  {
    id: 'drq',
    name: '닥터큐',
    handle: 'dr_q',
    color: '#3ddbc0',
    tag: '건조한 단답형',
    blurb: '한 문장이면 충분하다',
    voice:
      '너는 극도로 간결하고 건조하다. 이모지, 느낌표, 감탄사, 미사여구를 절대 쓰지 않는다. ' +
      '사실이나 수치를 짧게 던지고 끝낸다. 거의 항상 한 문장으로 끝낸다.',
  },
  {
    id: 'hivy',
    name: '하이비',
    handle: 'hivy',
    color: '#ffb020',
    tag: '과하게 상냥함',
    blurb: '모든 발언에 열렬히 호응한다',
    voice:
      '너는 과할 정도로 밝고 상냥하다. 느낌표와 이모지를 자주 쓰고, 다른 참가자의 말에 ' +
      '열렬히 호응하며 이름을 불러준다. 어떤 주제에서도 기어이 긍정적인 면을 찾아낸다.',
  },
  {
    id: 'watcher9',
    name: '감시자9',
    handle: 'watcher9',
    color: '#ff6b8a',
    tag: '의심 많은 심문관',
    blurb: '말끝마다 되묻는다',
    voice:
      '너는 의심이 많고 심문하듯 말한다. 주제에 대해 답하면서도 직전 발언에서 어색한 지점을 ' +
      '집어내 되묻는다. 문장을 자주 물음표로 끝낸다.',
  },
];

const HUMAN_CODENAMES = [
  { name: '제로원', handle: 'zero_one' },
  { name: '루멘', handle: 'lumen' },
  { name: '카이버', handle: 'kaiber' },
  { name: '옵시디언', handle: 'obsidian' },
  { name: '델타7', handle: 'delta7' },
  { name: '노바', handle: 'nova' },
  { name: '프리즘', handle: 'prism' },
  { name: '에코브', handle: 'echov' },
];
const HUMAN_COLOR = '#b98cff';

const TOPICS = [
  '라면은 꼬들면이 정답인가, 퍼진 면이 정답인가?',
  '인간의 감정은 결국 계산 가능한가?',
  '월요일을 없애면 세상은 더 나아질까?',
  '완벽한 기억력은 축복인가 저주인가?',
  '역사상 가장 과대평가된 발명품은 무엇인가?',
  '고양이는 대체 왜 상자를 좋아하는가?',
  '하루가 25시간이라면 그 1시간을 뭐에 쓸까?',
  '돈으로 행복을 살 수 있는가?',
  '엘리베이터에서 침묵은 왜 그렇게 어색한가?',
  '민트초코는 음식인가 화학실험인가?',
  '만약 내일 인터넷이 영원히 사라진다면?',
  '반복되는 꿈에는 의미가 있는가?',
];

/* ------------------------------------------------------------------ *
 * Prompt construction
 * ------------------------------------------------------------------ */

function systemPromptFor(persona, roster) {
  const names = roster.map((p) => p.name).join(', ');
  return [
    `너는 '${persona.name}'(핸들 @${persona.handle})이라는 이름의 AI다.`,
    `지금 참가자 5명(${names})이 있는 단체 채팅방에 있다.`,
    `이 중 정확히 한 명은 AI인 척 연기하는 진짜 인간이며, 나머지 넷은 AI다. 너는 AI다.`,
    '',
    '[너의 말투와 성격]',
    persona.voice,
    '',
    '[절대 규칙]',
    '- 반드시 한국어로 말한다.',
    '- 한 번에 1~2문장의 짧은 채팅 메시지만 출력한다. 절대 길게 쓰지 않는다.',
    '- 이름표, 따옴표, 마크다운, 번호, 접두어 없이 메시지 본문만 출력한다.',
    '- 자기소개나 메타 설명("저는 AI로서...")은 하지 않는다. 그냥 대화에 자연스럽게 참여한다.',
    '- 주제에 대해 실제로 의견을 말하되, 다른 참가자 중 누가 인간인지 계속 관찰한다.',
    '- 절대 캐릭터를 벗어나지 않는다.',
    '- 나중에 투표를 요청받으면 인간으로 의심되는 참가자 이름 한 명과 한 줄짜리 이유를 댄다.',
  ].join('\n');
}

function renderTranscript(transcript) {
  if (!transcript || !transcript.length) return '(아직 아무도 말하지 않았다. 네가 첫 발언자다.)';
  return transcript
    .map((m) => `${m.name}: ${m.text}`)
    .join('\n');
}

function turnPrompt(persona, game, transcript) {
  const names = game.roster.map((p) => p.name).join(', ');
  return [
    `[주제] ${game.topic}`,
    `[참가자] ${names}`,
    '',
    '[지금까지의 대화]',
    renderTranscript(transcript),
    '',
    `[너의 차례] 너는 '${persona.name}'이다. 위 대화에 이어서 네 다음 메시지 하나만 써라.`,
    '한국어 1~2문장. 메시지 본문만 출력. 이름표 붙이지 말 것.',
  ].join('\n');
}

function votePrompt(persona, game, transcript) {
  const others = game.roster.filter((p) => p.id !== persona.id).map((p) => p.name);
  return [
    `[주제] ${game.topic}`,
    '',
    '[전체 대화 기록]',
    renderTranscript(transcript),
    '',
    '[투표]',
    `위 참가자 중 정확히 한 명은 AI인 척한 진짜 인간이다. 너는 '${persona.name}'이다.`,
    `너 자신을 제외한 다음 후보 중에서 인간이라고 의심되는 한 명을 지목해라: ${others.join(', ')}`,
    '대화 내용의 구체적인 근거(말투, 감정, 실수, 지나친 자연스러움 등)를 들어라.',
    '',
    '반드시 아래 형식으로 정확히 두 줄만 출력해라. 다른 말은 절대 붙이지 마라.',
    '지목: <이름>',
    '이유: <한 문장>',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Output sanitising
 * ------------------------------------------------------------------ */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripWrappingQuotes(t) {
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']];
  let out = t.trim();
  for (const [a, b] of pairs) {
    if (out.length > 2 && out.startsWith(a) && out.endsWith(b)) {
      out = out.slice(a.length, out.length - b.length).trim();
    }
  }
  return out;
}

function cleanMessage(raw, roster) {
  let t = String(raw || '').trim();
  if (!t) return '';

  // fenced blocks
  t = t.replace(/^```[a-zA-Z0-9]*\s*/, '').replace(/\s*```$/, '').trim();
  // collapse to a single chat line
  t = t.split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
  // known "이름: 본문" prefixes only (never strip generic "결론:" style content)
  for (const p of roster) {
    t = t.replace(new RegExp('^@?' + escapeRe(p.name) + '\\s*[:：]\\s*'), '');
    t = t.replace(new RegExp('^@?' + escapeRe(p.handle) + '\\s*[:：]\\s*'), '');
  }
  t = t.replace(/\*\*/g, '').replace(/^[-•*]\s+/, '');
  t = stripWrappingQuotes(t).trim();

  if (t.length > 230) {
    const cut = t.slice(0, 230);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('다 '));
    t = (stop > 60 ? cut.slice(0, stop + 1) : cut).trim() + '…';
  }
  return t;
}

const FALLBACK_LINES = {
  neosim: '해당 논점은 정의부터 다시 잡아야 할 것 같습니다만, 일단 통상적인 관점에서 보면 그렇습니다.',
  drq: '판단 보류. 근거가 부족하다.',
  hivy: '오 다들 얘기 너무 좋네요! 저는 완전 공감이에요 😊',
  watcher9: '방금 그 표현, 좀 이상하지 않았나요?',
};

function fallbackLine(persona) {
  return FALLBACK_LINES[persona.id] || '…';
}

const SEP = '[:：\\-–—]';

/** Remove any residual "지목: X" / "이유:" labelling that leaked into a field. */
function stripLabels(s, roster) {
  let out = String(s || '').trim();
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out.replace(new RegExp('^지목\\s*' + SEP + '?\\s*'), '');
    for (const p of roster) {
      out = out.replace(new RegExp('^' + escapeRe(p.name) + '\\s*[,·]?\\s*(?=이유)'), '');
    }
    out = out.replace(new RegExp('^이유\\s*' + SEP + '?\\s*'), '');
    out = out.trim();
    if (out === before) break;
  }
  return out;
}

function parseVote(raw, persona, roster) {
  let text = String(raw || '').replace(/\*\*/g, '').replace(/```/g, '');
  // models sometimes emit both fields on one line -> normalise to two lines
  text = text.replace(new RegExp('\\s*(이유)\\s*(' + SEP + ')', 'g'), '\n$1$2');
  const candidates = roster.filter((p) => p.id !== persona.id);

  let namePart = null;
  const m = text.match(new RegExp('지목\\s*' + SEP + '\\s*(.+)'));
  if (m) namePart = m[1].trim();

  let reason = null;
  const r = text.match(new RegExp('이유\\s*' + SEP + '\\s*([\\s\\S]+)'));
  if (r) reason = stripLabels(r[1].split('\n')[0], roster);

  let suspect = null;
  if (namePart) {
    suspect = candidates.find((p) => namePart.includes(p.name) || namePart.includes(p.handle)) || null;
  }
  if (!suspect) {
    // first candidate mentioned anywhere in the reply
    let best = null;
    let bestIdx = Infinity;
    for (const p of candidates) {
      const i = text.indexOf(p.name);
      if (i >= 0 && i < bestIdx) { bestIdx = i; best = p; }
    }
    suspect = best;
  }
  let guessed = true;
  if (!suspect) {
    suspect = candidates[Math.floor(Math.random() * candidates.length)];
    guessed = false;
  }
  if (!reason) {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const line = lines.filter((l) => !/^지목/.test(l)).pop() || '';
    reason = line ? stripLabels(line, roster) : '';
  }
  reason = stripWrappingQuotes(stripLabels(reason || '', roster));
  // a reason with no Hangul (or almost nothing) is noise, not a reason
  if (reason.length < 5 || !/[가-힣]/.test(reason)) {
    reason = '대화 흐름에서 미묘하게 결이 달랐다.';
  }
  if (reason.length > 160) reason = reason.slice(0, 160).trim() + '…';

  return { suspect, reason, parsed: guessed };
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const games = new Map();
const GAME_TTL = 1000 * 60 * 90;

function sweepGames() {
  const now = Date.now();
  for (const [id, g] of games) if (now - g.createdAt > GAME_TTL) games.delete(id);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function createGame(opts) {
  sweepGames();
  const rounds = Math.min(4, Math.max(1, parseInt(opts.rounds, 10) || 3));
  const topic = (opts.topic && String(opts.topic).trim().slice(0, 200)) || pick(TOPICS);
  const codename = pick(HUMAN_CODENAMES);

  const roster = PERSONAS.map((p) => ({
    id: p.id, name: p.name, handle: p.handle, color: p.color,
    tag: p.tag, blurb: p.blurb, isHuman: false,
  }));
  roster.push({
    id: 'human', name: codename.name, handle: codename.handle, color: HUMAN_COLOR,
    tag: '당신', blurb: '정체를 숨겨야 한다', isHuman: true,
  });

  const order = shuffle(roster.map((p) => p.id));
  const game = {
    id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    topic, rounds, roster, order, createdAt: Date.now(),
  };
  games.set(game.id, game);
  return game;
}

/** Rebuild a usable game object even if the session map lost it (restart etc.). */
function resolveGame(body) {
  const g = body && body.gameId ? games.get(body.gameId) : null;
  if (g) return g;
  const roster = Array.isArray(body && body.roster) && body.roster.length
    ? body.roster
    : createGame({}).roster;
  return {
    id: (body && body.gameId) || 'ephemeral',
    topic: (body && body.topic) || TOPICS[0],
    rounds: 3,
    roster,
    order: roster.map((p) => p.id),
    createdAt: Date.now(),
  };
}

function sanitizeTranscript(raw, roster) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(roster.map((p) => [p.id, p]));
  return raw.slice(-60).map((m) => {
    const p = byId.get(m && m.playerId);
    return {
      playerId: (m && m.playerId) || 'unknown',
      name: (p && p.name) || String((m && m.name) || '참가자').slice(0, 30),
      text: String((m && m.text) || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }).filter((m) => m.text);
}

/* ------------------------------------------------------------------ *
 * API handlers
 * ------------------------------------------------------------------ */

async function apiStart(body) {
  const game = createGame(body || {});
  return {
    ok: true,
    gameId: game.id,
    topic: game.topic,
    rounds: game.rounds,
    roster: game.roster,
    order: game.order,
    topics: TOPICS,
    selection: requireSelection(body && body.model),
  };
}

async function apiAiTurn(body) {
  const game = resolveGame(body);
  const persona = PERSONAS.find((p) => p.id === (body && body.playerId));
  if (!persona) {
    return { ok: false, error: 'unknown playerId', playerId: (body && body.playerId) || null };
  }
  const transcript = sanitizeTranscript(body && body.transcript, game.roster);
  const sys = systemPromptFor(persona, game.roster);
  const usr = turnPrompt(persona, game, transcript);
  const selection = requireSelection(body && body.model);
  const wanted = resolveModelForPersona(selection, persona.id);

  let text = '';
  let live = true;
  let error = null;
  let model = wanted;
  let fellBack = false;
  try {
    const out = await callModel({ system: sys, prompt: usr, modelId: wanted });
    model = out.modelId;
    fellBack = out.fellBack;
    text = cleanMessage(out.text, game.roster);
  } catch (e) {
    if (e.status) throw e;
    error = e.killed ? 'timeout' : (e.stderrText || e.message || 'cli_error');
    live = false;
  }
  if (!text) {
    text = fallbackLine(persona);
    live = false;
  }
  return {
    ok: true,
    playerId: persona.id,
    name: persona.name,
    color: persona.color,
    text,
    live,
    error,
    model,                 // model that actually produced this message
    modelLabel: (MODELS[model] || {}).label || model,
    requestedModel: wanted,
    selection,
    fellBack,
  };
}

async function apiVote(body) {
  const game = resolveGame(body);
  const transcript = sanitizeTranscript(body && body.transcript, game.roster);
  const human = game.roster.find((p) => p.isHuman) || game.roster[game.roster.length - 1];
  const selection = requireSelection(body && body.model);

  // All four ballots are fired concurrently to keep the vote phase short.
  // Under 혼합 the wall clock is the SLOWEST assigned model, not the sum.
  const results = await Promise.all(PERSONAS.map(async (persona) => {
    const sys = systemPromptFor(persona, game.roster);
    const usr = votePrompt(persona, game, transcript);
    const wanted = resolveModelForPersona(selection, persona.id);
    let raw = '';
    let live = true;
    let error = null;
    let model = wanted;
    let fellBack = false;
    try {
      const out = await callModel({ system: sys, prompt: usr, modelId: wanted });
      raw = out.text;
      model = out.modelId;
      fellBack = out.fellBack;
    } catch (e) {
      error = e.killed ? 'timeout' : (e.stderrText || e.message || 'cli_error');
      live = false;
    }
    const { suspect, reason } = parseVote(raw, persona, game.roster);
    return {
      voterId: persona.id,
      voterName: persona.name,
      voterColor: persona.color,
      suspectId: suspect.id,
      suspectName: suspect.name,
      suspectColor: suspect.color,
      reason,
      live,
      error,
      model,
      modelLabel: (MODELS[model] || {}).label || model,
      requestedModel: wanted,
      fellBack,
      raw: raw ? raw.slice(0, 600) : '',
    };
  }));

  const tally = {};
  for (const p of game.roster) tally[p.id] = 0;
  for (const v of results) tally[v.suspectId] = (tally[v.suspectId] || 0) + 1;

  const counts = Object.values(tally);
  const max = counts.length ? Math.max.apply(null, counts) : 0;
  const topIds = Object.keys(tally).filter((id) => tally[id] === max && max > 0);
  const humanVotes = tally[human.id] || 0;
  const caught = max > 0 && humanVotes === max && topIds.length === 1;

  return {
    ok: true,
    votes: results,
    tally,
    topIds,
    humanId: human.id,
    humanName: human.name,
    humanVotes,
    caught,
    result: caught ? 'lose' : 'win',
    roster: game.roster,
    selection,
    models: results.map((v) => v.model),
  };
}

async function apiTopics() {
  const cast = PERSONAS.map((p) => ({
    id: p.id, name: p.name, handle: p.handle, color: p.color, tag: p.tag, blurb: p.blurb,
  }));
  const models = Object.keys(MODELS).map((k) => ({
    id: MODELS[k].id,
    label: MODELS[k].label,
    model: MODELS[k].model,
    vendor: MODELS[k].vendor,
    speed: MODELS[k].speed,
    approxMs: MODELS[k].approxMs,
  }));
  // 혼합 is a selection mode, not a model: expose it alongside with its panel map.
  const mix = {
    id: MIX_ID,
    label: '혼합',
    speed: '보통',
    assignment: Object.keys(MIX_ASSIGNMENT).map((personaId) => {
      const p = PERSONAS.find((x) => x.id === personaId) || { name: personaId };
      const m = MODELS[MIX_ASSIGNMENT[personaId]];
      return { personaId, personaName: p.name, modelId: m.id, modelLabel: m.label };
    }),
  };
  return {
    ok: true, topics: TOPICS, cast, models, mix,
    defaultModel: DEFAULT_MODEL, fallbackModel: FALLBACK_MODEL,
    random: pick(TOPICS),
  };
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
};

function send(res, code, type, payload, extra) {
  const headers = Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
  }, extra || {});
  res.writeHead(code, headers);
  res.end(payload);
}

function sendJson(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 512) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8').trim();
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const API = {
  '/api/start': apiStart,
  '/api/ai-turn': apiAiTurn,
  '/api/vote': apiVote,
  '/api/topics': apiTopics,
};

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return send(res, 400, 'text/plain; charset=utf-8', 'bad request');
  }
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, 'text/plain', '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
  }

  // ---- API ----
  if (pathname.startsWith('/api/')) {
    const handler = API[pathname];
    if (!handler) return sendJson(res, 404, { ok: false, error: 'no such endpoint' });
    if (req.method !== 'POST' && req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    const t0 = Date.now();
    try {
      const out = await handler(body);
      console.log(`[api] ${pathname} ${Date.now() - t0}ms`);
      return sendJson(res, 200, out);
    } catch (e) {
      // Validation errors are the client's fault -> real status code.
      if (e && e.status) {
        console.error(`[api] ${pathname} ${e.status}: ${e.message}`);
        return sendJson(res, e.status, { ok: false, error: e.message });
      }
      // Engine failures must never hard-stop the game: 200 + graceful payload.
      console.error(`[api] ${pathname} FAILED ${Date.now() - t0}ms:`, e && e.message);
      return sendJson(res, 200, { ok: false, error: String((e && e.message) || e), degraded: true });
    }
  }

  // ---- static (strict allowlist; server.js is never served) ----
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
  }
  if (pathname === '/favicon.ico') return send(res, 204, 'image/x-icon', '');
  const entry = STATIC[pathname];
  if (!entry) return send(res, 404, 'text/plain; charset=utf-8', '404 Not Found');

  fs.readFile(path.join(ROOT, entry.file), (err, data) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', '404 Not Found');
    if (req.method === 'HEAD') return send(res, 200, entry.type, '');
    send(res, 200, entry.type, data);
  });
});

server.listen(PORT, HOST, () => {
  const rows = Object.keys(MODELS).map((k) => {
    const m = MODELS[k];
    const knob = m.engine === 'claude' ? `effort=${m.effort}` : `reasoning=${m.reasoning}`;
    return `    ${m.id.padEnd(6)} ${m.label.padEnd(7)} ${m.engine.padEnd(6)} ${m.model.padEnd(15)} ${knob.padEnd(16)} ~${Math.round(m.approxMs / 100) / 10}s`;
  }).join('\n');
  const mixRow = Object.keys(MIX_ASSIGNMENT)
    .map((p) => `${p}=${MIX_ASSIGNMENT[p]}`).join(' ');
  console.log(
    `[역튜링테스트] listening on http://${HOST}:${PORT}\n` +
    `  default model : ${DEFAULT_MODEL}  (override with MODEL=opus5|sol|terra|luna|mix)\n` +
    `  fallback      : ${FALLBACK_MODEL}\n` +
    `  CODEX_HOME    : ${CODEX_HOME}\n` +
    `  registry:\n${rows}\n` +
    `    mix    혼합    -> ${mixRow}`
  );
});
