(() => {
const DAY = 86400000;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const isoOf = d => d.toISOString().slice(0, 10);
const parseIso = s => { const [y, m, d] = String(s).split('-').map(Number); return utc(y, m, d); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let D = null;          // サーバーから受け取ったデータ
let WEEKS = [], IDX = {}, TODAY = 0;
const ui = { sel: null, base: 0, span: 3 };

/* ---------- app shell: key & storage ---------- */
const KIND = window.APP_KIND === 'student' ? 'student' : 'teacher';
const API = String(window.MONJU_API || '').trim();
const LS_KEY = 'monju-key-' + KIND, LS_CACHE = 'monju-cache-' + KIND;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };
const keyOk = k => /^[A-Za-z0-9-]{8,64}$/.test(k || '');
function keyFrom(text) {
  const s = String(text || '').trim();
  const m = s.match(/[#?&]k=([A-Za-z0-9-]{8,64})/);
  if (m) return m[1];
  return keyOk(s) ? s : '';
}
let KEY = keyFrom(location.hash) || keyFrom(location.search);
if (KEY) {
  if (KEY !== lsGet(LS_KEY)) lsDel(LS_CACHE);
  lsSet(LS_KEY, KEY);
} else KEY = lsGet(LS_KEY) || '';

/* ---------- server ---------- */
async function call(fn, ...args) {
  if (!API) throw new Error('アプリの設定（config.js）に、ウェブアプリのURLが入っていません。');
  let res;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn, k: KEY, args }), redirect: 'follow' });
  } catch (e) { const er = new Error('通信できませんでした。電波の良いところで、もう一度試してください。'); er.offline = true; throw er; }
  let j;
  try { j = await res.json(); } catch (e) { throw new Error('サーバーから正しい返事がありませんでした。時間をおいて、もう一度試してください。'); }
  if (!j || !j.ok) { const er = new Error((j && j.error) || 'エラーが発生しました'); er.server = true; throw er; }
  return j.data;
}
let busyN = 0;
async function mutate(fn, ...args) {
  busyN++; document.getElementById('busy').hidden = false;
  try {
    const p = await call(fn, ...args);
    setData(p);
    return p;
  } catch (e) {
    toast(cleanErr(e));
    throw e;
  } finally {
    busyN--; if (!busyN) document.getElementById('busy').hidden = true;
  }
}
const cleanErr = e => String((e && e.message) || e || 'エラーが発生しました').replace(/^Error:\s*/, '').replace(/^Exception:\s*/, '');

