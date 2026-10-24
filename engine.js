/* =========================================================
   《黑历史：霓虹回档》 引擎 v1.0
   实现 PRD FR-01 节点呈现 / FR-02 分支门控 / FR-03 状态 HUD
        FR-04 结局判定 / FR-05 时间回档 / FR-06 碎片档案
        FR-07 视听与故障分级 / SR-01~SR-07 共享规则
   ========================================================= */
(function () {
'use strict';

var NODES = STORY.nodes, ENDINGS = STORY.endings, FRAGS = STORY.fragments, TERMS = STORY.terms;
var KEY = 'neon-recall-v1';
var INIT = { EXPOSURE: 20, REP: 50, SYNC: 100, CREDIT: 300 };
var MAXV = { EXPOSURE: 100, REP: 100, SYNC: 100, CREDIT: 9999 };
var META = [
  { k: 'EXPOSURE', zh: '曝光度', warnHi: 70, critHi: 90, badUp: true },
  { k: 'REP', zh: '信誉', warnLo: 30, critLo: 15 },
  { k: 'SYNC', zh: '记忆完整度', warnLo: 40, critLo: 20 },
  { k: 'CREDIT', zh: '信用点', warnLo: 50, critLo: -1, scale: 1000 }
];
var REWIND_COST = 80, REPAIR_COST = 150, REPAIR_SYNC = 30, REWIND_MAX = 3;
var LVNAME = ['正常', '警戒', '危险'];

/* ---------------- 持久化 ---------------- */
var mem = null, storeOK = true;
function ls() { try { var t = '__t'; localStorage.setItem(t, t); localStorage.removeItem(t); return localStorage; } catch (e) { storeOK = false; return null; } }
var LS = ls();
function loadProf() {
  var raw = LS ? LS.getItem(KEY) : mem;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function saveProf() {
  var raw = JSON.stringify(prof);
  if (LS) { try { LS.setItem(KEY, raw); return; } catch (e) { storeOK = false; } }
  mem = raw;
}
function blankProf() {
  return {
    v: 1, gallery: {}, obtained: [], repaired: [], runs: 0,
    settings: { fs: 1, calm: false, scan: true, audio: true, sens: true },
    slots: { auto: null, s1: null, s2: null, s3: null }
  };
}
var prof = loadProf() || blankProf();
saveProf();

/* ---------------- 运行时状态 ---------------- */
var G = null;
function newRun() {
  return {
    node: 'N0-01', S: { EXPOSURE: 20, REP: 50, SYNC: 100, CREDIT: 300 },
    flags: {}, held: [], rewinds: 0, rewindLeft: REWIND_MAX,
    cps: [], path: [], warned: {}, started: Date.now()
  };
}

/* ---------------- DOM ---------------- */
function $(id) { return document.getElementById(id); }
var elHud = $('hud'), elMain = $('main'), elTitle = $('title'), elStats = $('stats'),
  elClock = $('clock'), elClockBox = $('clockbox'), elChlbl = $('chlbl'), elSp = $('speaker'),
  elTx = $('text'), elOpts = $('opts'), elMood = $('mood'), elToast = $('toast'),
  elTip = $('tip'), elWipe = $('wipe'), elBlack = $('blackout'), elFlash = $('flash'),
  elFragChip = $('btn-frag'), elRwChip = $('btn-rewind');

/* ---------------- 音频（FR-07） ---------------- */
var AC = null;
function ac() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; } } return AC; }
function sfx(kind) {
  if (!prof.settings.audio) return;
  var c = ac(); if (!c) return;
  if (c.state === 'suspended') c.resume();
  var P = { tick: [760, 'square', .035, .028], pick: [420, 'triangle', .1, .07], warn: [170, 'sawtooth', .3, .06],
    frag: [620, 'sine', .38, .06], rw: [110, 'sawtooth', .55, .08], end: [95, 'sine', 1.0, .09],
    lock: [220, 'square', .07, .03] }[kind];
  if (!P) return;
  try {
    var o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.type = P[1]; o.frequency.setValueAtTime(P[0], t);
    if (kind === 'pick') o.frequency.exponentialRampToValueAtTime(1180, t + .08);
    if (kind === 'rw') o.frequency.exponentialRampToValueAtTime(2200, t + .5);
    if (kind === 'frag') o.frequency.exponentialRampToValueAtTime(1240, t + .32);
    if (kind === 'end') o.frequency.exponentialRampToValueAtTime(42, t + .9);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(P[3], t + .012);
    g.gain.exponentialRampToValueAtTime(.0001, t + P[2]);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + P[2] + .05);
  } catch (e) { }
}

/* ---------------- 提示条 ---------------- */
function toast(txt, cls, ms, onClick) {
  var d = document.createElement('div');
  d.className = 'msg' + (cls ? ' ' + cls : '');
  d.textContent = txt;
  if (onClick) { d.style.cursor = 'pointer'; d.onclick = function () { onClick(); d.remove(); }; }
  elToast.appendChild(d);
  requestAnimationFrame(function () { d.classList.add('in'); });
  setTimeout(function () { d.classList.remove('in'); setTimeout(function () { d.remove(); }, 340); }, ms || 2400);
}

/* ---------------- 工具 ---------------- */
function clamp(k, v) { return Math.max(0, Math.min(MAXV[k], v)); }
function levelOf(m, v) {
  if (m.badUp) { if (v >= m.critHi) return 2; if (v >= m.warnHi) return 1; return 0; }
  if (m.critLo >= 0 && v <= m.critLo) return 2;
  if (m.warnLo && v <= m.warnLo) return 1;
  return 0;
}
function fmtClock(min) {
  var m = Math.max(0, Math.round(min)), h = Math.floor(m / 60), mm = m % 60;
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(h) + ':' + p(mm) + ':00';
}
function fragCount() { return prof.repaired.length; }
function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

/* ---------------- 故障等级（FR-07） ---------------- */
function glitchLevel() {
  if (!G) return 0;
  var s = G.S, lv = 0, ch = (NODES[G.node] || {}).ch;
  if (s.EXPOSURE >= 70 || s.REP <= 30 || s.SYNC <= 40 || s.CREDIT <= 50) lv = 1;
  if (s.EXPOSURE >= 90 || s.REP <= 15 || s.SYNC <= 20) lv = 2;
  if (s.EXPOSURE >= 90 || s.REP <= 10 || s.SYNC <= 10 || ch === 'CH-05') lv = 3;
  return lv;
}
function paintGlitch() {
  var lv = prof.settings.calm ? 0 : glitchLevel();
  document.body.className = document.body.className.replace(/\bL\d\b/g, '').trim();
  document.body.classList.add('L' + lv);
  document.body.classList.toggle('calm', !!prof.settings.calm);
  document.documentElement.style.setProperty('--scan', prof.settings.scan ? (prof.settings.calm ? .2 : .5) : 0);
}

