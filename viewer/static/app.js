/* GPT-2 Output Explorer - browsing, reading and search */
'use strict';

/* sentinels the server wraps around search hits, swapped for <mark> after escaping */
const SNIP_OPEN = '\u0002';
const SNIP_CLOSE = '\u0003';
const $ = (id) => document.getElementById(id);

const state = {
  view: 'read',
  datasets: [],
  byId: {},
  dataset: 'all',
  query: '',
  mode: 'all',
  sort: 'index',
  offset: 0,
  limit: 40,
  listMode: 'browse',      // browse | search | bookmarks
  items: [],
  total: 0,
  docId: null,
  doc: null,
  matches: [],
  matchIdx: 0,
};

const prefs = loadPrefs();
const bookmarks = loadJSON('gpt2x.bookmarks', []);

/* ------------------------------------------------------------------ utils */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return (n ?? 0).toLocaleString(); }
function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = n || 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function loadJSON(k, dflt) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? dflt : v; }
  catch { return dflt; }
}
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

async function api(path, params) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    Array.isArray(v) ? v.forEach((x) => u.searchParams.append(k, x))
                     : u.searchParams.set(k, v);
  }
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function kindOf(ds) {
  if (!ds) return { cls: '', label: '' };
  if (ds.model === 'webtext') return { cls: 'human', label: 'human' };
  return ds.topk ? { cls: 'k40', label: 'top-k 40' } : { cls: 'temp', label: 'temp 1' };
}

/* ------------------------------------------------------------------ prefs */
function loadPrefs() {
  return Object.assign(
    { font: 'serif', size: 19, lh: 1.7, measure: 70, ls: 0, theme: 'dark', sidebar: 400 },
    loadJSON('gpt2x.prefs', {}));
}

function applyPrefs() {
  const fonts = { serif: 'var(--font-serif)', sans: 'var(--font-sans)', mono: 'var(--font-mono)' };
  const r = document.documentElement.style;
  r.setProperty('--doc-font', fonts[prefs.font]);
  r.setProperty('--doc-size', prefs.size + 'px');
  r.setProperty('--doc-lh', String(prefs.lh));
  r.setProperty('--measure', prefs.measure + 'ch');
  r.setProperty('--doc-ls', prefs.ls + 'em');
  r.setProperty('--sidebar-w', prefs.sidebar + 'px');
  document.documentElement.dataset.theme = prefs.theme;
  $('btnTheme').textContent = prefs.theme[0].toUpperCase() + prefs.theme.slice(1);
  $('vSize').textContent = prefs.size + 'px';
  $('vLh').textContent = prefs.lh.toFixed(2);
  $('vMeasure').textContent = prefs.measure + 'ch';
  $('vLs').textContent = prefs.ls.toFixed(3) + 'em';
  $('setSize').value = prefs.size;
  $('setLh').value = prefs.lh;
  $('setMeasure').value = prefs.measure;
  $('setLs').value = prefs.ls;
  for (const b of $('setFont').children) b.setAttribute('aria-pressed', String(b.dataset.v === prefs.font));
  for (const b of $('setTheme').children) b.setAttribute('aria-pressed', String(b.dataset.v === prefs.theme));
  saveJSON('gpt2x.prefs', prefs);
}

/* ---------------------------------------------------------------- sidebar */
function renderStatus(text, right) {
  $('sideStatus').innerHTML = `<span>${text}</span><span>${right || ''}</span>`;
}