let loadedAt = 0;
function setData(p) {
  const first = !D;
  D = p; loadedAt = Date.now();
  lsSet(LS_CACHE, JSON.stringify({ at: loadedAt, data: p }));
  if (first) {
    WEEKS = [];
    for (let t = parseIso(D.planStart); t <= parseIso(D.planEnd); t = new Date(t.getTime() + 7 * DAY)) {
      const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate(), n = Math.ceil(d / 7);
      const e = new Date(t.getTime() + 6 * DAY);
      WEEKS.push({ iso: isoOf(t), y, m, d, n, label: `${m}月${n}週`, range: `${m}/${d}〜${e.getUTCMonth() + 1}/${e.getUTCDate()}` });
    }
    IDX = Object.fromEntries(WEEKS.map((w, i) => [w.iso, i]));
    const now = new Date();
    const local = utc(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const mon = new Date(local.getTime() - ((local.getUTCDay() + 6) % 7) * DAY);
    const i = IDX[isoOf(mon)];
    TODAY = i != null ? i : (mon < parseIso(WEEKS[0].iso) ? 0 : WEEKS.length - 1);
    ui.base = WEEKS[TODAY].y * 12 + (WEEKS[TODAY].m - 1);
    if (D.role === 'student' && D.students[0]) ui.sel = D.students[0].id;
  }
}
const wi = s => IDX[s] ?? 0;

/* ---------- planning engine ---------- */
function parseUnits(text) {
  const out = [];
  String(text || '').split(/[,、，\n]+/).map(t => t.trim()).filter(Boolean).forEach(tok => {
    const m = tok.match(/^(\d+)\s*[-‐–−〜~]\s*(\d+)$/);
    if (m) { const a = +m[1], b = +m[2]; if (b >= a && b - a < 500) for (let k = a; k <= b; k++) out.push(String(k)); else out.push(tok); }
    else out.push(tok);
  });
  return out;
}
function fmtUnits(items, suffix) {
  if (!items.length) return '';
  const nums = items.every(x => /^\d+$/.test(x));
  if (nums && items.length >= 3) {
    const a = +items[0], b = +items[items.length - 1];
    if (b - a === items.length - 1) return `${a}–${b}${suffix || ''}`;
  }
  return items.join(', ') + (nums ? (suffix || '') : '');
}
function factor(st, i) {
  const w = st.weekStatus[WEEKS[i].iso];
  if (!w) return 1;
  return w.level === 'rest' ? 0 : w.level === 'half' ? 0.5 : 1;
}
function schedule(st, mat) {
  const units = parseUnits(mat.units), n = units.length;
  const s = wi(mat.start), dl = wi(mat.deadline), W = WEEKS.length;
  const pace = Math.max(0, Number(mat.pace) || 0);
  const act = mat.actual || {};
  const cells = {}, posAt = {};
  let pos = 0, acc = 0, i = s;
  for (; i < W && pos < n; i++) {
    posAt[i] = pos;
    const fw = factor(st, i);
    acc += pace * fw;
    const planned = Math.floor(acc + 1e-9); acc -= planned;
    if (fw === 1 && Number.isInteger(pace)) acc = 0;
    const plannedCap = Math.min(planned, n - pos);
    const a = act[WEEKS[i].iso];
    const hasA = a != null && i <= TODAY;
    const take = hasA ? Math.min(a, n - pos) : plannedCap;
    if (take > 0 || hasA) cells[i] = { items: units.slice(pos, pos + take), planned: plannedCap, actual: hasA ? a : null };
    pos += take;
  }
  const lastIdx = c => Math.max(-1, ...Object.keys(c).filter(k => c[k].items.length).map(Number));
  const complete = pos >= n;
  let endIdx = lastIdx(cells);
  const shiftOver = n > 0 && (!complete || endIdx > dl);
  let fitted = false;
  if (mat.mode === 'fit' && shiftOver) {
    let w0 = Math.max(s, TODAY);
    if (w0 === TODAY && act[WEEKS[TODAY].iso] != null) w0 = TODAY + 1;
    const pos0 = posAt[w0];
    if (pos0 != null && w0 <= dl) {
      let C = 0, lastPos = -1;
      for (let k = w0; k <= dl; k++) { const f = factor(st, k); C += f; if (f > 0) lastPos = k; }
      if (C > 0) {
        Object.keys(cells).map(Number).filter(k => k >= w0).forEach(k => delete cells[k]);
        const R = n - pos0; let cum = 0, assigned = 0;
        for (let k = w0; k <= dl; k++) {
          const f = factor(st, k); if (f === 0) continue;
          cum += f;
          const target = k === lastPos ? R : Math.round(R * cum / C);
          const take = target - assigned;
          if (take > 0) cells[k] = { items: units.slice(pos0 + assigned, pos0 + target), planned: take, actual: null, packed: take > pace * f + 1e-9 };
          assigned = target;
        }
        fitted = true; endIdx = lastIdx(cells);
      }
    }
  }
  let done = 0;
  Object.keys(cells).map(Number).forEach(k => { if (k < TODAY || (k === TODAY && cells[k].actual != null)) done += cells[k].items.length; });
  return { units, n, cells, s, dl, pace, complete: complete || fitted, endIdx, shiftOver, over: fitted ? false : shiftOver, fitted, done };
}
const endLabel = r => r.n === 0 ? '—' : (!r.complete ? '計画期間内に終わらない' : (r.endIdx >= 0 ? WEEKS[r.endIdx].label : '—'));
function eachMat(st, fn) { st.subjects.forEach((sub, si) => sub.materials.forEach(m => fn(m, sub, si))); }
function findMat(st, id) { let hit = null; eachMat(st, (m, sub) => { if (m.id === id) hit = { m, sub }; }); return hit; }
function pending(st) {
  const out = [];
  eachMat(st, (m, sub) => {
    const r = schedule(st, m);
    if (!r.over) return;
    const acked = m.extendTo && IDX[m.extendTo] != null && r.complete && r.endIdx <= wi(m.extendTo);
    out.push({ m, sub, r, acked });
  });
  return out;
}

/* ---------- lookups ---------- */
const teacherName = id => (D.teachers.find(t => t.id === id) || {}).name || '未設定';
const studentById = id => D.students.find(s => s.id === id);
const fmtAt = s => { const [d, t] = String(s).split('T'); const [, m, dd] = d.split('-'); return `${+m}/${+dd} ${(t || '').slice(0, 5)}`; };
const subjUnit = (m, items) => (m.suffix && /^\d/.test(items[0] || '')) ? m.suffix : '項目';

/* ---------- splash & skeleton ---------- */
const T0 = Date.now();
let splashGone = false, slowTimer = null;
function hideSplash() {
  if (splashGone) return; splashGone = true; clearTimeout(slowTimer);
  const s = document.getElementById('splash'); if (!s) return;
  setTimeout(() => { s.classList.add('hide'); setTimeout(() => s.remove(), 450); }, Math.max(0, 700 - (Date.now() - T0)));
}
slowTimer = setTimeout(() => { const n = document.getElementById('splashNote'); if (n) n.textContent = '通信に時間がかかっています…'; }, 6000);
const skeleton = () => `<div class="skel" aria-label="読み込み中"><div class="sk" style="height:64px"></div><div class="sk" style="height:132px"></div><div class="sk" style="height:38px;width:60%"></div><div class="sk" style="height:260px"></div></div>`;

/* ---------- views ---------- */
function weekTodo(st) {
  const w = WEEKS[TODAY];
  const rows = [];
  st.subjects.forEach(sub => sub.materials.forEach(m => {
    const c = schedule(st, m).cells[TODAY];
    if (c && c.items.length) rows.push(`<li><span class="todo-sub">${esc(sub.name)}</span><span class="todo-mat">${esc(m.name)}</span><b class="todo-amt">${esc(fmtUnits(c.items, m.suffix))}</b></li>`);
  }));
  const ws = st.weekStatus[w.iso];
  return `<section class="todo" aria-label="今週やること"><div class="todo-head"><h2>今週やること</h2><span class="muted">${w.label}（${w.range}）</span>${ws ? weekChip(st, TODAY) + `<span class="muted">${esc(ws.reason || '')}</span>` : ''}</div>
    ${rows.length ? `<ul>${rows.join('')}</ul>` : `<p class="muted" style="margin:0">今週の予定はありません。</p>`}</section>`;
}

function render() {
  document.getElementById('schoolName').textContent = D.school;
  const who = document.getElementById('who');
  who.innerHTML = (D.role === 'admin' ? `<span class="role">管理者</span>${esc(D.me.name)}`
    : D.role === 'teacher' ? `<span class="role">講師</span>${esc(D.me.name)}`
    : `<span class="role">生徒</span>${esc(D.me.name)}`) + `<button class="iconbtn" data-shell="menu" aria-label="メニュー">⋯</button>`;
  const app = document.getElementById('app');
  const st = ui.sel && studentById(ui.sel);
  if (D.role === 'student') app.innerHTML = st ? planView(st, 'student') : `<div class="empty">計画が見つかりません。</div>`;
  else if (D.role === 'teacher') app.innerHTML = st ? planView(st, 'teacher') : teacherHome();
  else app.innerHTML = st ? planView(st, 'admin') : adminHome();
  hideSplash();
}

function thisWeekSummary(st) {
  return `<ul>${st.subjects.map(sub => {
    const parts = [];
    sub.materials.forEach(m => { const c = schedule(st, m).cells[TODAY]; if (c && c.items.length) parts.push(`${m.name.replace(/^\[新版\]\s*/, '').slice(0, 14)} ${fmtUnits(c.items, m.suffix)}`); });
    return `<li><span>${esc(sub.name)}</span>${parts.length ? esc(parts.join(' ／ ')) : '<span class="muted">予定なし</span>'}</li>`;
  }).join('')}</ul>`;
}
function weekChip(st, i) {
  const w = st.weekStatus[WEEKS[i].iso];
  if (!w) return '';
  return w.level === 'rest' ? `<span class="chip rest">休み</span>` : `<span class="chip half">半分</span>`;
}
function issueChips(st) {
  const p = pending(st);
  const need = p.filter(x => !x.acked).length, ext = p.filter(x => x.acked).length;
  let h = '';
  if (need) h += `<span class="chip rest">要判断 ${need}</span> `;
  if (ext) h += `<span class="chip half">期限延長 ${ext}</span> `;
  return h || `<span class="chip ok">期限内</span>`;
}

function adminHome() {
  const w = WEEKS[TODAY];
  const alerts = [];
  D.students.forEach(st => pending(st).forEach(x => {
    alerts.push(`<div class="alert${x.acked ? ' soft' : ''}"><b>${esc(st.name)}</b><span>${esc(x.sub.name)}「${esc(x.m.name)}」</span><span>期限 ${WEEKS[x.r.dl].label} → 終了見込み <b>${esc(endLabel(x.r))}</b></span><span class="chip ${x.acked ? 'half' : 'rest'}">${x.acked ? '講師が延長を選択' : '講師の判断待ち'}</span><span class="sp"></span><button class="linkbtn" data-act="open-student" data-id="${esc(st.id)}">計画を開く</button></div>`);
  }));
  const tOpts = sel => `<option value=""${!sel ? ' selected' : ''}>未設定</option>` + D.teachers.map(t => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
  const rows = D.students.map(st => `<tr>
    <td><b>${esc(st.name)}</b></td>
    <td class="muted">${esc(st.goal)}</td>
    <td><select data-act="assign" data-id="${esc(st.id)}" aria-label="${esc(st.name)}の担当講師">${tOpts(st.teacher)}</select></td>
    <td>${weekChip(st, TODAY) || '<span class="muted">通常</span>'}</td>
    <td>${issueChips(st)}</td>
    <td style="text-align:right;white-space:nowrap"><button class="btn small ghost" data-act="edit-student" data-id="${esc(st.id)}">編集</button><button class="btn small" data-act="open-student" data-id="${esc(st.id)}">計画を開く</button></td>
  </tr>`).join('');
  const urlRow = (label, url, kind, id) => `<div class="urlrow"><span>${esc(label)}</span>${url ? `<code>${esc(url)}</code>` : `<span class="muted">公開後に表示されます</span>`}<span class="acts">${url ? `<button class="btn small" data-act="copy" data-text="${esc(url)}">コピー</button>` : ''}<button class="btn small ghost" data-act="renew" data-kind="${kind}" data-id="${esc(id)}">URLを作り直す</button></span></div>`;
  const logs = [];
  D.students.forEach(st => (st.log || []).forEach(l => logs.push({ ...l, st: st.name })));
  logs.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return `<div class="stack">
    <div class="page-head"><div><div class="eyebrow">今週　${w.label}（${w.range}）</div><h1>学習管理ダッシュボード</h1></div><span class="sp"></span><button class="btn primary" data-act="add-student">＋ 生徒を追加</button></div>
    ${alerts.length ? `<section class="alerts" aria-label="期限を超える教材">${alerts.join('')}</section>` : `<div class="alert good">期限を超える教材はありません。</div>`}
    <section class="panel"><h2>生徒</h2>${D.students.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>生徒</th><th>志望校</th><th>担当講師</th><th>今週</th><th>期限</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">まだ生徒が登録されていません。「生徒を追加」から登録してください。</div>`}</section>
    <section class="panel">
      <div class="panel-head"><h2>講師</h2></div>
      ${D.teachers.length ? D.teachers.map(t => `<div class="urlrow"><span><b>${esc(t.name)}</b><br><button class="linkbtn" style="font-size:12px" data-act="rename-teacher" data-id="${esc(t.id)}">名前を変更</button></span><span class="muted" style="font-size:13px">担当：${esc(D.students.filter(s => s.teacher === t.id).map(s => s.name).join('、') || 'なし')}</span><span></span></div>`).join('') : '<p class="muted" style="margin:0">講師がまだ登録されていません。</p>'}
      <form class="inline-form" data-form="add-teacher"><input id="newTeacher" placeholder="講師の名前（例：比嘉）" aria-label="講師の名前"><button class="btn" type="submit">＋ 講師を追加</button></form>
    </section>
    <section class="panel"><h2>専用URL</h2><p class="muted" style="margin:0 0 8px;font-size:13.5px">講師と生徒にはそれぞれのURLだけを渡します。講師のURLからは担当生徒の計画だけ、生徒のURLからは本人の計画だけが開きます。URLが他の人に渡ってしまったときは「URLを作り直す」を押すと、前のURLは使えなくなります。</p>
      ${D.teachers.map(t => urlRow(`講師　${t.name}`, t.url, 'teacher', t.id)).join('')}
      ${D.students.map(s => urlRow(`生徒　${s.name}`, s.url, 'student', s.id)).join('')}
    </section>
    <section class="panel"><h2>最近の変更</h2>${logs.length ? `<ul class="log">${logs.slice(0, 15).map(l => `<li><time>${fmtAt(l.at)}</time><span><b>${esc(l.by)}</b>　${esc(l.st)}：${esc(l.text)}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">まだ変更はありません。</p>'}</section>
  </div>`;
}

function teacherHome() {
  const w = WEEKS[TODAY];
  const mine = D.students;
  return `<div class="stack">
    <div class="page-head"><div><div class="eyebrow">今週　${w.label}（${w.range}）</div><h1>${esc(D.me.name)}さんの担当生徒</h1></div></div>
    ${mine.length ? `<div class="cards">${mine.map(st => `<button class="card" data-act="open-student" data-id="${esc(st.id)}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3>${esc(st.name)}</h3>${weekChip(st, TODAY)}</div>
      <div class="muted" style="font-size:13px">${esc(st.goal)}</div>
      <div class="eyebrow" style="margin-top:4px">今週の予定</div>
      ${thisWeekSummary(st)}
      <div>${issueChips(st)}</div>
    </button>`).join('')}</div>` : `<div class="empty">担当生徒がまだいません。上原さんが担当を設定すると、ここに表示されます。</div>`}
  </div>`;
}

function windowWeeks() {
  if (ui.span === 'all') return WEEKS.map((_, i) => i);
  return WEEKS.map((w, i) => [w, i]).filter(([w]) => { const k = w.y * 12 + (w.m - 1); return k >= ui.base && k < ui.base + 3; }).map(([, i]) => i);
}
const monthName = k => `${(k % 12) + 1}月`;
const periodLabel = () => ui.span === 'all' ? '年間' : `${monthName(ui.base)}〜${monthName(ui.base + 2)}`;

function planTable(st, sub, mode, weeks, opts = {}) {
  const editable = (mode === 'teacher' || mode === 'admin') && !opts.print;
  const groups = [];
  weeks.forEach(i => { const w = WEEKS[i]; const g = groups[groups.length - 1]; if (g && g.m === w.m && g.y === w.y) g.c++; else groups.push({ y: w.y, m: w.m, c: 1 }); });
  let h = `<table class="plan"><thead>
    <tr><th rowspan="3" class="c-cat">分類</th><th rowspan="3" class="c-mat">教材</th><th rowspan="3" class="c-amt">量・ペース</th>${groups.map(g => `<th colspan="${g.c}">${g.m}月</th>`).join('')}</tr>
    <tr class="wk">${weeks.map(i => `<th class="${i === TODAY && !opts.print ? 'now' : ''}">${WEEKS[i].n}<small>${WEEKS[i].range.split('〜')[0]}〜</small></th>`).join('')}</tr>
    <tr class="st">${weeks.map(i => {
      const w = st.weekStatus[WEEKS[i].iso];
      const inner = w ? `${weekChip(st, i)}<span>${esc(w.reason || '')}</span>` : (editable ? '<span aria-hidden="true">＋</span>' : '');
      if (editable) return `<td class="${i === TODAY ? 'now' : ''}"><button class="stbtn" data-act="week" data-id="${esc(st.id)}" data-i="${i}" aria-label="${WEEKS[i].label}の状況を設定">${inner}</button></td>`;
      return `<td><div class="stcell">${inner}</div></td>`;
    }).join('')}</tr>
  </thead><tbody>`;
  const mats = sub.materials;
  if (!mats.length) h += `<tr><td colspan="${3 + weeks.length}" class="muted" style="padding:16px">教材がまだ登録されていません。</td></tr>`;
  mats.forEach((m, mi) => {
    const r = schedule(st, m);
    const first = mi === 0 || mats[mi - 1].cat !== m.cat;
    let span = 1; if (first) for (let k = mi + 1; k < mats.length && mats[k].cat === m.cat; k++) span++;
    const pct = r.n ? Math.round(r.done / r.n * 100) : 0;
    const status = r.over ? `<span class="chip rest">期限超過 → ${esc(endLabel(r))}</span>` : r.fitted ? `<span class="chip info">期限内に詰めて調整</span>` : '';
    const modeCtl = (editable && r.shiftOver) ? `<div class="mode" role="group" aria-label="遅れたときの調整方法"><button data-act="mode" data-id="${esc(st.id)}" data-mat="${esc(m.id)}" data-mode="shift" aria-pressed="${m.mode !== 'fit'}">後ろにずらす</button><button data-act="mode" data-id="${esc(st.id)}" data-mat="${esc(m.id)}" data-mode="fit" aria-pressed="${m.mode === 'fit'}">期限内に詰める</button></div>` : '';
    const adminCtl = (mode === 'admin' && !opts.print) ? `<div class="matedit"><button class="linkbtn" data-act="edit-mat" data-id="${esc(st.id)}" data-mat="${esc(m.id)}">編集</button>${mi > 0 ? `<button class="linkbtn" data-act="move" data-mat="${esc(m.id)}" data-dir="-1" aria-label="上へ">↑</button>` : ''}${mi < mats.length - 1 ? `<button class="linkbtn" data-act="move" data-mat="${esc(m.id)}" data-dir="1" aria-label="下へ">↓</button>` : ''}</div>` : '';
    const nameInner = `<div class="matname">${esc(m.name)}</div>${m.note ? `<div class="matnote">${esc(m.note)}</div>` : ''}
      <div class="matmeta">${opts.print ? '' : `<span class="prog" title="${r.done}/${r.n}"><b style="width:${pct}%"></b></span><span>${r.done}/${r.n}済</span>`}${status}</div>${modeCtl}${adminCtl}`;
    const amt = `${r.n}${subjUnit(m, r.units)}<br>週${m.pace}<br><span style="font-size:11px">期限 ${WEEKS[r.dl].label}</span>`;
    h += `<tr>${first ? `<td class="c-cat" rowspan="${span}">${esc(m.cat)}</td>` : ''}<td class="c-mat">${nameInner}</td><td class="c-amt">${amt}</td>`;
    weeks.forEach(i => {
      const c = r.cells[i];
      const f = factor(st, i);
      const cls = ['wkc'];
      if (i < TODAY && !opts.print) cls.push('past');
      if (i === TODAY && !opts.print) cls.push('now');
      if (f === 0) cls.push('restcol'); else if (f < 1) cls.push('halfcol');
      if (c && c.items.length && i > r.dl) cls.push('late');
      if (c && c.packed) cls.push('packed');
      if (i === r.dl) cls.push('dl');
      let inner = c ? esc(fmtUnits(c.items, m.suffix)) : '';
      if (c && c.actual != null && !opts.print) inner += c.actual < c.planned ? `<span class="short">残${c.planned - c.actual}→繰越</span>` : `<span class="done">✓ 完了</span>`;
      if (editable && i <= TODAY && c && (c.planned > 0 || c.actual != null)) inner = `<button class="cellbtn" data-act="cell" data-id="${esc(st.id)}" data-mat="${esc(m.id)}" data-i="${i}" aria-label="${WEEKS[i].label}の実績を記録">${inner || '—'}</button>`;
      h += `<td class="${cls.join(' ')}"${i === r.dl ? ' title="期限の週"' : ''}>${inner}</td>`;
    });
    h += `</tr>`;
  });
  return h + `</tbody></table>`;
}

function noteBox(st, sub, si, mode, print) {
  return `<aside class="notebox"><h3>上原コメント</h3><p>${esc(sub.comment) || '<span class="muted">（コメントなし）</span>'}</p>${mode === 'admin' && !print ? `<div class="ed"><button class="linkbtn" data-act="edit-comment" data-id="${esc(st.id)}" data-si="${si}">コメントを編集</button></div>` : ''}</aside>`;
}

function planView(st, mode) {
  const weeks = windowWeeks();
  const editable = mode !== 'student';
  const banners = pending(st).map(x => `<div class="alert${x.acked ? ' soft' : ''}"><b>${esc(x.sub.name)}「${esc(x.m.name)}」</b><span>期限 ${WEEKS[x.r.dl].label} → 終了見込み ${esc(endLabel(x.r))}</span>${editable ? `<span class="chip ${x.acked ? 'half' : 'rest'}">${x.acked ? '延長を選択済み' : '調整方法が未選択'}</span>${!x.acked ? `<span class="sp"></span><button class="btn small" data-act="decide-open" data-id="${esc(st.id)}">調整方法を選ぶ</button>` : ''}` : ''}</div>`).join('');
  const back = mode === 'student' ? '' : `<div><button class="linkbtn" data-act="back">← ${mode === 'admin' ? 'ダッシュボード' : '担当生徒一覧'}に戻る</button></div>`;
  const hint = editable ? `<div class="hint">週の見出しの下の欄をタップすると「休み・半分」を設定できます。今週までのマスをタップすると、実際に終わった量を記録できます。設定すると、残りの計画が自動で組み直されます。</div>` : '';
  const logs = editable && (st.log || []).length ? `<section class="panel"><h2>この生徒の変更履歴</h2><ul class="log">${st.log.slice(0, 12).map(l => `<li><time>${fmtAt(l.at)}</time><span><b>${esc(l.by)}</b>　${esc(l.text)}</span></li>`).join('')}</ul></section>` : '';
  const minBase = WEEKS[0].y * 12 + WEEKS[0].m - 1, L = WEEKS[WEEKS.length - 1], maxBase = L.y * 12 + L.m - 1 - 2;
  return `<div class="stack">
    ${back}
    <div class="plan-title"><div class="titlebox">${esc(st.name.replace(/\s+/g, ''))} 学習計画</div><div class="titlebox goal">${st.goal ? esc(st.goal) + ' に受かるための専用ロードマップ' : '専用ロードマップ'}</div></div>
    ${weekTodo(st)}
    <div class="toolbar">
      <button class="btn small" data-act="prev" aria-label="前の月" ${ui.span === 'all' || ui.base <= minBase ? 'disabled' : ''}>◀</button>
      <span class="period">${periodLabel()}</span>
      <button class="btn small" data-act="next" aria-label="次の月" ${ui.span === 'all' || ui.base >= maxBase ? 'disabled' : ''}>▶</button>
      <button class="btn small ghost" data-act="thismonth">今月へ</button>
      <div class="seg" role="group" aria-label="表示期間"><button data-act="span" data-span="3" aria-pressed="${ui.span === 3}">3か月</button><button data-act="span" data-span="all" aria-pressed="${ui.span === 'all'}">年間</button></div>
      <span class="sp"></span>
      ${mode !== 'student' ? `<span class="muted" style="font-size:13px">担当：${esc(teacherName(st.teacher))}</span>` : ''}
      <button class="btn primary" data-act="pdf" data-id="${esc(st.id)}">PDFで保存</button>
    </div>
    <div class="legend"><span><i style="box-shadow:inset 0 0 0 2px var(--accent)"></i>今週</span><span><i style="background:var(--rest-weak)"></i>休みの週・期限超過</span><span><i style="background:var(--half-weak)"></i>半分の週</span><span><i style="border-right:3px solid var(--rest)"></i>教材の期限</span><span><b style="color:var(--accent)">太字の青</b>＝詰めて調整した週</span></div>
    ${banners}
    ${hint}
    ${st.subjects.map((sub, si) => `<section>
      <div class="subject-label">${esc(sub.name)}</div>
      <div class="subj-grid"><div class="tablewrap">${planTable(st, sub, mode, weeks)}</div>${noteBox(st, sub, si, mode)}</div>
      ${mode === 'admin' ? `<div class="addrow"><button class="btn small" data-act="add-mat" data-id="${esc(st.id)}" data-si="${si}">＋ ${esc(sub.name)}の教材を追加</button></div>` : ''}
    </section>`).join('')}
    ${logs}
  </div>`;
}

/* ---------- modal helpers ---------- */
const modal = document.getElementById('modal'), dialog = document.getElementById('dialog');
let lastFocus = null;
function openModal(html) {
  lastFocus = document.activeElement;
  dialog.innerHTML = html; modal.hidden = false; dialog.onclick = null;
  const f = dialog.querySelector('[autofocus], input, select, textarea, button'); if (f) f.focus();
}
function closeModal() { modal.hidden = true; dialog.innerHTML = ''; dialog.onclick = null; if (lastFocus && document.contains(lastFocus)) lastFocus.focus(); }
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
let toastT;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }
function lockDialog(on) { dialog.querySelectorAll('button').forEach(b => b.disabled = on); }
const weekOptions = sel => WEEKS.map(w => `<option value="${w.iso}"${w.iso === sel ? ' selected' : ''}>${w.label}（${w.range}）</option>`).join('');

/* week status */
function weekDialog(st, i) {
  const cur = st.weekStatus[WEEKS[i].iso] || { level: 'normal', reason: '', memo: '' };
  const reasons = ['定期テスト', '部活・大会', '体調不良', '学校行事', '家庭の用事', 'その他'];
  const draft = { ...cur, reason: cur.reason || reasons[0] };
  openModal(`<h2>${WEEKS[i].label}（${WEEKS[i].range}）</h2><div class="sub">${esc(st.name)}　この週の勉強量を設定します</div>
    <div class="field"><span class="lab">この週の状況</span><div class="choices">
      <button class="choice" data-level="normal" type="button"><b>通常</b><small>予定どおり</small></button>
      <button class="choice" data-level="half" type="button"><b>半分</b><small>ペース50%</small></button>
      <button class="choice" data-level="rest" type="button"><b>休み</b><small>この週は進めない</small></button>
    </div></div>
    <div id="wkReasonWrap"><div class="grid2">
      <div class="field"><label for="wkReason">理由</label><select id="wkReason">${reasons.map(r => `<option${r === draft.reason ? ' selected' : ''}>${r}</option>`).join('')}</select></div>
      <div class="field"><label for="wkMemo">メモ（任意）</label><input id="wkMemo" value="${esc(draft.memo || '')}" placeholder="例：2学期期末テスト"></div>
    </div></div>
    <div class="preview" id="wkPreview"></div>
    <div class="actions"><button class="btn" data-m="cancel" type="button">キャンセル</button><button class="btn primary" data-m="save" type="button">保存して組み直す</button></div>`);
  const draw = () => {
    const sim = JSON.parse(JSON.stringify(st));
    if (draft.level === 'normal') delete sim.weekStatus[WEEKS[i].iso]; else sim.weekStatus[WEEKS[i].iso] = { ...draft };
    const changes = [];
    eachMat(st, m => {
      const a = schedule(st, m), b = schedule(sim, findMat(sim, m.id).m);
      if (a.endIdx !== b.endIdx || a.complete !== b.complete || a.over !== b.over) changes.push(`${esc(m.name)}：${esc(endLabel(a))} → <b>${esc(endLabel(b))}</b>${b.over ? '（期限超過）' : ''}`);
    });
    dialog.querySelector('#wkPreview').innerHTML = changes.length ? `この変更で終わる週が変わる教材<ul>${changes.map(c => `<li>${c}</li>`).join('')}</ul>` : '終わる週が変わる教材はありません。';
    dialog.querySelectorAll('.choice').forEach(b => b.setAttribute('aria-pressed', b.dataset.level === draft.level));
    dialog.querySelector('#wkReasonWrap').hidden = draft.level === 'normal';
  };
  draw();
  dialog.onclick = async e => {
    const c = e.target.closest('.choice'); if (c) { draft.level = c.dataset.level; draw(); return; }
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'cancel') return closeModal();
    lockDialog(true);
    try {
      await mutate('api_setWeek', st.id, WEEKS[i].iso, draft.level, dialog.querySelector('#wkReason').value, dialog.querySelector('#wkMemo').value.trim());
      closeModal(); render(); afterChange(st.id);
    } catch (err) { lockDialog(false); }
  };
}

/* actuals */
function cellDialog(st, matId, i) {
  const { m } = findMat(st, matId);
  const c = schedule(st, m).cells[i] || { actual: null };
  const sim = JSON.parse(JSON.stringify(st)); const sm = findMat(sim, matId).m; delete sm.actual[WEEKS[i].iso];
  const pc = schedule(sim, sm).cells[i] || { items: [] };
  const planned = pc.items.length;
  let val = c.actual != null ? c.actual : planned;
  const max = Math.max(planned + 2, val);
  openModal(`<h2>実績を記録</h2><div class="sub">${esc(st.name)}　${WEEKS[i].label}（${WEEKS[i].range}）</div>
    <div class="preview"><b>${esc(m.name)}</b><br>この週の予定：${esc(fmtUnits(pc.items, m.suffix)) || 'なし'}（${planned}${subjUnit(m, pc.items)}）</div>
    <div class="field"><span class="lab">実際に終わった量</span><div class="countrow">${Array.from({ length: max + 1 }, (_, k) => `<button class="btn" type="button" data-n="${k}">${k}</button>`).join('')}</div>
    <small>予定より少ないときは、残りが翌週以降に自動で繰り越されます。多いときは先に進みます。</small></div>
    <div class="actions">${c.actual != null ? '<button class="btn ghost" data-m="clear" type="button">記録を消す</button>' : ''}<span class="sp"></span><button class="btn" data-m="cancel" type="button">キャンセル</button><button class="btn primary" data-m="save" type="button">記録する</button></div>`);
  const draw = () => dialog.querySelectorAll('[data-n]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.n === val));
  draw();
  dialog.onclick = async e => {
    const nb = e.target.closest('[data-n]'); if (nb) { val = +nb.dataset.n; draw(); return; }
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'cancel') return closeModal();
    lockDialog(true);
    try {
      await mutate('api_setActual', m.id, WEEKS[i].iso, b.dataset.m === 'clear' ? null : val, planned);
      closeModal(); render(); afterChange(st.id);
    } catch (err) { lockDialog(false); }
  };
}

/* deadline decisions */
function afterChange(sid) {
  if (D.role === 'student') return;
  const st = studentById(sid);
  if (st && pending(st).some(x => !x.acked)) decideDialog(st);
}
function modeArgs(st, m, mode) {
  const sim = JSON.parse(JSON.stringify(st)); const sm = findMat(sim, m.id).m; sm.mode = mode;
  const r = schedule(sim, sm);
  if (mode === 'fit') return r.over ? null : ['fit', '', ''];
  return ['shift', r.complete && r.endIdx >= 0 ? WEEKS[r.endIdx].iso : WEEKS[WEEKS.length - 1].iso, endLabel(r)];
}
function decideDialog(st0) {
  openModal(`<h2>期限を超える教材があります</h2><div class="sub">${esc(st0.name)}　教材ごとに調整方法を選んでください。選んだ内容は上原さんのダッシュボードにも表示されます。</div><div id="decList"></div><div class="actions"><button class="btn" data-m="later" type="button">あとで決める</button></div>`);
  const sid = st0.id;
  const draw = () => {
    const st = studentById(sid);
    const need = pending(st).filter(x => !x.acked);
    if (!need.length) { closeModal(); toast('調整方法を保存しました'); return; }
    dialog.querySelector('#decList').innerHTML = need.map(x => `<div class="decide"><p><b>${esc(x.sub.name)}「${esc(x.m.name)}」</b><br>期限 ${WEEKS[x.r.dl].label} のところ、このままだと <b>${esc(endLabel(x.r))}</b> に終わる見込みです。</p>
      <div class="row"><button class="btn" data-dec="shift" data-mat="${esc(x.m.id)}">後ろにずらす<span class="muted" style="font-weight:400;font-size:12px">（週${x.m.pace}のまま・期限を延ばす）</span></button>
      <button class="btn primary" data-dec="fit" data-mat="${esc(x.m.id)}">期限内に詰める<span style="font-weight:400;font-size:12px">（残りの週に配分）</span></button></div></div>`).join('');
  };
  draw();
  dialog.onclick = async e => {
    const d = e.target.closest('[data-dec]');
    if (d) {
      const st = studentById(sid); const { m } = findMat(st, d.dataset.mat);
      const args = modeArgs(st, m, d.dataset.dec);
      if (!args) { toast('期限までに使える週が残っていないため、詰められません。「後ろにずらす」を選んでください'); return; }
      lockDialog(true);
      try { await mutate('api_setMode', m.id, ...args); render(); lockDialog(false); draw(); } catch (err) { lockDialog(false); }
      return;
    }
    if (e.target.closest('[data-m]')) closeModal();
  };
}

/* admin: material editor */
function matDialog(st, si, matId) {
  const isNew = !matId;
  const hit = matId ? findMat(st, matId) : null;
  const sub = hit ? hit.sub : st.subjects[si];
  const m = hit ? hit.m : { cat: '', name: '', units: '', suffix: '講', pace: 1, start: WEEKS[TODAY].iso, deadline: WEEKS[Math.min(WEEKS.length - 1, TODAY + 8)].iso, note: '' };
  openModal(`<h2>${isNew ? '教材を追加' : '教材を編集'}</h2><div class="sub">${esc(st.name)}　${esc(sub.name)}　ここで決めるのは年間の大枠だけです。週ごとの配置は自動で決まります。</div>
    <div class="grid2"><div class="field"><label for="fCat">分類</label><input id="fCat" value="${esc(m.cat)}" placeholder="例：英文法"></div>
    <div class="field"><label for="fSuffix">単位</label><input id="fSuffix" value="${esc(m.suffix)}" placeholder="例：講、回、章"></div></div>
    <div class="field"><label for="fName">教材名</label><input id="fName" value="${esc(m.name)}" placeholder="例：スタンダードレベル英語＜文法編＞"></div>
    <div class="field"><label for="fUnits">進める範囲（順番どおり）</label><input id="fUnits" value="${esc(m.units)}" placeholder="例：1-24　または　level2, level3, level4"><small>「1-24」のように範囲で書くか、カンマで区切って並べます。同じものを2回書くと復習の週になります。</small></div>
    <div class="grid2"><div class="field"><label for="fPace">1週あたりの量</label><input id="fPace" type="number" min="0.5" step="0.5" value="${esc(m.pace)}"></div>
    <div class="field"><label for="fNote">メモ（任意）</label><input id="fNote" value="${esc(m.note)}" placeholder="例：塾でコピー"></div></div>
    <div class="grid2"><div class="field"><label for="fStart">開始週</label><select id="fStart">${weekOptions(m.start)}</select></div>
    <div class="field"><label for="fDl">期限の週</label><select id="fDl">${weekOptions(m.deadline)}</select></div></div>
    ${isNew ? '' : '<p class="muted" style="font-size:12.5px;margin:0 0 8px">保存すると、この教材の「後ろにずらす／詰める」の選択はリセットされます。記録済みの実績はそのまま残ります。</p>'}
    <p id="fErr" class="err" hidden></p>
    <div class="actions">${isNew ? '' : '<button class="btn ghost" data-m="del" type="button" style="color:var(--rest)">この教材を削除</button>'}<span class="sp"></span><button class="btn" data-m="cancel" type="button">キャンセル</button><button class="btn primary" data-m="save" type="button">保存</button></div>`);
  let delArmed = false;
  dialog.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'cancel') return closeModal();
    if (b.dataset.m === 'del') {
      if (!delArmed) { delArmed = true; b.textContent = 'もう一度押すと削除します（実績も消えます）'; return; }
      lockDialog(true);
      try { await mutate('api_deleteMaterial', m.id); closeModal(); render(); } catch (err) { lockDialog(false); }
      return;
    }
    const v = id => dialog.querySelector(id).value.trim();
    const err = dialog.querySelector('#fErr');
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (!v('#fName')) return fail('教材名を入力してください');
    if (!parseUnits(v('#fUnits')).length) return fail('進める範囲を入力してください（例：1-24）');
    if (!(+v('#fPace') > 0)) return fail('1週あたりの量は0より大きい数にしてください');
    if (v('#fDl') < v('#fStart')) return fail('期限の週は開始週より後にしてください');
    lockDialog(true);
    try {
      await mutate('api_saveMaterial', st.id, sub.name, { id: isNew ? '' : m.id, cat: v('#fCat'), name: v('#fName'), units: v('#fUnits'), suffix: v('#fSuffix'), pace: +v('#fPace'), note: v('#fNote'), start: v('#fStart'), deadline: v('#fDl') });
      closeModal(); render();
    } catch (er) { lockDialog(false); }
  };
}
function commentDialog(st, si) {
  const sub = st.subjects[si];
  openModal(`<h2>上原コメント（${esc(sub.name)}）</h2><div class="sub">${esc(st.name)}</div><div class="field"><label for="fCom">コメント</label><textarea id="fCom">${esc(sub.comment)}</textarea></div><div class="actions"><button class="btn" data-m="cancel" type="button">キャンセル</button><button class="btn primary" data-m="save" type="button">保存</button></div>`);
  dialog.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'cancel') return closeModal();
    lockDialog(true);
    try { await mutate('api_saveComment', st.id, sub.name, dialog.querySelector('#fCom').value); closeModal(); render(); } catch (er) { lockDialog(false); }
  };
}
function studentDialog(st) {
  const isNew = !st;
  const s = st || { name: '', goal: '', teacher: '', subjects: [{ name: '英語' }, { name: '数学' }] };
  openModal(`<h2>${isNew ? '生徒を追加' : '生徒の情報を編集'}</h2><div class="sub">${isNew ? '登録すると専用URLが作られます。教材はあとから追加します。' : esc(s.name)}</div>
    <div class="field"><label for="sName">氏名</label><input id="sName" value="${esc(s.name)}" placeholder="例：比嘉 太郎"></div>
    <div class="field"><label for="sGoal">志望校・学部</label><input id="sGoal" value="${esc(s.goal)}" placeholder="例：琉球大学 教育学部"></div>
    <div class="grid2"><div class="field"><label for="sT">担当講師</label><select id="sT"><option value="">未設定</option>${D.teachers.map(t => `<option value="${esc(t.id)}"${t.id === s.teacher ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="sSub">科目（カンマ区切り）</label><input id="sSub" value="${esc(s.subjects.map(x => x.name).join(','))}"><small>例：英語,数学,国語</small></div></div>
    <p id="sErr" class="err" hidden>氏名を入力してください</p>
    <div class="actions"><button class="btn" data-m="cancel" type="button">キャンセル</button><button class="btn primary" data-m="save" type="button">${isNew ? '追加' : '保存'}</button></div>`);
  dialog.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'cancel') return closeModal();
    const info = { name: dialog.querySelector('#sName').value.trim(), goal: dialog.querySelector('#sGoal').value.trim(), teacher: dialog.querySelector('#sT').value, subjects: dialog.querySelector('#sSub').value.trim() };
    if (!info.name) { dialog.querySelector('#sErr').hidden = false; return; }
    lockDialog(true);
    try {
      const p = await mutate(isNew ? 'api_addStudent' : 'api_updateStudent', ...(isNew ? [info] : [st.id, info]));
      closeModal(); if (isNew && p.newStudent) ui.sel = p.newStudent; render();
    } catch (er) { lockDialog(false); }
  };
}
function renameTeacherDialog(t) {
  openModal(`<h2>講師の名前を変更</h2><div class="field"><label for="tName">名前</label><input id="tName" value="${esc(t.name)}"></div><div class="actions"><button class="btn" data-m="cancel" type="button">キャンセル</button><button class="btn primary" data-m="save" type="button">保存</button></div>`);
  dialog.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'cancel') return closeModal();
    lockDialog(true);
    try { await mutate('api_renameTeacher', t.id, dialog.querySelector('#tName').value.trim()); closeModal(); render(); } catch (er) { lockDialog(false); }
  };
}
function renewDialog(kind, id) {
  const who = kind === 'teacher' ? D.teachers.find(t => t.id === id) : studentById(id);
  openModal(`<h2>URLを作り直しますか</h2><div class="sub">${esc(who.name)}さん</div><p style="margin:0 0 12px">今のURLは使えなくなります。新しいURLを${esc(who.name)}さんに渡し直してください。</p><div class="actions"><button class="btn" data-m="cancel" type="button">キャンセル</button><button class="btn primary" data-m="save" type="button">作り直す</button></div>`);
  dialog.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'cancel') return closeModal();
    lockDialog(true);
    try { await mutate('api_renewKey', kind, id); closeModal(); render(); toast('新しいURLを作りました'); } catch (er) { lockDialog(false); }
  };
}