/* ---------------- HUD（FR-03） ---------------- */
function renderHUD(deltas) {
  elStats.innerHTML = META.map(function (m) {
    var v = G.S[m.k], lv = levelOf(m, v);
    var cls = lv === 2 ? 'crit' : lv === 1 ? 'warn' : (m.badUp ? '' : 'good');
    var pct = Math.max(0, Math.min(100, v / (m.scale || 100) * 100));
    return '<div class="stat ' + cls + '" data-k="' + m.k + '">' +
      '<div class="lb"><span>' + m.k + '</span><span>' + m.zh + '</span></div>' +
      '<div class="vl">' + v + ' <span class="lv">' + LVNAME[lv] + '</span></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
  }).join('');
  var n = NODES[G.node] || {};
  elClock.textContent = fmtClock(n.t || 0);
  elClockBox.classList.toggle('urgent', (n.t || 0) <= 360);
  elFragChip.textContent = 'F ' + fragCount() + '/7';
  elFragChip.classList.toggle('pulse', fragCount() >= 7);
  elRwChip.textContent = 'RW ' + G.rewindLeft;
  paintGlitch();
  if (deltas) deltas.forEach(function (d) { floatDelta(d.k, d.txt, d.good); });
  checkWarn();
}
function floatDelta(k, txt, good) {
  var el = elStats.querySelector('[data-k="' + k + '"]'); if (!el) return;
  var d = document.createElement('div'); d.className = 'delta';
  d.style.color = good ? 'var(--acid)' : 'var(--red)';
  d.textContent = txt; el.appendChild(d);
  var t0 = null;
  function step(t) {
    if (!t0) t0 = t;
    var p = Math.min(1, (t - t0) / 900);
    d.style.transform = 'translateY(' + (-20 * p) + 'px)';
    d.style.opacity = String(1 - p);
    if (p < 1) requestAnimationFrame(step); else d.remove();
  }
  requestAnimationFrame(step);
}
function checkWarn() {
  META.forEach(function (m) {
    var lv = levelOf(m, G.S[m.k]);
    if (lv === 2 && !G.warned[m.k]) {
      G.warned[m.k] = 1;
      flash();
      var msg = { EXPOSURE: '警告：曝光度接近共识层广播阈值', REP: '警告：执照信用等级即将注销',
        SYNC: '警告：记忆完整度濒临崩解', CREDIT: '警告：信用点即将耗尽' }[m.k];
      toast(msg, 'up', 3200); sfx('warn');
    }
  });
}
function flash() {
  if (prof.settings.calm) return;
  elFlash.style.transition = 'none'; elFlash.style.opacity = '.85';
  requestAnimationFrame(function () { elFlash.style.transition = 'opacity .7s'; elFlash.style.opacity = '0'; });
}

/* ---------------- 打字机（FR-01） ---------------- */
var typing = null;
function tokenize(s) {
  var keys = Object.keys(TERMS).sort(function (a, b) { return b.length - a.length; });
  var out = [], i = 0, buf = '';
  while (i < s.length) {
    var hit = null;
    for (var j = 0; j < keys.length; j++) { if (s.substr(i, keys[j].length) === keys[j]) { hit = keys[j]; break; } }
    if (hit) { if (buf) { out.push({ p: buf }); buf = ''; } out.push({ t: hit }); i += hit.length; }
    else { buf += s.charAt(i); i++; }
  }
  if (buf) out.push({ p: buf });
  return out;
}
function typeInto(el, text, done) {
  clearInterval(typing);
  var toks = tokenize(text), flat = [];
  toks.forEach(function (tk, ti) {
    var cs = (tk.p !== undefined ? tk.p : tk.t).split('');
    cs.forEach(function (c) { flat.push({ c: c, i: ti }); });
  });
  el.innerHTML = '';
  var spans = toks.map(function (tk) {
    var sp;
    if (tk.t) { sp = document.createElement('b'); sp.className = 'term'; sp.setAttribute('data-term', tk.t); }
    else { sp = document.createElement('span'); }
    el.appendChild(sp); return sp;
  });
  var cur = document.createElement('span'); cur.className = 'cur'; el.appendChild(cur);
  var reduce = prof.settings.calm || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduce || flat.length === 0) {
    flat.forEach(function (f) { spans[f.i].appendChild(document.createTextNode(f.c)); });
    cur.remove(); typing = null; el._skip = null; done && done(); return;
  }
  var i = 0;
  typing = setInterval(function () {
    var step = 1;
    while (step-- > 0 && i < flat.length) { var f = flat[i++]; spans[f.i].appendChild(document.createTextNode(f.c)); }
    if (i >= flat.length) { clearInterval(typing); typing = null; cur.remove(); done && done(); }
  }, 1000 / 30);
  el._skip = function () {
    clearInterval(typing); typing = null;
    spans.forEach(function (s) { s.textContent = ''; });
    flat.forEach(function (f) { spans[f.i].appendChild(document.createTextNode(f.c)); });
    cur.remove(); done && done();
  };
}

/* ---------------- 门控（FR-02） ---------------- */
function gate(o) {
  if (o.need) {
    if (prof.obtained.indexOf(o.need) < 0 && G.held.indexOf(o.need) < 0)
      return { ok: false, why: '需持有碎片 ' + o.need };
  }
  if (o.req) {
    var ks = Object.keys(o.req);
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i], v = o.req[k];
      if (k === 'FRAG') { if (fragCount() < v) return { ok: false, why: '需 FRAGMENT ≥ ' + v + '（当前 ' + fragCount() + '）' }; }
      else if (G.S[k] < v) return { ok: false, why: '需 ' + k + ' ≥ ' + v + '（当前 ' + G.S[k] + '）' };
    }
  }
  if (o.max) {
    var mk = Object.keys(o.max);
    for (var j = 0; j < mk.length; j++) {
      var kk = mk[j]; if (G.S[kk] > o.max[kk]) return { ok: false, why: '需 ' + kk + ' ≤ ' + o.max[kk] + '（当前 ' + G.S[kk] + '）' };
    }
  }
  if (o.cost && G.S.CREDIT < o.cost) return { ok: false, why: '还需 ' + (o.cost - G.S.CREDIT) + ' CR' };
  return { ok: true };
}

