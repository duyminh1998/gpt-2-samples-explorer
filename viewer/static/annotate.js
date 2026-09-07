/* Annotations: highlights, underlines, strikethrough and notes on samples.
 *
 * Everything lives in localStorage under gpt2x.annos, keyed by document id:
 *
 *   { "<docId>": [ {id, start, end, style, color, note, quote, ...meta} ] }
 *
 * start/end are character offsets into the sample's raw text, so a mark is
 * re-applied every time the sample is opened again - from the list, from a
 * search, from a bookmark, from the notes panel. `quote` is kept alongside so a
 * mark can be re-found if the offsets ever stop lining up (a re-index that
 * shifted document ids, say); anything that cannot be re-found is held onto but
 * not drawn, rather than silently thrown away.
 */
'use strict';

const ANNO_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];

const Anno = (() => {
  const KEY = 'gpt2x.annos';
  const PREF_KEY = 'gpt2x.annopref';

  let store = read(KEY, {});          // docId -> [annotation]
  let pref = read(PREF_KEY, { color: 'yellow', style: 'highlight' });
  let cur = null;                     // the document on screen
  let sel = null;                     // pending selection {start, end}
  let editing = null;                 // annotation open in the popover

  function read(k, dflt) {
    try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? dflt : v; }
    catch { return dflt; }
  }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function save() { write(KEY, store); updateCounts(); }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.explorer.esc(s);

  /* ---------------------------------------------------------------- store */
  function listFor(docId) { return store[docId] || []; }

  function setList(docId, list) {
    if (list.length) store[docId] = list;
    else delete store[docId];
    save();
  }

  function all() {
    return Object.entries(store).flatMap(([docId, list]) =>
      list.map((a) => ({ ...a, docId: Number(docId) })));
  }

  function total() { return all().length; }
  function countFor(docId) { return listFor(docId).length; }

  function find(docId, id) { return listFor(docId).find((a) => a.id === id) || null; }

  /* Re-anchor marks whose offsets no longer land on the text they were made
     on. Returns only the ones that can actually be drawn. */
  function resolve(text, list) {
    let dirty = false;
    const live = [];
    for (const a of list) {
      if (text.slice(a.start, a.end) === a.quote) { live.push(a); continue; }
      const i = a.quote ? text.indexOf(a.quote) : -1;
      if (i === -1) continue;                       // kept in the store, not drawn
      a.start = i;
      a.end = i + a.quote.length;
      dirty = true;
      live.push(a);
    }
    if (dirty) save();
    return live;
  }

  /* --------------------------------------------------------------- render */
  function termRanges(text, terms) {
    if (!terms || !terms.length) return [];
    const rx = new RegExp('(' + terms.map((t) =>
      t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\w*'
    ).join('|') + ')', 'gi');
    const out = [];
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (!m[0].length) { rx.lastIndex++; continue; }
      out.push({ s: m.index, e: m.index + m[0].length });
    }
    return out;
  }

  /* A renderer for one sample. The text is cut at every range boundary - search
     hits, annotations, and whatever decorations the formatter passes in - so
     none of them ever have to nest badly: each slice knows exactly what covers
     it. What comes back is a function that renders any character range, which
     is what lets a formatting mode lay the same character stream out as blocks
     without moving a single offset. */
  function slicer(doc, terms, extra) {
    cur = doc;
    const text = doc.text;
    const anns = resolve(text, listFor(doc.id));
    const hits = termRanges(text, terms);
    const deco = extra || [];
    updateCounts();

    const cuts = new Set();
    for (const a of anns) { cuts.add(a.start); cuts.add(a.end); }
    for (const h of hits) { cuts.add(h.s); cuts.add(h.e); }
    for (const d of deco) { cuts.add(d.s); cuts.add(d.e); }
    const points = [...cuts].filter((p) => p > 0 && p < text.length).sort((a, b) => a - b);

    return function slice(from, to) {
      const pts = [from, ...points.filter((p) => p > from && p < to), to];
      let html = '';
      for (let i = 0; i < pts.length - 1; i++) {
        const s = pts[i], e = pts[i + 1];
        if (s >= e) continue;
        let seg = esc(text.slice(s, e));
        const d = deco.find((x) => x.s <= s && x.e >= e);
        if (d) seg = `<span class="${d.cls}">${seg}</span>`;
        if (hits.some((h) => h.s <= s && h.e >= e)) seg = `<mark>${seg}</mark>`;
        const act = anns.filter((a) => a.start <= s && a.end >= e);
        if (act.length) {
          const top = act[act.length - 1];
          const cls = [...new Set(act.map((a) => 'an-' + a.style))].join(' ');
          const noted = act.some((a) => a.end === e && a.note);
          seg = `<span class="anno ${cls}" data-an="${act.map((a) => a.id).join(' ')}"`
              + ` style="--an-color:var(--hl-${top.color})"${noted ? ' data-note="1"' : ''}`
              + `>${seg}</span>`;
        }
        html += seg;
      }
      return html;
    };
  }

  function updateCounts() {
    const n = total();
    const el = $('anCount');
    if (el) el.textContent = n;
    const d = $('docAnCount');
    if (d) d.textContent = cur ? countFor(cur.id) : 0;
    const btn = $('btnDocNotes');
    if (btn) btn.classList.toggle('active', !!cur && countFor(cur.id) > 0);
  }

  /* ------------------------------------------------------------ selection */
  function readSelection() {
    const s = window.getSelection();
    const bodyEl = $('docBody');
    if (!s || !s.rangeCount || s.isCollapsed || !bodyEl || !cur) return null;
    const r = s.getRangeAt(0);
    if (!bodyEl.contains(r.commonAncestorContainer)) return null;

    const pre = document.createRange();
    pre.selectNodeContents(bodyEl);
    try { pre.setEnd(r.startContainer, r.startOffset); } catch { return null; }
    let start = pre.toString().length;
    let end = start + r.toString().length;

    const text = cur.text;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return null;
    return { start, end, rect: r.getBoundingClientRect() };
  }

  function showBar(rect) {
    const bar = $('annoBar');
    bar.hidden = false;
    const w = bar.offsetWidth, h = bar.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = rect.top - h - 10;
    if (top < 56) top = rect.bottom + 10;
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  function hideBar() { $('annoBar').hidden = true; sel = null; }

  /* --------------------------------------------------------------- create */
  function add(range, style, color) {
    const list = listFor(cur.id).slice();
    const quote = cur.text.slice(range.start, range.end);

    // a mark laid straight over an identical one just restyles it, and marks of
    // the same style swallowed whole by the new one drop out - otherwise
    // re-highlighting a passage quietly stacks duplicates
    const same = list.find((a) => a.start === range.start && a.end === range.end && a.style === style);
    if (same) {
      same.color = color;
      setList(cur.id, list);
      return same;
    }
    const kept = list.filter((a) =>
      !(a.style === style && !a.note && a.start >= range.start && a.end <= range.end));

    const a = {
      id: uid(),
      start: range.start,
      end: range.end,
      style, color,
      note: '',
      quote,
      source: cur.dataset.source,
      split: cur.dataset.split,
      model: cur.dataset.model,
      topk: cur.dataset.topk,
      index: cur.doc_index,
      ts: Date.now(),
    };
    kept.push(a);
    kept.sort((x, y) => x.start - y.start || x.ts - y.ts);
    setList(cur.id, kept);
    return a;
  }

  function apply(style, color) {
    if (!sel || !cur) return null;
    pref = { color, style };
    write(PREF_KEY, pref);
    const a = add(sel, style, color);
    hideBar();
    window.getSelection().removeAllRanges();
    window.explorer.redrawDoc();
    window.explorer.refreshNotes();
    return a;
  }

  function clearSelection() {
    if (!sel || !cur) return;
    const list = listFor(cur.id).filter((a) => a.end <= sel.start || a.start >= sel.end);
    setList(cur.id, list);
    hideBar();
    window.getSelection().removeAllRanges();
    window.explorer.redrawDoc();
    window.explorer.refreshNotes();
  }

  function remove(docId, id) {
    setList(docId, listFor(docId).filter((a) => a.id !== id));
    if (cur && cur.id === docId) window.explorer.redrawDoc();
    window.explorer.refreshNotes();
  }

  function clear(scopeDocId) {
    if (scopeDocId != null) delete store[scopeDocId];
    else store = {};
    save();
    if (cur) window.explorer.redrawDoc();
    window.explorer.refreshNotes();
  }

  /* -------------------------------------------------------------- popover */
  function swatches(selected) {
    return ANNO_COLORS.map((c) =>
      `<button class="sw" data-color="${c}" title="${c}" style="--an-color:var(--hl-${c})"
         aria-pressed="${String(c === selected)}"></button>`).join('');
  }

  function openEditor(docId, id, rect) {
    const a = find(docId, id);
    if (!a) return;
    editing = { docId, id };
    const pop = $('annoPop');
    $('apQuote').textContent = a.quote;
    $('apQuote').style.setProperty('--an-color', `var(--hl-${a.color})`);
    $('apColors').innerHTML = swatches(a.color);
    for (const b of $('apStyle').children) b.setAttribute('aria-pressed', String(b.dataset.v === a.style));
    $('apNote').value = a.note || '';
    pop.hidden = false;

    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 8) top = Math.max(56, rect.top - h - 10);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    $('apNote').focus();
  }

  function closeEditor() {
    $('annoPop').hidden = true;
    editing = null;
  }

  function editingAnn() { return editing ? find(editing.docId, editing.id) : null; }

  function touch(mutate) {
    const a = editingAnn();
    if (!a) return;
    mutate(a);
    a.ts = a.ts || Date.now();
    save();
    if (cur && cur.id === editing.docId) window.explorer.redrawDoc();
    window.explorer.refreshNotes();
  }

  /* ----------------------------------------------------------- notes list */
  function when(ts) {
    const d = new Date(ts || 0);
    const days = (Date.now() - d) / 86400000;
    if (days < 1) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (days < 300) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString();
  }

  /* Sidebar content for the notes panel: every mark, newest first, optionally
     narrowed to one sample and filtered by the search box. */
  function listHtml(filter, scopeDocId) {
    let items = all();
    if (scopeDocId != null) items = items.filter((a) => a.docId === scopeDocId);
    const f = (filter || '').trim().toLowerCase();
    if (f) items = items.filter((a) =>
      (a.quote || '').toLowerCase().includes(f) || (a.note || '').toLowerCase().includes(f));
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    if (!items.length) {
      return `<div class="empty">${
        f ? 'No notes or highlights match that.'
        : scopeDocId != null ? 'Nothing marked in this sample yet.'
        : 'No notes yet - select any text in a sample to highlight it, underline it, or attach a note.'}</div>`;
    }
    return items.map((a) => {
      const k = window.explorer.kindOf({ model: a.model, topk: a.topk });
      return `<div class="note-card" data-doc="${a.docId}" data-an="${a.id}" style="--an-color:var(--hl-${a.color})">
        <div class="nc-head">
          <span class="badge ${k.cls}">${esc(a.source || '?')}</span>
          <span>#${window.explorer.fmt(a.index)}</span>
          <span class="nc-style">${a.style}</span>
          <div class="spacer"></div>
          <span class="nc-when">${when(a.ts)}</span>
          <button class="nc-x" data-del="1" title="Delete this mark">×</button>
        </div>
        <div class="nc-quote">${esc(a.quote || '')}</div>
        ${a.note ? `<div class="nc-note">${esc(a.note)}</div>` : ''}
      </div>`;
    }).join('');
  }

  /* Scroll a mark into view and pulse it, once its sample is on screen. */
  function focus(id) {
    const el = document.querySelector(`#docBody .anno[data-an~="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  /* ----------------------------------------------------------------- wire */
  function init() {
    $('annoColors').innerHTML = swatches(pref.color);

    $('annoBar').addEventListener('mousedown', (e) => e.preventDefault());
    $('annoBar').addEventListener('click', (e) => {
      // a swatch re-colours; the style buttons beside it choose the kind of mark
      const sw = e.target.closest('.sw');
      if (sw) return void apply(pref.style, sw.dataset.color);
      const st = e.target.closest('[data-style]');
      if (st) return void apply(st.dataset.style, pref.color);
      if (e.target.closest('#annoNote')) {
        const a = apply(pref.style, pref.color);
        if (a) requestAnimationFrame(() => {
          const el = document.querySelector(`#docBody .anno[data-an~="${a.id}"]`);
          openEditor(cur.id, a.id, el ? el.getBoundingClientRect() : { left: 200, top: 200, bottom: 220 });
        });
        return;
      }
      if (e.target.closest('#annoClearSel')) clearSelection();
    });

    // popover edits write straight through to the store
    $('apColors').addEventListener('click', (e) => {
      const sw = e.target.closest('.sw');
      if (!sw) return;
      pref.color = sw.dataset.color;
      write(PREF_KEY, pref);
      touch((a) => (a.color = sw.dataset.color));
      for (const b of $('apColors').children) b.setAttribute('aria-pressed', String(b === sw));
    });
    $('apStyle').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      pref.style = b.dataset.v;
      write(PREF_KEY, pref);
      touch((a) => (a.style = b.dataset.v));
      for (const x of $('apStyle').children) x.setAttribute('aria-pressed', String(x === b));
    });
    let noteTimer = null;
    $('apNote').addEventListener('input', (e) => {
      clearTimeout(noteTimer);
      const v = e.target.value;
      noteTimer = setTimeout(() => touch((a) => (a.note = v)), 300);
    });
    $('apNote').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); }
    });
    $('apDelete').onclick = () => {
      if (editing) remove(editing.docId, editing.id);
      closeEditor();
    };
    $('apDone').onclick = () => {
      clearTimeout(noteTimer);
      const a = editingAnn();
      if (a) touch((x) => (x.note = $('apNote').value));
      closeEditor();
    };

    // selection toolbar
    $('reader').addEventListener('mouseup', () => {
      setTimeout(() => {
        const r = readSelection();
        if (!r) { if (!$('annoBar').hidden) hideBar(); return; }
        sel = r;
        showBar(r.rect);
      }, 0);
    });
    $('reader').addEventListener('scroll', () => {
      if (!$('annoBar').hidden) hideBar();
      if (!$('annoPop').hidden) closeEditor();
    }, { passive: true });

    // clicking anywhere outside the panels closes them; mousedown is left alone
    // over a mark so a selection can still start inside one
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#annoPop')) closeEditor();
      if (!e.target.closest('#annoBar')) hideBar();
    });

    // a plain click on a mark (as opposed to a drag that selected text) edits it
    document.addEventListener('click', (e) => {
      const mark = e.target.closest('#docBody .anno');
      if (!mark || !cur) return;
      const s = window.getSelection();
      if (s && !s.isCollapsed) return;
      hideBar();
      const ids = mark.dataset.an.split(' ');
      openEditor(cur.id, ids[ids.length - 1], mark.getBoundingClientRect());
    });

    // notes list
    $('list').addEventListener('click', (e) => {
      const card = e.target.closest('.note-card');
      if (!card) return;
      const docId = Number(card.dataset.doc);
      const id = card.dataset.an;
      if (e.target.closest('[data-del]')) return void remove(docId, id);
      window.explorer.openDoc(docId).then(() => requestAnimationFrame(() => focus(id)));
    });

    updateCounts();
  }

  return {
    init, slicer, listHtml, focus, clear, total, countFor, updateCounts,
    hidePanels() { hideBar(); closeEditor(); },
    applyToSelection(style) {
      const r = readSelection();
      if (!r) return false;
      sel = r;
      apply(style, pref.color);
      return true;
    },
    noteSelection() {
      const r = readSelection();
      if (!r) return false;
      sel = r;
      const a = apply(pref.style, pref.color);
      if (a) requestAnimationFrame(() => {
        const el = document.querySelector(`#docBody .anno[data-an~="${a.id}"]`);
        openEditor(cur.id, a.id, el ? el.getBoundingClientRect() : { left: 200, top: 200, bottom: 220 });
      });
      return true;
    },
  };
})();