/* ---------- PDF ---------- */
const loaded = {};
function loadScript(src) {
  if (loaded[src]) return loaded[src];
  return loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error('load')); }; document.head.appendChild(s); });
}
function printSheet(st) {
  const d = new Date();
  return `<div class="print-sheet">
    <div class="plan-title"><div class="titlebox">${esc(st.name.replace(/\s+/g, ''))} 学習計画</div><div class="titlebox goal">${st.goal ? esc(st.goal) + ' に受かるための' : ''}専用ロードマップ（${periodLabel()}）</div></div>
    ${st.subjects.map((sub, si) => `<section><div class="subject-label">${esc(sub.name)}</div><div class="subj-grid"><div class="tablewrap">${planTable(st, sub, 'student', windowWeeks(), { print: true })}</div>${noteBox(st, sub, si, 'student', true)}</div></section>`).join('')}
    <div class="print-foot"><span>斜線の週は「休み」、黄色の週は「半分」の週です。</span><span>${esc(D.school)}　${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 作成</span></div>
  </div>`;
}
let lastPdfUrl = null;
async function exportPdf(st, btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'PDFを作成中…';
  const stage = document.getElementById('pdfStage');
  try {
    await Promise.all([
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'),
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
    ]);
    stage.innerHTML = printSheet(st);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const canvas = await window.html2canvas(stage.firstElementChild, { scale: 2, backgroundColor: '#ffffff', logging: false });
    const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pw = 297, ph = 210, mg = 8, ratio = canvas.width / canvas.height;
    let w = pw - mg * 2, h = w / ratio;
    if (h > ph - mg * 2) { h = ph - mg * 2; w = h * ratio; }
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (pw - w) / 2, mg, w, h);
    const name = `学習計画_${st.name.replace(/\s+/g, '')}_${periodLabel()}.pdf`;
    const blob = pdf.output('blob');
    if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
    lastPdfUrl = URL.createObjectURL(blob);
    let file = null;
    try { file = new File([blob], name, { type: 'application/pdf' }); } catch (er) {}
    const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    openModal(`<h2>PDFができました</h2><div class="sub">${esc(name)}</div><p style="margin:0 0 12px">A4横1枚です。${canShare ? '「共有・保存」から、ファイルに保存したり、LINEで送ったり、印刷したりできます。' : ''}</p>
      <div class="actions"><button class="btn" data-m="cancel" type="button">閉じる</button>${canShare ? '<button class="btn primary" data-m="share" type="button">共有・保存</button>' : `<a class="btn" href="${lastPdfUrl}" target="_blank" rel="noopener">開く</a><a class="btn primary" href="${lastPdfUrl}" download="${esc(name)}">ダウンロード</a>`}</div>`);
    dialog.onclick = async e => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      if (b.dataset.m === 'share') {
        try { await navigator.share({ files: [file], title: name }); closeModal(); }
        catch (er) { if (er && er.name !== 'AbortError') toast('共有できませんでした。もう一度押してください'); }
        return;
      }
      closeModal();
    };
  } catch (e) {
    toast(e && e.message === 'load' ? 'PDF作成の部品を読み込めませんでした。通信を確認してもう一度押してください' : 'PDFを作成できませんでした。もう一度押してください');
  } finally {
    stage.innerHTML = ''; btn.disabled = false; btn.textContent = label;
  }
}