/* ---------------- 节点渲染 ---------------- */
var timerId = null;
function goto(id, quiet) {
  clearInterval(timerId); timerId = null; TS = null;
  var n = NODES[id];
  if (!n) { showLost(id); return; }
  G.node = id;
  if (n.cp) {
    G.cps.push({ id: 'CP-' + (G.cps.length < 9 ? '0' : '') + (G.cps.length + 1), node: id, ch: n.ch, t: n.t,
      snap: { S: JSON.parse(JSON.stringify(G.S)), flags: JSON.parse(JSON.stringify(G.flags)), held: G.held.slice(), rewinds: G.rewinds },
      locked: false });
    writeSlot('auto');
    if (!quiet) toast('检查点已激活 · ' + id, '', 1600);
  }
  elMood.className = n.mood || '';
  /* SR-05：敏感桥段一次性提示（每个节点每局仅提示一次） */
  if (n.sens && prof.settings.sens && !G.warned['sens_' + id]) {
    G.warned['sens_' + id] = 1;
    toast('内容提示 · ' + n.sens, 'warn', 4000);
  }
  elChlbl.innerHTML = STORY.chapters[n.ch] + ' <span class="nid">// ' + id + (n.cp ? ' · CP' : '') + '</span>';
  elSp.textContent = (n.sp && n.sp !== '旁白') ? n.sp : '';
  elSp.style.display = (n.sp && n.sp !== '旁白') ? 'block' : 'none';
  renderHUD();
  elOpts.innerHTML = '';
  typeInto(elTx, n.tx, function () { n.fin ? finishRun() : renderOpts(n); });
}
function showLost(id) {
  elTx.innerHTML = '<span style="color:var(--red);font-family:var(--mono)">NODE_LOST · 码流损坏（' + esc(id) + '）</span>';
  elOpts.innerHTML = '';
  var b = document.createElement('button'); b.className = 'btn mg'; b.textContent = '返回上一检查点';
  b.onclick = function () { backToLastCP(true); };
  elOpts.appendChild(b);
}

/* ---------------- 选项渲染（FR-02） ---------------- */
function renderOpts(n) {
  elOpts.innerHTML = '';
  if (!n.opts || !n.opts.length) { finishRun(); return; }
  var visible = n.opts.filter(function (o) { return !o.hide || gate(o).ok; });
  var enabled = visible.filter(function (o) { return gate(o).ok; });

  /* 死路 / 破产清算（SR-02 第 3 级） */
  if (!enabled.length) {
    var allCost = visible.length > 0 && visible.every(function (o) { return !!o.cost; });
    if (allCost) { showEnd('E-09', '唯一通路为消耗型选项且余额不足（CREDIT ' + G.S.CREDIT + '）'); return; }
    var d = document.createElement('div');
    d.style.cssText = 'font-family:var(--mono);font-size:12px;color:var(--amber);border:1px dashed rgba(255,176,32,.45);padding:11px 13px';
    d.textContent = 'DEAD_END · 无可用通路（剧本缺陷已降级处理）';
    elOpts.appendChild(d);
    var bb = document.createElement('button'); bb.className = 'btn'; bb.style.marginTop = '9px';
    bb.textContent = '返回上一检查点（不消耗回档）';
    bb.onclick = function () { backToLastCP(true); };
    elOpts.appendChild(bb);
    return;
  }

  /* 限时节点 */
  var timed = null;
  n.opts.forEach(function (o) { if (o.sec && !timed) timed = o; });

  visible.forEach(function (o, idx) {
    var g = gate(o), b = document.createElement('button');
    b.className = 'opt' + (o.sec ? ' timed' : '') + (o.hide ? ' decrypt' : '');
    var meta = '';
    if (!g.ok) meta = '<span class="lock">⛔ ' + esc(g.why) + '</span>';
    else if (o.cost) meta = '<span class="cost">−' + o.cost + ' CR</span>';
    else if (o.irr) meta = '<span class="irr">不可逆</span>';
    if (o.irr && g.ok && o.cost) meta = '<span class="cost">−' + o.cost + ' CR</span> <span class="irr">不可逆</span>';
    b.innerHTML = '<span class="kb">' + (idx + 1) + '</span><span class="tx">' + esc(o.t) + '</span>' +
      (meta ? '<span class="meta">' + meta + '</span>' : '');
    if (!g.ok) { b.disabled = true; b.title = g.why; }
    else {
      b.onclick = function () { sfx('tick'); pick(o); };
      b.onmouseenter = function () { sfx('tick'); };
    }
    elOpts.appendChild(b);
  });

  if (timed && gate(timed).ok) {
    if (prof.settings.calm) return;           /* SR-06：减弱动效时取消时限 */
    var bar = document.createElement('div'); bar.id = 'timerbar'; bar.innerHTML = '<i></i>';
    var lbl = document.createElement('div'); lbl.id = 'timerlbl';
    elOpts.insertBefore(lbl, elOpts.firstChild);
    elOpts.insertBefore(bar, lbl.nextSibling);
    startTimer(timed, bar.firstChild, lbl);
  }
}

/* 限时抉择：切到后台暂停，返回后继续（SR-07） */
var TS = null;
function startTimer(o, fill, lbl) {
  clearInterval(timerId);
  TS = { o: o, left: o.sec, fill: fill, lbl: lbl };
  paintTimer();
  timerId = setInterval(function () {
    TS.left--; paintTimer();
    if (TS.left <= 3 && TS.left > 0) sfx('lock');
    if (TS.left <= 0) {
      clearInterval(timerId); timerId = null;
      var target = gate(TS.o).ok ? TS.o : firstEnabled();
      TS = null;
      toast('倒计时归零 · 自动执行', 'warn', 1800);
      if (target) pick(target);
    }
  }, 1000);
}
function paintTimer() {
  if (!TS) return;
  TS.fill.style.width = Math.max(0, TS.left / TS.o.sec * 100) + '%';
  TS.lbl.textContent = 'TIMEOUT ' + TS.left + 's → 未选择将自动执行';
}
function pauseTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }
function resumeTimer() {
  if (!TS || timerId) return;
  timerId = setInterval(function () {
    TS.left--; paintTimer();
    if (TS.left <= 3 && TS.left > 0) sfx('lock');
    if (TS.left <= 0) {
      clearInterval(timerId); timerId = null;
      var target = gate(TS.o).ok ? TS.o : firstEnabled();
      TS = null; toast('倒计时归零 · 自动执行', 'warn', 1800);
      if (target) pick(target);
    }
  }, 1000);
}
function firstEnabled() {
  var b = elOpts.querySelector('.opt:not(:disabled)');
  if (!b) return null;
  var n = NODES[G.node], i = Array.prototype.indexOf.call(elOpts.querySelectorAll('.opt'), b);
  var vis = n.opts.filter(function (o) { return !o.hide || gate(o).ok; });
  return vis[i] || null;
}