function renderList() {
  const list = $('list');
  if (!state.items.length) {
    list.innerHTML = `<div class="empty">${
      state.listMode === 'search' ? 'No samples matched that query.'
      : state.listMode === 'bookmarks' ? 'No bookmarks yet - press <kbd>s</kbd> while reading a sample.'
      : 'Nothing here.'}</div>`;
    return;
  }
  list.innerHTML = state.items.map((it) => {
    const ds = state.byId[it.dataset_id];
    const k = kindOf(ds);
    const snip = it.snip !== undefined
      ? esc(it.snip).split(SNIP_OPEN).join('<mark>').split(SNIP_CLOSE).join('</mark>')
      : esc((it.preview || '').slice(0, 300)).replace(/\n+/g, ' ');
    return `<div class="item" data-id="${it.id}" aria-current="${it.id === state.docId}">
      <div class="item-head">
        <span class="badge ${k.cls}">${esc(ds ? ds.source : '?')}</span>
        <span>#${fmt(it.doc_index)}</span>
        <span>${fmt(it.n_tokens)} tok</span>
        ${ds ? `<span>${esc(ds.split)}</span>` : ''}
      </div>
      <div class="item-snip">${snip}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.item').forEach((el) =>
    el.addEventListener('click', () => openDoc(Number(el.dataset.id))));
}

function renderPager() {
  const p = $('pager');
  if (state.listMode === 'bookmarks' || state.total <= state.limit) { p.hidden = true; return; }
  p.hidden = false;
  const from = state.offset + 1, to = Math.min(state.offset + state.limit, state.total);
  $('pageInfo').textContent = `${fmt(from)}-${fmt(to)} of ${fmt(state.total)}`;
  $('prevPage').disabled = state.offset === 0;
  $('nextPage').disabled = to >= state.total;
}

async function loadList(resetOffset) {
  if (resetOffset) state.offset = 0;
  const dsParam = state.dataset === 'all' ? undefined : state.dataset;
  try {
    if (state.listMode === 'bookmarks') {
      renderStatus('Bookmarks');
      const docs = [];
      for (const id of bookmarks.slice().reverse()) {
        try {
          const { doc } = await api('/api/doc', { id });
          docs.push({ ...doc, preview: doc.text.slice(0, 300) });
        } catch {}
      }
      state.items = docs;
      state.total = docs.length;
      renderStatus(`<b>${fmt(docs.length)}</b> bookmarked`);
    } else if (state.listMode === 'search') {
      renderStatus('Searching...');
      const r = await api('/api/search', {
        q: state.query, mode: state.mode, dataset: dsParam,
        offset: state.offset, limit: state.limit,
      });
      state.items = r.results;
      state.total = r.total;
      const per = Object.entries(r.by_dataset)
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([id, c]) => `${state.byId[id] ? state.byId[id].source : id} ${fmt(c)}`).join(' · ');
      renderStatus(`<b>${fmt(r.total)}${r.capped ? '+' : ''}</b> matching samples`, esc(per));
    } else {
      const r = await api('/api/docs', {
        dataset: dsParam, offset: state.offset, limit: state.limit, sort: state.sort,
      });
      state.items = r.docs;
      state.total = r.total;
      renderStatus(`<b>${fmt(r.total)}</b> samples`,
        state.dataset === 'all' ? 'all datasets' : esc(state.dataset));
    }
  } catch (e) {
    state.items = [];
    state.total = 0;
    $('list').innerHTML = `<div class="error">${esc(e.message)}</div>`;
    renderStatus('Error');
    renderPager();
    return;
  }
  renderList();
  renderPager();
}

/* ----------------------------------------------------------------- reader */
function queryTerms() {
  if (state.listMode !== 'search' || !state.query) return [];
  if (state.mode === 'phrase') return [state.query.trim()];
  return (state.query.match(/"[^"]+"|[\w'-]+/g) || [])
    .map((t) => t.replace(/^"|"$/g, '').trim())
    .filter((t) => t.length > 1);
}

function highlight(text, terms) {
  const html = esc(text);
  if (!terms.length) return html;
  const rx = new RegExp('(' + terms.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\w*'
  ).join('|') + ')', 'gi');
  return html.replace(rx, '<mark>$1</mark>');
}

function renderDoc() {
  const d = state.doc;
  const reader = $('reader');
  if (!d) { reader.innerHTML = '<div class="empty">Nothing loaded.</div>'; return; }
  const ds = d.dataset, k = kindOf(ds);
  const starred = bookmarks.includes(d.id);
  $('btnStar').textContent = starred ? '★ Saved' : '☆ Save';
  $('btnStar').classList.toggle('active', starred);
  $('docMeta').textContent =
    `${ds.source}.${ds.split}  #${fmt(d.doc_index)}  ·  ${fmt(d.n_tokens)} tokens · ${fmt(d.n_words)} words`;

  reader.innerHTML = `
    <div class="doc-header">
      <h2>${esc(ds.source)} <span style="color:var(--text-muted);font-weight:400">/ ${esc(ds.split)} / sample ${fmt(d.doc_index)}</span></h2>
      <div class="sub">
        <span class="badge ${k.cls}">${k.label}</span>
        <span>${fmt(d.n_tokens)} BPE tokens</span>
        <span>${fmt(d.n_words)} words</span>
        <span>${fmt(d.n_chars)} chars</span>
        <span>${d.ended ? 'ended naturally' : 'truncated at length limit'}</span>
        ${d.orig_id !== null ? `<span>id ${fmt(d.orig_id)}</span>` : ''}
      </div>
      <hr>
    </div>
    <article class="doc" id="docBody">${highlight(d.text, queryTerms())}</article>`;

  state.matches = [...reader.querySelectorAll('.doc mark')];
  state.matchIdx = -1;
  $('matchNav').hidden = state.matches.length === 0;
  $('matchInfo').textContent = state.matches.length ? `0/${state.matches.length}` : '';
  if (state.matches.length) gotoMatch(0);
  else reader.scrollTop = 0;

  $('btnPrevDoc').disabled = !d.prev_id;
  $('btnNextDoc').disabled = !d.next_id;
  saveJSON('gpt2x.last', d.id);
}

function gotoMatch(i) {
  if (!state.matches.length) return;
  const n = state.matches.length;
  state.matchIdx = ((i % n) + n) % n;
  state.matches.forEach((m) => m.classList.remove('current'));
  const el = state.matches[state.matchIdx];
  el.classList.add('current');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('matchInfo').textContent = `${state.matchIdx + 1}/${n}`;
}

async function openDoc(id, push = true) {
  try {
    const { doc } = await api('/api/doc', { id });
    state.docId = doc.id;
    state.doc = doc;
    renderDoc();
    $('list').querySelectorAll('.item').forEach((el) =>
      el.setAttribute('aria-current', String(Number(el.dataset.id) === doc.id)));
    const cur = $('list').querySelector('.item[aria-current="true"]');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    if (push) history.replaceState(null, '', `#doc/${doc.id}`);
  } catch (e) {
    $('reader').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

async function stepDoc(delta) {
  if (!state.doc) return;
  // inside a result list, step through the list; otherwise walk the dataset in order
  const idx = state.items.findIndex((it) => it.id === state.docId);
  if (idx !== -1 && state.items[idx + delta]) return openDoc(state.items[idx + delta].id);
  if (idx !== -1 && state.listMode !== 'browse') {
    if (delta > 0 && state.offset + state.limit < state.total) {
      state.offset += state.limit;
      await loadList(false);
      if (state.items[0]) return openDoc(state.items[0].id);
    } else if (delta < 0 && state.offset > 0) {
      state.offset -= state.limit;
      await loadList(false);
      const last = state.items[state.items.length - 1];
      if (last) return openDoc(last.id);
    }
    return;
  }
  const target = delta > 0 ? state.doc.next_id : state.doc.prev_id;
  if (target) openDoc(target);
}

/* ------------------------------------------------------------------- view */
function setView(v) {
  state.view = v;
  $('main').dataset.view = v;
  $('tabRead').setAttribute('aria-selected', String(v === 'read'));
  $('tabAnalytics').setAttribute('aria-selected', String(v === 'analytics'));
  if (v === 'analytics') {
    history.replaceState(null, '', '#analytics');
    renderAnalytics($('analyticsWrap'));
  } else if (state.docId) {
    history.replaceState(null, '', `#doc/${state.docId}`);
  }
}

function toggleBookmark() {
  if (!state.doc) return;
  const i = bookmarks.indexOf(state.doc.id);
  i === -1 ? bookmarks.push(state.doc.id) : bookmarks.splice(i, 1);
  saveJSON('gpt2x.bookmarks', bookmarks);
  $('bmCount').textContent = bookmarks.length;
  renderDoc();
  if (state.listMode === 'bookmarks') loadList(true);
}

/* ------------------------------------------------------------------- wire */
async function doSearch(autoOpen) {
  const q = $('q').value.trim();
  state.query = q;
  if (state.listMode !== 'bookmarks') state.listMode = q ? 'search' : 'browse';
  await loadList(true);
  // an explicit search (Enter / Go / a keyword chip) drops you straight into
  // the best hit; the as-you-type search does not, so the reader stays still
  if (autoOpen && state.listMode === 'search' && state.items.length) {
    openDoc(state.items[0].id);
  }
}

function bind() {
  $('tabRead').onclick = () => setView('read');
  $('tabAnalytics').onclick = () => setView('analytics');

  $('btnSearch').onclick = () => doSearch(true);
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(true);
    if (e.key === 'Escape') { $('q').value = ''; $('q').blur(); doSearch(false); }
  });
  let t = null;
  $('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => doSearch(false), 350); });

  $('dsSelect').onchange = (e) => { state.dataset = e.target.value; loadList(true); };
  $('mode').onchange = (e) => { state.mode = e.target.value; if (state.query) loadList(true); };
  $('sort').onchange = (e) => { state.sort = e.target.value; if (state.listMode === 'browse') loadList(true); };

  $('prevPage').onclick = () => { state.offset = Math.max(0, state.offset - state.limit); loadList(false); };
  $('nextPage').onclick = () => { state.offset += state.limit; loadList(false); };

  $('btnPrevDoc').onclick = () => stepDoc(-1);
  $('btnNextDoc').onclick = () => stepDoc(1);
  $('prevMatch').onclick = () => gotoMatch(state.matchIdx - 1);
  $('nextMatch').onclick = () => gotoMatch(state.matchIdx + 1);
  $('btnStar').onclick = toggleBookmark;
  $('btnCopy').onclick = async () => {
    if (!state.doc) return;
    try {
      await navigator.clipboard.writeText(state.doc.text);
      $('btnCopy').textContent = 'Copied';
    } catch { $('btnCopy').textContent = 'Blocked'; }
    setTimeout(() => ($('btnCopy').textContent = 'Copy'), 1200);
  };
  $('btnRandom').onclick = randomDoc;
  $('btnBookmarks').onclick = () => {
    state.listMode = state.listMode === 'bookmarks' ? (state.query ? 'search' : 'browse') : 'bookmarks';
    $('btnBookmarks').classList.toggle('active', state.listMode === 'bookmarks');
    setView('read');
    loadList(true);
  };
  $('btnToggleSidebar').onclick = () => $('sidebar').classList.toggle('collapsed');
  $('btnTheme').onclick = cycleTheme;
  $('btnSettings').onclick = () => {
    $('helpPanel').hidden = true;
    $('settingsPanel').hidden = !$('settingsPanel').hidden;
  };
  $('btnHelp').onclick = () => {
    $('settingsPanel').hidden = true;
    $('helpPanel').hidden = !$('helpPanel').hidden;
  };

  $('setSize').oninput = (e) => { prefs.size = +e.target.value; applyPrefs(); };
  $('setLh').oninput = (e) => { prefs.lh = +e.target.value; applyPrefs(); };
  $('setMeasure').oninput = (e) => { prefs.measure = +e.target.value; applyPrefs(); };
  $('setLs').oninput = (e) => { prefs.ls = +e.target.value; applyPrefs(); };
  $('setFont').onclick = (e) => { if (e.target.dataset.v) { prefs.font = e.target.dataset.v; applyPrefs(); } };
  $('setTheme').onclick = (e) => {
    if (e.target.dataset.v) { prefs.theme = e.target.dataset.v; applyPrefs(); redrawAnalytics(); }
  };
  $('setReset').onclick = () => {
    Object.assign(prefs, { font: 'serif', size: 19, lh: 1.7, measure: 70, ls: 0 });
    applyPrefs();
  };

  let dragging = false;
  $('resizer').addEventListener('mousedown', (e) => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    prefs.sidebar = Math.min(720, Math.max(260, e.clientX));
    document.documentElement.style.setProperty('--sidebar-w', prefs.sidebar + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    saveJSON('gpt2x.prefs', prefs);
  });

  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', routeFromHash);
}

function cycleTheme() {
  const order = ['dark', 'sepia', 'light'];
  prefs.theme = order[(order.indexOf(prefs.theme) + 1) % order.length];
  applyPrefs();
  redrawAnalytics();
}

async function randomDoc() {
  setView('read');
  const { doc } = await api('/api/random',
    { dataset: state.dataset === 'all' ? undefined : state.dataset });
  state.docId = doc.id;
  state.doc = doc;
  renderDoc();
  history.replaceState(null, '', `#doc/${doc.id}`);
}

function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === 'Escape') { $('settingsPanel').hidden = true; $('helpPanel').hidden = true; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case '/': e.preventDefault(); $('q').focus(); $('q').select(); break;
    case 'j': case 'ArrowRight': e.preventDefault(); stepDoc(1); break;
    case 'k': case 'ArrowLeft': e.preventDefault(); stepDoc(-1); break;
    case 'n': gotoMatch(state.matchIdx + 1); break;
    case 'N': gotoMatch(state.matchIdx - 1); break;
    case 'r': randomDoc(); break;
    case 's': toggleBookmark(); break;
    case 'b': $('btnBookmarks').click(); break;
    case 't': cycleTheme(); break;
    case '\\': $('sidebar').classList.toggle('collapsed'); break;
    case '?': $('btnHelp').click(); break;
    case '=': case '+': prefs.size = Math.min(30, prefs.size + 1); applyPrefs(); break;
    case '-': prefs.size = Math.max(14, prefs.size - 1); applyPrefs(); break;
    case 'g': {
      const ds = state.dataset === 'all'
        ? (state.doc ? state.doc.dataset.name : 'webtext.test')
        : state.dataset;
      const v = prompt('Go to sample index (0-based) in ' + ds);
      if (v === null) return;
      api('/api/doc', { dataset: ds, index: parseInt(v, 10) || 0 })
        .then(({ doc }) => { state.docId = doc.id; state.doc = doc; renderDoc(); })
        .catch((err) => alert(err.message));
      break;
    }
  }
}

function routeFromHash() {
  const h = location.hash.slice(1);
  if (h === 'analytics') { setView('analytics'); return true; }
  const m = h.match(/^doc\/(\d+)$/);
  if (m) { setView('read'); openDoc(Number(m[1]), false); return true; }
  return false;
}

/* -------------------------------------------------- shared with analytics */
window.explorer = {
  openSearch(term, mode) {
    $('q').value = term;
    $('mode').value = mode || 'all';
    state.mode = mode || 'all';
    state.listMode = 'search';
    $('btnBookmarks').classList.remove('active');
    setView('read');
    doSearch(true);
  },
  api, esc, fmt, bytes, kindOf,
};

/* ------------------------------------------------------------------- init */
async function init() {
  applyPrefs();
  bind();
  $('bmCount').textContent = bookmarks.length;

  const { datasets } = await api('/api/datasets');
  state.datasets = datasets;
  datasets.forEach((d) => (state.byId[d.id] = d));

  const totalDocs = datasets.reduce((a, d) => a + (d.n_docs || 0), 0);
  $('dsSelect').innerHTML = `<option value="all">All datasets (${fmt(totalDocs)})</option>` +
    ['test', 'valid', 'train'].map((split) => {
      const items = datasets.filter((d) => d.split === split);
      if (!items.length) return '';
      return `<optgroup label="${split}">` + items.map((d) =>
        `<option value="${esc(d.name)}">${esc(d.source)} · ${split} (${fmt(d.n_docs)})</option>`)
        .join('') + '</optgroup>';
    }).join('');
  $('corpusSize').textContent =
    `${fmt(totalDocs)} samples · ${bytes(datasets.reduce((a, d) => a + (d.file_bytes || 0), 0))}`;

  await loadList(true);
  if (!routeFromHash()) {
    const last = loadJSON('gpt2x.last', null);
    if (last) openDoc(last, false).catch(() => {});
    else if (state.items[0]) openDoc(state.items[0].id, false);
  }
}

init().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="error">Failed to start: ${esc(e.message)}</div>`);
});