/* ---------- events ---------- */
const app = document.getElementById('app');
app.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t || !D) return;
  const act = t.dataset.act, st = t.dataset.id && studentById(t.dataset.id);
  switch (act) {
    case 'open-student': ui.sel = t.dataset.id; render(); window.scrollTo(0, 0); break;
    case 'back': ui.sel = null; render(); window.scrollTo(0, 0); break;
    case 'week': weekDialog(st, +t.dataset.i); break;
    case 'cell': cellDialog(st, t.dataset.mat, +t.dataset.i); break;
    case 'mode': {
      const { m } = findMat(st, t.dataset.mat);
      if (m.mode === t.dataset.mode && (m.mode === 'fit' || m.extendTo)) break;
      const args = modeArgs(st, m, t.dataset.mode);
      if (!args) { toast('期限までに使える週が残っていないため、詰められません'); break; }
      try { await mutate('api_setMode', m.id, ...args); render(); } catch (er) {}
      break;
    }
    case 'decide-open': decideDialog(st); break;
    case 'edit-mat': matDialog(st, null, t.dataset.mat); break;
    case 'add-mat': matDialog(st, +t.dataset.si, null); break;
    case 'move': try { await mutate('api_moveMaterial', t.dataset.mat, +t.dataset.dir); render(); } catch (er) {} break;
    case 'edit-comment': commentDialog(st, +t.dataset.si); break;
    case 'add-student': studentDialog(null); break;
    case 'edit-student': studentDialog(st); break;
    case 'rename-teacher': renameTeacherDialog(D.teachers.find(x => x.id === t.dataset.id)); break;
    case 'renew': renewDialog(t.dataset.kind, t.dataset.id); break;
    case 'prev': ui.base -= 1; render(); break;
    case 'next': ui.base += 1; render(); break;
    case 'thismonth': ui.base = WEEKS[TODAY].y * 12 + (WEEKS[TODAY].m - 1); ui.span = 3; render(); break;
    case 'span': ui.span = t.dataset.span === 'all' ? 'all' : 3; render(); break;
    case 'pdf': exportPdf(st, t); break;
    case 'copy': {
      const text = t.dataset.text;
      const fallback = () => { const c = t.closest('.urlrow').querySelector('code'); const rg = document.createRange(); rg.selectNodeContents(c); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); toast('URLを選択しました。コピーしてください'); };
      try { navigator.clipboard.writeText(text).then(() => toast('URLをコピーしました'), fallback); } catch (er) { fallback(); }
      break;
    }
  }
});
app.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.act === 'assign') {
    try { await mutate('api_updateStudent', t.dataset.id, { teacher: t.value }); render(); toast('担当講師を変更しました'); } catch (er) { render(); }
  }
});
app.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form="add-teacher"]'); if (!f) return;
  e.preventDefault();
  const name = f.querySelector('#newTeacher').value.trim();
  if (!name) { toast('講師の名前を入力してください'); return; }
  try { await mutate('api_addTeacher', name); render(); toast(`${name}さんを追加しました`); } catch (er) {}
});