/* ---------------- 选择与结算 ---------------- */
function pick(o) {
  clearInterval(timerId); timerId = null; TS = null;
  elOpts.innerHTML = '';
  if (o.irr) {
    confirmBox('IRREVERSIBLE', '写入共识层', '此选择将写入共识层，无法通过回档撤销。', function () { commit(o); }, '确认写入');
    return;
  }
  commit(o);
}
function commit(o) {
  if (o.set) Object.keys(o.set).forEach(function (k) { G.flags[k] = o.set[k]; });
  if (o.sens && prof.settings.sens) toast('内容提示 · ' + o.sens, 'warn', 3600);
  var deltas = applyFx(o.fx);
  G.path.push({ id: G.node, o: o.t, fx: o.fx, irr: !!o.irr });
  if (o.irr) { G.cps.forEach(function (c) { c.locked = true; }); toast('已写入共识层 · 之前的检查点已锁定', 'warn', 2600); }
  if (o.frag) obtainFrag(o.frag);
  renderHUD(deltas);

  var hard = judgeHard();
  if (hard) { setTimeout(function () { showEnd(hard[0], hard[1]); }, 420); return; }
  if (o.end) {
    /* 直接结局：硬结局类需把对应变量钳到边界，保证结算界面与结局描述一致 */
    if (o.end === 'E-06') G.S.EXPOSURE = 100;
    if (o.end === 'E-07') G.S.REP = 0;
    if (o.end === 'E-08') G.S.SYNC = 0;
    renderHUD();
    setTimeout(function () { showEnd(o.end, '节点指定结局 · ' + o.end); }, 420);
    return;
  }

  elWipe.classList.remove('go'); void elWipe.offsetWidth; elWipe.classList.add('go');
  setTimeout(function () { goto(o.to); }, prof.settings.calm ? 0 : 180);
}
function applyFx(fx) {
  var out = [];
  if (!fx) return out;
  ['EXPOSURE', 'REP', 'SYNC', 'CREDIT'].forEach(function (k) {
    if (fx[k] === undefined) return;
    var before = G.S[k], raw = before + fx[k], after = clamp(k, raw), eff = after - before;
    if (!eff) return;
    G.S[k] = after;
    var m = META.filter(function (x) { return x.k === k; })[0];
    var good = m.badUp ? eff < 0 : eff > 0;
    out.push({ k: k, txt: (eff > 0 ? '+' : '') + eff, good: good });
  });
  return out;
}
function judgeHard() {
  var s = G.S;
  if (s.EXPOSURE >= 100) return ['E-06', 'EXPOSURE 抵达 100 · 硬结局触发'];
  if (s.SYNC <= 0) return ['E-08', 'SYNC 归零 · 硬结局触发'];
  if (s.REP <= 0) return ['E-07', 'REP 归零 · 硬结局触发'];
  return null;
}

/* ---------------- 结局判定链（SR-02 / FR-04） ----------------
   顺序：硬结局 → 动作触发 → 资源死锁 → 终章条件求值 → 兜底
   条件求值顺序：E-01 → E-11 → E-03 → E-05 → E-04 → E-02 → E-06 → E-07 → E-12 */
function finishRun() {
  elOpts.innerHTML = '';
  var s = G.S, hard = judgeHard();
  if (hard) { showEnd(hard[0], hard[1]); return; }
  var fc = fragCount();
  if (fc >= 7 && s.SYNC >= 60 && !G.flags.soldChe) return showEnd('E-01', 'FRAGMENT=7 且 SYNC≥60 且未出卖阿澈');
  if (fc >= 7 && s.SYNC < 30) return showEnd('E-11', 'FRAGMENT=7 且 SYNC<30');
  if (G.flags.pub && s.REP >= 80) return showEnd('E-03', '公开承认 且 REP≥80');
  if (G.flags.left && fc >= 2) return showEnd('E-05', '与阿澈离开 且 FRAGMENT≥2');
  if (G.flags.framed && s.SYNC >= 40) return showEnd('E-04', '覆盖为他人档案 且 SYNC≥40');
  if (G.flags.surrender || (G.flags.delegate && s.REP <= 30)) return showEnd('E-02', G.flags.surrender ? '将控制权交给守墓人' : '完成删档委托线 且 REP≤30');
  if (G.flags.pub) return showEnd('E-06', '主动公开但 REP ' + s.REP + ' < 80 · 城市没有相信你',
    '更优版本 E-03「霓虹圣徒」：公开承认时 REP 需 ≥ 80');
  if (G.flags.framed) return showEnd('E-07', '嫁祸失败 · SYNC ' + s.SYNC + ' < 40 · 伪造在归档校验中崩解',
    '更优版本 E-04「二次剪辑」：覆盖档案时 SYNC 需 ≥ 40');
  showEnd('E-12', '判定链兜底 · FALLBACK',
    '终章四条主选择分别通向 E-03/E-06（公开）、E-04/E-07（嫁祸）、E-05（离开，需 FRAGMENT≥2）、E-02（交出控制权）；集齐并修复 7 枚碎片可开启 E-01 真结局');
}
function showEnd(code, why, hint) {
  clearInterval(timerId); timerId = null; TS = null; clearInterval(typing); typing = null;
  var e = ENDINGS[code], first = !prof.gallery[code];
  var rec = prof.gallery[code] || { n: 0, last: 0 };
  rec.n++; rec.last = Date.now(); rec.why = why; prof.gallery[code] = rec;
  prof.runs++; saveProf();
  sfx('end');
  elBlack.classList.add('on');
  setTimeout(function () {
    elBlack.classList.remove('on');
    var key = G.path.filter(function (p) { return p.irr || p.fx && bigFx(p.fx) || p.o; }).slice(-8);
    var cls = e.ty === 'true' ? ' true-e' : e.ty === 'hidden' ? ' hid' : '';
    $('end-box').innerHTML =
      '<div class="ending' + cls + '">' +
      '<div class="code">ENDING ' + code + (first ? ' · NEW' : ' · ×' + rec.n) + '</div>' +
      '<div class="nm gl">' + esc(e.n) + '</div>' +
      '<div class="ds">' + esc(e.d) + '</div>' +
      '<div class="conds">' + e.c.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('') + '</div>' +
      '<div class="replay"><div class="h">// PATH REPLAY · 路径回放</div>' +
      (key.length ? key.map(function (p) { return '<div>· ' + esc(p.id) + ' — ' + esc(p.o) + '</div>'; }).join('') : '<div>· 无记录</div>') +
      '<div class="fin">终态 EXPOSURE ' + G.S.EXPOSURE + ' · REP ' + G.S.REP + ' · SYNC ' + G.S.SYNC + ' · CREDIT ' + G.S.CREDIT + ' · FRAGMENT ' + fragCount() + '/7 · 回档 ' + G.rewinds + ' 次</div>' +
      '<div class="fin" style="color:var(--dim)">判定依据：' + esc(why) + '</div>' +
      (hint ? '<div class="fin" style="color:var(--acid)">▸ ' + esc(hint) + '</div>' : '') + '</div>' +
      '</div>' +
      '<div class="row" style="margin-top:20px;justify-content:center">' +
      '<button class="btn mg" id="e-again">回档至序章 · 新一局</button>' +
      '<button class="btn" id="e-gal">结局图鉴</button>' +
      '<button class="btn ac" id="e-frag">碎片档案</button>' +
      '<button class="btn vi" id="e-share">生成分享图</button>' +
      '<button class="btn" id="e-title">返回标题</button></div>';
    openOv('ov-end');
    $('e-again').onclick = function () { closeOv('ov-end'); startNew(); };
    $('e-gal').onclick = function () { openGallery(); };
    $('e-frag').onclick = function () { openFrags(); };
    $('e-share').onclick = function () { shareCard(code); };
    $('e-title').onclick = function () { closeOv('ov-end'); toTitle(); };
  }, prof.settings.calm ? 60 : 560);
}
function bigFx(fx) {
  return Object.keys(fx).some(function (k) { return Math.abs(fx[k]) >= 15; });
}