/* ---------- login / refresh / menu ---------- */
const appTitle = KIND === 'student' ? '文殊 学習計画' : '文殊 学習計画ボード';
function loginView(msg) {
  document.getElementById('who').innerHTML = '';
  app.innerHTML = `<section class="panel login">
    <img class="login-icon" src="${KIND}-192.png" alt="" width="72" height="72">
    <div class="eyebrow">${KIND === 'student' ? '生徒用' : '講師用'}</div>
    <h1>${esc(appTitle)}</h1>
    <p>はじめて使うときだけ、塾から届いた専用URLを貼り付けてください。次からは、このアプリを開くだけで使えます。</p>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <form data-form="login" novalidate>
      <div class="field"><label for="loginUrl">専用URL</label><input id="loginUrl" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://… から始まる専用URL"></div>
      <button class="btn primary" type="submit">はじめる</button>
    </form>
  </section>`;
  hideSplash();
}
async function boot(silent) {
  if (!silent) app.innerHTML = skeleton();
  try {
    const p = await call('api_boot');
    setData(p);
    if (ui.sel && !studentById(ui.sel)) ui.sel = null;
    if (D.role === 'student' && D.students[0]) ui.sel = D.students[0].id;
    if (modal.hidden) render();
  } catch (e) {
    if (e.server && /URL/.test(e.message)) { lsDel(LS_KEY); lsDel(LS_CACHE); KEY = ''; D = null; loginView(cleanErr(e)); return; }
    if (D) { toast(e.offline ? '通信できないため、前回読み込んだ内容を表示しています' : cleanErr(e)); return; }
    app.innerHTML = `<div class="empty">${esc(cleanErr(e))}<div style="margin-top:12px"><button class="btn" type="button" data-shell="retry">もう一度読み込む</button></div></div>`;
    hideSplash();
  }
}
const fmtClock = t => { if (!t) return '—'; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function menuDialog() {
  openModal(`<h2>メニュー</h2><div class="sub">最後に読み込んだ時刻：${fmtClock(loadedAt)}</div>
    <div class="menu-list">
      <button class="btn" type="button" data-m="refresh">最新の状態に更新</button>
      <button class="btn" type="button" data-m="logout">このスマホからログアウト</button>
      <button class="btn ghost" type="button" data-m="cancel">閉じる</button>
    </div>`);
  let armed = false;
  dialog.onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'refresh') { closeModal(); boot(true).then(() => toast('最新の状態にしました')); return; }
    if (b.dataset.m === 'logout') {
      if (!armed) { armed = true; b.textContent = 'もう一度押すとログアウトします'; return; }
      lsDel(LS_KEY); lsDel(LS_CACHE); KEY = ''; D = null; ui.sel = null; closeModal(); loginView(); return;
    }
    closeModal();
  };
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-shell]'); if (!t) return;
  if (t.dataset.shell === 'menu') menuDialog();
  else if (t.dataset.shell === 'retry') boot();
  else if (t.dataset.shell === 'install' && deferredInstall) { deferredInstall.prompt(); deferredInstall = null; hideInstall(); }
  else if (t.dataset.shell === 'hide-install') { lsSet('monju-hide-install', '1'); hideInstall(); }
});
app.addEventListener('submit', e => {
  const f = e.target.closest('[data-form="login"]'); if (!f) return;
  e.preventDefault();
  const k = keyFrom(f.querySelector('#loginUrl').value);
  if (!k) { loginView('URLの形が違います。塾から届いた専用URLを、そのまま全部貼り付けてください。'); return; }
  KEY = k; lsSet(LS_KEY, k); lsDel(LS_CACHE); D = null; ui.sel = null;
  boot();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && KEY && D && modal.hidden && busyN === 0 && Date.now() - loadedAt > 3 * 60 * 1000) boot(true);
});