/* ---------------- 回档（FR-05） ---------------- */
function openRewind() {
  if (!G) return;
  $('rw-info').innerHTML = '余量 <b style="color:var(--acid)">' + G.rewindLeft + '/' + REWIND_MAX + '</b> · 信用点 <b style="color:var(--cyan)">' + G.S.CREDIT + '</b> · 当前节点 <b style="color:var(--mag)">' + G.node + '</b>';
  var cur = G.cps.length - 1;
  $('rw-tl').innerHTML = G.cps.map(function (c, i) {
    var cls = c.locked ? 'locked' : i < cur ? 'done' : i === cur ? 'cur' : 'future';
    var dis = c.locked || i >= cur || G.rewindLeft <= 0 || G.S.CREDIT < REWIND_COST;
    return '<button class="cp ' + cls + '" data-i="' + i + '" ' + (dis ? 'disabled' : '') + '>' +
      '<div class="pt"></div><div class="lb">' + c.id + '<br>' + fmtClock(c.t).slice(0, 5) + '<br>' + c.node + '</div></button>';
  }).join('') || '<span class="dim">尚无检查点</span>';
  $('rw-msg').textContent = '';
  Array.prototype.forEach.call($('rw-tl').querySelectorAll('.cp'), function (b) {
    b.onclick = function () { doRewind(+b.dataset.i); };
    b.onmouseenter = function () {
      var c = G.cps[+b.dataset.i];
      $('rw-msg').textContent = c.id + ' · ' + c.node + ' · ' + STORY.chapters[c.ch] + ' ' + fmtClock(c.t) +
        ' — EXP' + c.snap.S.EXPOSURE + ' REP' + c.snap.S.REP + ' SYN' + c.snap.S.SYNC + ' CR' + c.snap.S.CREDIT +
        (c.locked ? ' · 不可逆锁定' : '');
    };
  });
  openOv('ov-rewind');
}
function doRewind(i) {
  var c = G.cps[i];
  if (!c || c.locked) { $('rw-msg').innerHTML = '<span style="color:var(--red)">该检查点位于不可逆选择之前，已锁定</span>'; sfx('lock'); return; }
  if (G.rewindLeft <= 0) { $('rw-msg').innerHTML = '<span style="color:var(--amber)">回档余量耗尽 · 仅可读取存档槽</span>'; sfx('lock'); return; }
  if (G.S.CREDIT < REWIND_COST) { $('rw-msg').innerHTML = '<span style="color:var(--amber)">信用点不足 · 还需 ' + (REWIND_COST - G.S.CREDIT) + ' CR</span>'; sfx('lock'); return; }
  confirmBox('REWIND', '执行时间回档', '将还原至 ' + c.id + '（' + c.node + '）。代价：−' + REWIND_COST + ' CR，回档余量 −1。碎片修复费用不退还。', function () {
    G.rewinds++; G.rewindLeft--;
    G.S = JSON.parse(JSON.stringify(c.snap.S));
    G.flags = JSON.parse(JSON.stringify(c.snap.flags));
    G.held = c.snap.held.slice();
    G.S.CREDIT = clamp('CREDIT', G.S.CREDIT - REWIND_COST);
    G.cps = G.cps.slice(0, i + 1);
    G.path = G.path.slice(0, Math.max(0, G.path.length - 1));
    sfx('rw');
    closeOv('ov-rewind');
    toast('REWIND → ' + c.id + '（第 ' + G.rewinds + ' 次）', '', 2200);
    if (c.ch === 'CH-05' && G.rewinds >= REWIND_MAX) { showEnd('E-10', '终章内第 ' + G.rewinds + ' 次回档 · 动作触发'); return; }
    goto(c.node, true);
  }, '执行回档');
}
function backToLastCP(free) {
  if (!G.cps.length) { startNew(); return; }
  var c = G.cps[G.cps.length - 1];
  G.S = JSON.parse(JSON.stringify(c.snap.S));
  G.flags = JSON.parse(JSON.stringify(c.snap.flags));
  G.held = c.snap.held.slice();
  if (!free) { G.rewinds++; G.rewindLeft--; G.S.CREDIT = clamp('CREDIT', G.S.CREDIT - REWIND_COST); }
  goto(c.node, true);
}

/* ---------------- 碎片档案（FR-06） ---------------- */
function obtainFrag(id) {
  if (G.held.indexOf(id) < 0) G.held.push(id);
  if (prof.obtained.indexOf(id) < 0) { prof.obtained.push(id); saveProf(); }
  sfx('frag');
  toast('获得碎片 ' + id + ' · ' + FRAGS[id].n + '（已存入档案，点击查看）', 'fg', 4200, function () { openFrags(); });
}
function openFrags() {
  $('frag-cnt').textContent = '已修复 ' + fragCount() + '/7 · 本局持有 ' + (G ? G.held.length : 0);
  $('frags').innerHTML = Object.keys(FRAGS).map(function (id) {
    var f = FRAGS[id], ob = prof.obtained.indexOf(id) >= 0, rp = prof.repaired.indexOf(id) >= 0;
    var cls = !ob ? 'locked' : rp ? 'fixed' : 'corrupt';
    var st = !ob ? '未发现' : rp ? '已修复' : '已损坏';
    return '<button class="frag ' + cls + '" data-f="' + id + '"><div class="fid">' + id + '</div>' +
      '<div class="fn">' + (ob ? esc(f.n) : '█ █ █ █') + '</div><div class="st">' + st + '</div></button>';
  }).join('');
  Array.prototype.forEach.call($('frags').querySelectorAll('.frag'), function (b) {
    b.onclick = function () { fragDetail(b.dataset.f); };
  });
  $('fdetail').innerHTML = '<div class="fdetail"><div class="src">// ARCHIVE</div><p class="dim" style="margin:0">点击碎片查看详情或修复损坏码流。</p></div>';
  openOv('ov-frag');
}
function fragDetail(id) {
  var f = FRAGS[id], ob = prof.obtained.indexOf(id) >= 0, rp = prof.repaired.indexOf(id) >= 0;
  if (!ob) { $('fdetail').innerHTML = '<div class="fdetail"><div class="src">// ' + id + '</div><p class="dim" style="margin:0">未发现。该碎片位于互斥分支中，需在其他路线探索。来源：' + esc(f.src) + '</p></div>'; return; }
  var canFix = !rp, why = '';
  if (canFix) {
    if (!G) why = '需在剧情中修复（请先开始游戏）';
    else if (G.S.CREDIT < REPAIR_COST) why = '信用点不足 · 还需 ' + (REPAIR_COST - G.S.CREDIT) + ' CR';
    else if (G.S.SYNC < REPAIR_SYNC) why = '记忆完整度不足以承载该码流（需 SYNC ≥ ' + REPAIR_SYNC + '，当前 ' + G.S.SYNC + '）';
  }
  $('fdetail').innerHTML = '<div class="fdetail"><div class="src">// ' + id + ' · ' + esc(f.n) + ' &nbsp;·&nbsp; SOURCE ' + esc(f.src) + '</div>' +
    (rp ? '<p class="q">' + esc(f.q) + '</p>' + (f.cf ? '<p class="cf">⚠ 矛盾点：' + esc(f.cf) + '</p>' : '')
      : '<p class="q" style="color:#5f6d82">码流损坏 · 仅可辨识残句：<span style="color:var(--mag)">' + esc(f.q.slice(0, 14)) + '…</span></p>') +
    (canFix ? '<div class="row" style="margin-top:14px"><button class="btn ac" id="f-fix" ' + (why ? 'disabled' : '') + '>修复 −' + REPAIR_COST + ' CR</button>' +
      (why ? '<span class="dim" style="color:var(--amber);font-family:var(--mono);font-size:11.5px">' + esc(why) + '</span>' : '') + '</div>' : '') +
    '</div>';
  var b = $('f-fix');
  if (b) b.onclick = function () {
    G.S.CREDIT = clamp('CREDIT', G.S.CREDIT - REPAIR_COST);
    prof.repaired.push(id); saveProf(); sfx('frag'); renderHUD();
    toast('碎片 ' + id + ' 已修复 · FRAGMENT ' + fragCount() + '/7', 'dn', 2600);
    openFrags(); fragDetail(id);
  };
}

/* ---------------- 图鉴（FR-04） ---------------- */
function openGallery() {
  var ks = Object.keys(ENDINGS), got = ks.filter(function (k) { return prof.gallery[k]; }).length;
  $('gal-cnt').textContent = got + '/' + ks.length + ' 已达成 · 共 ' + prof.runs + ' 周目';
  $('gal').innerHTML = ks.map(function (k) {
    var e = ENDINGS[k], u = !!prof.gallery[k];
    var cls = (u ? '' : 'locked ') + (e.ty === 'true' ? 'true-e ' : e.ty === 'hidden' ? 'hid ' : '');
    return '<button class="gc ' + cls + '" data-e="' + k + '">' +
      (u && prof.gallery[k].n > 1 ? '<span class="badge">×' + prof.gallery[k].n + '</span>' : '') +
      (e.ty === 'true' ? '<span class="badge">★真结局</span>' : '') +
      '<div class="c">' + k + '</div><div class="n">' + (u ? esc(e.n) : '█ █ █ █') + '</div>' +
      '<div class="s">' + (u ? esc(e.c[0]) : esc(e.hint)) + '</div></button>';
  }).join('');
  Array.prototype.forEach.call($('gal').querySelectorAll('.gc'), function (b) {
    b.onclick = function () { galDetail(b.dataset.e); };
  });
  $('gal-detail').innerHTML = '';
  openOv('ov-gal');
}
function galDetail(k) {
  var e = ENDINGS[k], u = !!prof.gallery[k];
  $('gal-detail').innerHTML = '<div class="ending' + (e.ty === 'true' ? ' true-e' : e.ty === 'hidden' ? ' hid' : '') + '">' +
    '<div class="code">ENDING ' + k + (u ? '' : ' · LOCKED') + '</div>' +
    '<div class="nm">' + (u ? esc(e.n) : '???') + '</div>' +
    '<div class="ds">' + (u ? esc(e.d) : '未解锁。线索：' + esc(e.hint) + '。') + '</div>' +
    '<div class="conds">' + e.c.map(function (c) { return '<span>' + (u ? esc(c) : '???') + '</span>'; }).join('') + '</div>' +
    (u && prof.gallery[k].why ? '<div class="replay"><div class="h">// 最近一次判定依据</div><div>' + esc(prof.gallery[k].why) + '</div>' +
      '<div class="fin">达成 ' + prof.gallery[k].n + ' 次 · 最近 ' + new Date(prof.gallery[k].last).toLocaleString('zh-CN') + '</div></div>' : '') +
    '</div>';
}

/* ---------------- 存档（SR-03） ---------------- */
function snap() {
  return { v: 1, node: G.node, S: G.S, flags: G.flags, held: G.held, rewinds: G.rewinds,
    rewindLeft: G.rewindLeft, cps: G.cps, path: G.path, warned: G.warned, at: Date.now(), story: STORY.meta.ver };
}
function writeSlot(name) { prof.slots[name] = snap(); saveProf(); }
function descSlot(s) {
  if (!s) return null;
  var n = NODES[s.node] || {};
  return { ch: STORY.chapters[n.ch] || '—', t: fmtClock(n.t || 0), node: s.node,
    st: 'EXP' + s.S.EXPOSURE + ' · REP' + s.S.REP + ' · SYN' + s.S.SYNC + ' · CR' + s.S.CREDIT,
    frag: fragCount() + '/7', at: new Date(s.at).toLocaleString('zh-CN') };
}
function openSave() {
  var names = ['auto', 's1', 's2', 's3'];
  $('slots').innerHTML = names.map(function (nm) {
    var s = prof.slots[nm], d = descSlot(s);
    var label = nm === 'auto' ? 'AUTO · 自动槽' : nm.toUpperCase() + ' · 手动槽';
    if (!d) return '<div class="slot empty"><div class="sn">' + label + '</div><div class="sd">空槽</div></div>';
    return '<div class="slot' + (nm === 'auto' ? ' auto' : '') + '"><div class="sn">' + label + '</div>' +
      '<div class="sd">' + esc(d.ch) + ' · ' + d.node + '</div>' +
      '<div class="sm">倒计时 ' + d.t + '<br>' + d.st + '<br>' + d.at + '</div>' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="btn" data-load="' + nm + '">读取</button>' +
      (nm === 'auto' || !G ? '' : '<button class="btn mg" data-save="' + nm + '">覆盖保存</button>') +
      (nm === 'auto' ? '' : '<button class="btn" data-del="' + nm + '" style="border-color:rgba(140,170,210,.25);color:var(--dim)">删除</button>') +
      '</div></div>';
  }).join('');
  if (G) {
    var free = ['s1', 's2', 's3'].filter(function (n) { return !prof.slots[n]; });
    if (free.length) {
      var w = document.createElement('div'); w.className = 'row'; w.style.marginTop = '14px';
      w.innerHTML = '<button class="btn ac" data-save="' + free[0] + '">保存到 ' + free[0].toUpperCase() + '</button>';
      $('slots').appendChild(w);
    }
  }
  Array.prototype.forEach.call($('slots').querySelectorAll('[data-load]'), function (b) {
    b.onclick = function () { doLoad(b.dataset.load); };
  });
  Array.prototype.forEach.call($('slots').querySelectorAll('[data-save]'), function (b) {
    b.onclick = function () {
      var nm = b.dataset.save;
      if (prof.slots[nm]) {
        var d = descSlot(prof.slots[nm]);
        confirmBox('OVERWRITE', '覆盖存档槽', nm.toUpperCase() + ' 已有存档：' + d.ch + ' · ' + d.node + ' · 倒计时 ' + d.t + '。确认覆盖？', function () { writeSlot(nm); toast('已保存到 ' + nm.toUpperCase()); openSave(); }, '覆盖');
      } else { writeSlot(nm); toast('已保存到 ' + nm.toUpperCase()); openSave(); }
    };
  });
  Array.prototype.forEach.call($('slots').querySelectorAll('[data-del]'), function (b) {
    b.onclick = function () {
      var nm = b.dataset.del, d = descSlot(prof.slots[nm]);
      confirmBox('DELETE', '删除存档槽', nm.toUpperCase() + '：' + d.ch + ' · ' + d.node + ' · 倒计时 ' + d.t + '。删除后无法恢复。', function () {
        prof.slots[nm] = null; saveProf(); toast('已删除 ' + nm.toUpperCase()); openSave();
      }, '删除');
    };
  });
  openOv('ov-save');
}
function doLoad(nm) {
  var s = prof.slots[nm];
  if (!s) return;
  if (s.story !== STORY.meta.ver) {
    confirmBox('VERSION', '剧本版本不一致', '该存档来自剧本 ' + s.story + '，当前为 ' + STORY.meta.ver + '。按 SR-03 规则拒绝读取，避免状态错乱。是否以新剧本重新开始？', function () { closeOv('ov-save'); startNew(); }, '重新开始');
    return;
  }
  G = { node: s.node, S: s.S, flags: s.flags, held: s.held, rewinds: s.rewinds, rewindLeft: s.rewindLeft,
    cps: s.cps, path: s.path, warned: s.warned, started: Date.now() };
  closeOv('ov-save'); enterGame(); goto(G.node, true);
  toast('已读取 ' + (nm === 'auto' ? '自动槽' : nm.toUpperCase()));
}