/* ---------- install hint ---------- */
const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let deferredInstall = null;
const hintEl = document.getElementById('installHint');
function hideInstall() { if (hintEl) hintEl.hidden = true; }
function showInstall(html) { if (!hintEl || standalone || lsGet('monju-hide-install')) return; hintEl.innerHTML = `<div class="wrap">${html}<button class="linkbtn" type="button" data-shell="hide-install">今は表示しない</button></div>`; hintEl.hidden = false; }
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; showInstall(`<span>このアプリをホーム画面に追加できます。</span><button class="btn small primary" type="button" data-shell="install">ホーム画面に追加</button>`); });
if (isIOS && !standalone) showInstall(`<span>画面下の <b>共有ボタン</b> →「<b>ホーム画面に追加</b>」で、アプリとして使えます。</span>`);
// iPhoneはホーム画面のアプリとSafariで保存場所が別なので、ブラウザで開いている間はURLの鍵を残しておく
if (standalone && location.hash) history.replaceState(null, '', location.pathname);
if (!standalone && !isIOS && location.hash) history.replaceState(null, '', location.pathname);

if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {}); });

/* ---------- start ---------- */
if (!KEY) loginView();
else {
  let cached = null;
  try { cached = JSON.parse(lsGet(LS_CACHE) || 'null'); } catch (e) {}
  if (cached && cached.data) {
    try { setData(cached.data); loadedAt = cached.at || 0; if (D.role === 'student' && D.students[0]) ui.sel = D.students[0].id; render(); } catch (e) { D = null; }
  }
  boot(!!D);
}
})();