/* ---------------- 分享图（FR-09） ----------------
   默认不含结局描述与路径回放，避免剧透；隐藏结局不显示称号。 */
function shareCard(code) {
  var e = ENDINGS[code], W = 1080, H = 1350;
  var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var x = cv.getContext('2d');
  x.fillStyle = '#04060c'; x.fillRect(0, 0, W, H);
  var g = x.createRadialGradient(240, 120, 40, 240, 120, 940);
  g.addColorStop(0, e.ty === 'true' ? 'rgba(182,255,59,.22)' : e.ty === 'hidden' ? 'rgba(155,107,255,.24)' : 'rgba(255,46,136,.24)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (var sy = 0; sy < H; sy += 4) { x.fillStyle = 'rgba(0,0,0,.22)'; x.fillRect(0, sy, W, 2); }
  x.strokeStyle = 'rgba(34,230,255,.35)'; x.lineWidth = 2; x.strokeRect(46, 46, W - 92, H - 92);
  x.fillStyle = '#22e6ff'; x.font = '28px "Share Tech Mono", monospace';
  x.fillText('NEO-KOWLOON // 2087 · CONSENSUS LAYER', 92, 150);
  x.fillStyle = '#7b8ca4'; x.font = '26px "Share Tech Mono", monospace';
  x.fillText('BRANCHING NARRATIVE · 72H COUNTDOWN', 92, 196);
  x.fillStyle = '#ff2e88'; x.font = '32px "Share Tech Mono", monospace';
  x.fillText('ENDING ' + code + (e.ty === 'true' ? ' ★' : ''), 92, 330);
  x.fillStyle = '#eaf6ff'; x.font = '700 104px "Chakra Petch","Noto Sans SC",sans-serif';
  x.fillText(e.ty === 'hidden' ? '???' : e.n, 88, 470);
  x.strokeStyle = 'rgba(255,46,136,.4)'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(92, 540); x.lineTo(W - 92, 540); x.stroke();
  var rows = [
    ['EXPOSURE 曝光度', G.S.EXPOSURE + ' / 100'],
    ['REP 信誉', G.S.REP + ' / 100'],
    ['SYNC 记忆完整度', G.S.SYNC + ' / 100'],
    ['CREDIT 信用点', String(G.S.CREDIT)],
    ['FRAGMENT 碎片', fragCount() + ' / 7'],
    ['REWIND 回档', G.rewinds + ' 次'],
    ['ENDINGS 图鉴', Object.keys(prof.gallery).length + ' / ' + Object.keys(ENDINGS).length]
  ];
  x.font = '28px "Share Tech Mono", monospace';
  rows.forEach(function (r, i) {
    var y = 620 + i * 62;
    x.fillStyle = '#7b8ca4'; x.fillText(r[0], 92, y);
    x.fillStyle = '#b6ff3b'; x.fillText(r[1], 620, y);
  });
  x.fillStyle = '#b6ff3b'; x.font = '34px "Share Tech Mono", monospace';
  x.fillText('《黑历史：霓虹回档》', 92, H - 190);
  x.fillStyle = '#22e6ff'; x.font = '26px "Share Tech Mono", monospace';
  x.fillText('NEON RECALL · RUN ' + prof.runs, 92, H - 146);
  x.fillStyle = '#ffb020'; x.font = '24px "Share Tech Mono", monospace';
  x.fillText('SPOILER FREE · 本图不含结局描述与路径', 92, H - 100);
  try {
    var a = document.createElement('a');
    a.download = 'neon-recall-' + code + '.png'; a.href = cv.toDataURL('image/png'); a.click();
    toast('分享图已生成并下载（不含剧透）', 'dn', 2800);
  } catch (err) { toast('分享图生成失败，请重试', 'up', 2800); }
}

/* ---------------- 覆盖层与确认 ---------------- */
function openOv(id) { $(id).classList.add('on'); }
function closeOv(id) { $(id).classList.remove('on'); }
function anyOv() { var a = document.querySelectorAll('.ov.on'); return a.length ? a[a.length - 1] : null; }
var cfCb = null;
function confirmBox(t, h, b, cb, yesTxt) {
  $('cf-t').textContent = t; $('cf-h').textContent = h; $('cf-b').textContent = b;
  $('cf-y').textContent = yesTxt || '确认'; cfCb = cb; openOv('ov-confirm');
}
$('cf-y').onclick = function () { closeOv('ov-confirm'); var f = cfCb; cfCb = null; f && f(); };
$('cf-n').onclick = function () { closeOv('ov-confirm'); cfCb = null; };
Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
  b.onclick = function () { var o = b.closest('.ov'); if (o) o.classList.remove('on'); };
});

/* ---------------- 设置 ---------------- */
function openSettings() {
  var s = prof.settings;
  $('set-body').innerHTML =
    '<label>字号<span class="d">影响正文与选项文本</span></label>' +
    '<div class="row"><input type="range" id="st-fs" min="1" max="1.5" step="0.25" value="' + s.fs + '"><span class="dim" id="st-fs-v" style="font-family:var(--mono)">' + Math.round(s.fs * 100) + '%</span></div>' +
    '<label>减弱动效<span class="d">关闭打字机、抖动、撕裂与字符替换；限时选项自动取消时限（SR-06）</span></label>' +
    '<button class="tg' + (s.calm ? ' on' : '') + '" id="st-calm" role="switch" aria-checked="' + !!s.calm + '"></button>' +
    '<label>扫描线<span class="d">常驻 CRT 扫描线层</span></label>' +
    '<button class="tg' + (s.scan ? ' on' : '') + '" id="st-scan" role="switch" aria-checked="' + !!s.scan + '"></button>' +
    '<label>音效<span class="d">合成音效：选项、状态变化、碎片、回档</span></label>' +
    '<button class="tg' + (s.audio ? ' on' : '') + '" id="st-audio" role="switch" aria-checked="' + !!s.audio + '"></button>' +
    '<label>敏感内容提示<span class="d">进入标记桥段前的一次性提示（文本不可关闭，仅关闭动画）</span></label>' +
    '<button class="tg' + (s.sens ? ' on' : '') + '" id="st-sens" role="switch" aria-checked="' + !!s.sens + '"></button>';
  $('set-store').textContent = storeOK ? '本地存储可用 · ' + KEY : '本地存储不可用 · 会话模式（进度不会保存）';
  var fs = $('st-fs');
  fs.oninput = function () { prof.settings.fs = +fs.value; $('st-fs-v').textContent = Math.round(fs.value * 100) + '%'; applySettings(); saveProf(); };
  [['st-calm', 'calm'], ['st-scan', 'scan'], ['st-audio', 'audio'], ['st-sens', 'sens']].forEach(function (p) {
    $(p[0]).onclick = function () {
      prof.settings[p[1]] = !prof.settings[p[1]];
      this.classList.toggle('on', prof.settings[p[1]]);
      this.setAttribute('aria-checked', String(prof.settings[p[1]]));
      applySettings(); saveProf();
      if (G && p[1] === 'calm') renderOpts(NODES[G.node]);
    };
  });
  $('set-wipe').onclick = function () {
    confirmBox('WIPE', '清除全部本地数据', '将删除结局图鉴、碎片档案、全部存档与设置。此操作不可撤销。', function () {
      prof = blankProf(); saveProf(); applySettings(); toTitle(); toast('本地数据已清除', 'warn');
    }, '全部清除');
  };
  openOv('ov-set');
}
function applySettings() {
  document.documentElement.style.setProperty('--fs', prof.settings.fs);
  paintGlitch();
}

/* ---------------- 流程控制 ---------------- */
function toTitle() {
  elHud.hidden = true; elMain.hidden = true; elTitle.style.display = 'flex';
  var hasAuto = !!prof.slots.auto;
  $('m-cont').disabled = !hasAuto;
  var ks = Object.keys(ENDINGS), got = ks.filter(function (k) { return prof.gallery[k]; }).length;
  $('m-prog').innerHTML = 'ENDINGS <b>' + got + '/' + ks.length + '</b> &nbsp;·&nbsp; FRAGMENTS <b>' + fragCount() + '/7</b> &nbsp;·&nbsp; RUNS <b>' + prof.runs + '</b>' +
    (storeOK ? '' : ' &nbsp;·&nbsp; <span style="color:var(--amber)">会话模式 · 进度不会保存</span>');
  G = null; paintGlitch();
}
function enterGame() {
  elTitle.style.display = 'none'; elHud.hidden = false; elMain.hidden = false;
  paintGlitch();
}
function startNew() {
  G = newRun();
  enterGame();
  elBlack.classList.add('on');
  setTimeout(function () { elBlack.classList.remove('on'); goto('N0-01'); }, prof.settings.calm ? 40 : 480);
}
function continueRun() {
  if (prof.slots.auto) doLoad('auto'); else startNew();
}

/* ---------------- 术语浮层 ---------------- */
elTx.addEventListener('mouseover', function (ev) {
  var b = ev.target.closest ? ev.target.closest('b.term') : null;
  if (!b) return;
  var t = b.getAttribute('data-term');
  elTip.innerHTML = '<div class="t">' + esc(t) + '</div>' + esc(TERMS[t] || '');
  elTip.style.display = 'block';
  var r = b.getBoundingClientRect();
  elTip.style.left = Math.min(window.innerWidth - 300, Math.max(10, r.left)) + 'px';
  elTip.style.top = (r.bottom + 10) + 'px';
});
elTx.addEventListener('mouseout', function (ev) {
  if (ev.target.closest && ev.target.closest('b.term')) elTip.style.display = 'none';
});
/* 点击场景区任意位置补全打字机（FR-01）；点击术语不触发 */
$('scene').addEventListener('click', function (ev) {
  if (ev.target.closest && ev.target.closest('b.term')) return;
  if (typing && elTx._skip) { elTx._skip(); sfx('tick'); }
});

/* ---------------- 键盘 ---------------- */
document.addEventListener('keydown', function (ev) {
  var t = ev.target;
  if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
  if (ev.key === 'Escape') {
    var o = anyOv();
    if (o) { o.classList.remove('on'); return; }
    if (G) { openSettings(); }
    return;
  }
  if (ev.key === ' ' || ev.code === 'Space') {
    if (anyOv()) return;
    ev.preventDefault();
    if (typing && elTx._skip) elTx._skip();
    return;
  }
  var n = parseInt(ev.key, 10);
  if (n >= 1 && n <= 9 && !anyOv()) {
    var bs = elOpts.querySelectorAll('.opt');
    if (bs[n - 1] && !bs[n - 1].disabled) { ev.preventDefault(); bs[n - 1].click(); }
    else if (bs[n - 1]) { sfx('lock'); toast(bs[n - 1].title || '条件不足', 'warn', 1600); }
  }
});

/* ---------------- 绑定 ---------------- */
$('m-new').onclick = function () { sfx('pick'); startNew(); };
$('m-cont').onclick = function () { sfx('pick'); continueRun(); };
$('m-load').onclick = function () { openSave(); };
$('m-gal').onclick = function () { openGallery(); };
$('m-frag').onclick = function () { openFrags(); };
$('m-set').onclick = function () { openSettings(); };
$('btn-frag').onclick = function () { openFrags(); };
$('btn-rewind').onclick = function () { openRewind(); };
$('btn-save').onclick = function () { openSave(); };
$('btn-gal').onclick = function () { openGallery(); };
$('btn-set').onclick = function () { openSettings(); };
$('btn-title').onclick = function () {
  if (!G) { toTitle(); return; }
  confirmBox('EXIT', '返回标题页', '当前进度已写入自动槽，可从标题页「继续」恢复。', function () { writeSlot('auto'); toTitle(); }, '返回标题');
};
window.addEventListener('resize', function () { elTip.style.display = 'none'; });
document.addEventListener('visibilitychange', function () {
  if (document.hidden) pauseTimer(); else resumeTimer();
});

/* ---------------- 启动 ---------------- */
applySettings();
toTitle();
if (!storeOK) toast('本地存储不可用 · 已进入会话模式，进度不会保存', 'warn', 4200);
})();
