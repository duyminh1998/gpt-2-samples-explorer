/* Re-breaking collapsed markup into blocks.
 *
 * The scrape that produced this corpus flattened whitespace, so an HTML page
 * that was written across sixty indented lines arrives as one 2,600-character
 * line with single spaces between the tags. It is unreadable as prose and
 * unreadable as source.
 *
 * This finds the stretches of a sample that are dense in tags, parses them into
 * tags / text / comments, tracks nesting, and lays each item out on its own
 * line indented to its depth. The catch is that it must do this **without
 * adding or moving a single character**: the line breaks and the indentation
 * are CSS (`display:block` and `padding-left`), never inserted text. That keeps
 * the character offsets that annotations are anchored to exactly valid, so a
 * highlight made on the re-broken markup covers the same characters when the
 * blocks are switched off - and copying the sample still yields the original.
 */
'use strict';

const Markup = (() => {
  const VOID = new Set(
    'area base br col embed hr img input link meta param source track wbr'.split(' '));

  /* ----------------------------------------------------------------- parse */

  /* Find the `>` that closes the tag opening at `i`. Deliberately forgiving:
     a quote only opens a quoted run if it actually closes before the next `>`,
     so a stray or curly quote (`charset="utf-8"` with a smart quote, which this
     corpus is full of) does not swallow the rest of the document. */
  function tagEnd(text, i) {
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j];
      if (c === '"' || c === "'") {
        const close = text.indexOf(c, j + 1);
        const gt = text.indexOf('>', j + 1);
        if (close !== -1 && (gt === -1 || close < gt)) { j = close; }
        continue;
      }
      if (c === '>') return j + 1;
    }
    return text.length;
  }

  const NAME = /^<\/?([a-zA-Z][\w:.-]*)/;

  /* Split a character range into tags, comments and the text between them. */
  function scan(text, from, to) {
    const out = [];
    let i = from, textStart = from;
    const flushText = (at) => {
      if (at > textStart) out.push({ type: 'text', s: textStart, e: at });
    };
    while (i < to) {
      if (text[i] !== '<') { i++; continue; }
      if (text.startsWith('<!--', i)) {
        const k = text.indexOf('-->', i + 4);
        const e = Math.min(k === -1 ? to : k + 3, to);
        flushText(i);
        out.push({ type: 'comment', s: i, e });
        i = textStart = e;
        continue;
      }
      const m = NAME.exec(text.slice(i, Math.min(i + 60, to)));
      const bang = text[i + 1] === '!';
      if (!m && !bang) { i++; continue; }
      const e = Math.min(tagEnd(text, i), to);
      if (e <= i + 1) { i++; continue; }
      flushText(i);
      out.push(bang && !m
        ? { type: 'decl', s: i, e }
        : { type: text[i + 1] === '/' ? 'close' : 'open', s: i, e,
            name: m[1].toLowerCase(),
            selfClose: /\/\s*>$/.test(text.slice(i, e)) });
      i = textStart = e;
    }
    flushText(to);
    return out;
  }

  /* ------------------------------------------------------------- detection */

  function lineRanges(text) {
    const out = [];
    let at = 0;
    for (const raw of text.split('\n')) {
      out.push({ s: at, e: at + raw.length, blank: !raw.trim() });
      at += raw.length + 1;
    }
    return out;
  }

  function tagStats(text, L) {
    let n = 0, cover = 0;
    for (const it of scan(text, L.s, L.e)) {
      if (it.type === 'text') continue;
      n++;
      cover += it.e - it.s;
    }
    return { n, cover };
  }

  /* Find the stretches of a sample that are markup rather than prose.
     Judged a run at a time, not a line at a time: `<th>Item Name</th>` is half
     tag and half content, and on its own proves nothing, but forty lines like
     it in a row are plainly a document. So consecutive lines that contain any
     tag at all are pooled, and the run is markup if it holds at least three
     tags and they are at least 45% of its characters. A paragraph that happens
     to mention <b> once is nowhere near that. */
  function regions(text) {
    const lines = lineRanges(text);
    const stats = lines.map((L) => (L.blank ? { n: 0, cover: 0 } : tagStats(text, L)));
    const out = [];

    for (let i = 0; i < lines.length; i++) {
      if (!stats[i].n) continue;
      let j = i, last = i, tags = 0, cover = 0, chars = 0;
      while (j < lines.length && (stats[j].n || lines[j].blank)) {
        if (stats[j].n) {
          last = j;
          tags += stats[j].n;
          cover += stats[j].cover;
          chars += lines[j].e - lines[j].s;
        }
        j++;
      }
      if (tags >= 3 && cover / Math.max(1, chars) >= 0.45) {
        out.push({ s: lines[i].s, e: lines[last].e });
      }
      i = last;
    }
    return out;
  }

  /* --------------------------------------------------------------- tinting */

  const ATTR = /([\w:.\-@]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g;

  /* Colour the parts of a tag. Ranges never overlap, which is what the slicer
     needs; anything unparseable is simply left uncoloured. */
  function tint(text, item, out) {
    if (item.type === 'comment') { out.push({ s: item.s, e: item.e, cls: 'mk-cmt' }); return; }
    if (item.type === 'decl') { out.push({ s: item.s, e: item.e, cls: 'mk-decl' }); return; }
    if (item.type === 'text') return;

    const open = text.slice(item.s, item.e);
    const m = NAME.exec(open);
    if (!m) return;
    out.push({ s: item.s, e: item.s + m[0].length, cls: 'mk-name' });

    ATTR.lastIndex = m[0].length;
    let a;
    while ((a = ATTR.exec(open)) !== null) {
      const at = item.s + a.index;
      out.push({ s: at, e: at + a[1].length, cls: 'mk-attr' });
      if (a[3]) {
        const vs = at + a[1].length + a[2].length;
        out.push({ s: vs, e: vs + a[3].length, cls: 'mk-val' });
      }
    }
  }

  /* ---------------------------------------------------------------- layout */

  /* Turn one region into indented lines. Whitespace between tags is folded into
     the line before it rather than dropped, so every character keeps a home. */
  function layout(text, region, deco) {
    const items = scan(text, region.s, region.e);
    const lines = [];
    const stack = [];

    const extend = (to) => { if (lines.length) lines[lines.length - 1].e = to; };

    for (const it of items) {
      if (it.type === 'text') {
        const body = text.slice(it.s, it.e);
        const lead = body.length - body.trimStart().length;
        if (lead) extend(it.s + lead);              // indentation joins the line above
        if (lead === body.length) continue;         // whitespace only
        lines.push({ s: it.s + lead, e: it.e, d: stack.length, k: 'text' });
        continue;
      }
      tint(text, it, deco);

      if (it.type === 'close') {
        const at = stack.lastIndexOf(it.name);
        if (at !== -1) stack.length = at;
        lines.push({ s: it.s, e: it.e, d: stack.length, k: 'close' });
        continue;
      }
      lines.push({ s: it.s, e: it.e, d: stack.length, k: it.type });
      if (it.type === 'open' && !it.selfClose && !VOID.has(it.name)) stack.push(it.name);
    }

    // the region has to be covered end to end, whatever the parse made of it
    if (!lines.length) return [{ s: region.s, e: region.e, d: 0, k: 'text' }];
    lines[0].s = region.s;
    lines[lines.length - 1].e = region.e;
    return lines;
  }

  /* --------------------------------------------------------------- preview */

  /* Model-generated markup, rendered as a page. Two independent locks, because
     none of this content is trustworthy:
       - sandbox="" - no scripts, no forms, no navigation, no popups, and an
         opaque origin, so the frame cannot touch this page or its storage;
       - a CSP of default-src 'none' - so nothing in the sample can make the
         viewer fetch a URL a language model invented. Inline styles are the one
         thing allowed through, since that is most of what makes a page a page.
     Between them the frame can lay out and paint, and do nothing else. */
  const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; "
            + "font-src data:; form-action 'none'; base-uri 'none'";

  const SHELL = '<!doctype html><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + '<style>html{color-scheme:light}body{margin:14px;background:#fff;color:#111;'
    + 'font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + 'img{max-width:100%}</style>';

  function previewDoc(html) { return SHELL + html; }

  let current = { text: '', regions: [] };

  /* The Source / Preview switch on each block. The frame is only filled in when
     someone actually asks for it. */
  function init() {
    const reader = document.getElementById('reader');
    if (!reader) return;
    reader.addEventListener('click', (e) => {
      const tab = e.target.closest('.mk-tab');
      if (!tab) return;
      const box = tab.closest('.mk');
      const wanted = tab.dataset.view === 'preview';
      const frame = box.querySelector('.mk-frame');
      if (wanted && !frame.getAttribute('srcdoc')) {
        const r = current.regions[Number(box.dataset.region)];
        if (r) frame.setAttribute('srcdoc', previewDoc(current.text.slice(r.s, r.e)));
      }
      box.querySelector('.mk-body').hidden = wanted;
      frame.hidden = !wanted;
      for (const b of box.querySelectorAll('.mk-tab')) {
        b.setAttribute('aria-pressed', String((b.dataset.view === 'preview') === wanted));
      }
    });
  }

  /* ---------------------------------------------------------------- render */

  function render(doc, terms, on) {
    const text = doc.text;
    const found = regions(text);
    if (!on || !found.length) {
      return { regions: found.length, html: Anno.slicer(doc, terms, [])(0, text.length) };
    }

    current = { text, regions: found };
    const deco = [];
    const laid = found.map((r) => layout(text, r, deco));
    deco.sort((a, b) => a.s - b.s);
    const slice = Anno.slicer(doc, terms, deco);

    let html = '';
    let at = 0;
    found.forEach((r, i) => {
      if (r.s > at) html += slice(at, r.s);
      const lines = laid[i].map((L) =>
        `<span class="mk-line mk-${L.k}" style="--d:${Math.min(L.d, 14)}">${slice(L.s, L.e)}</span>`
      ).join('');
      html += `<div class="mk" data-region="${i}">
        <div class="mk-bar">
          <span class="mk-kind">markup</span>
          <div class="spacer"></div>
          <button class="mk-tab" data-view="source" aria-pressed="true">Source</button>
          <button class="mk-tab" data-view="preview" aria-pressed="false"
            title="Render it in a sandboxed frame - no scripts, no network, no access to this page">Preview</button>
        </div>
        <div class="mk-body">${lines}</div>
        <iframe class="mk-frame" hidden sandbox="" referrerpolicy="no-referrer"
          title="Sandboxed preview of the sample's markup"></iframe>
      </div>`;
      at = r.e;
    });
    if (at < text.length) html += slice(at, text.length);
    return { regions: found.length, html };
  }

  return { init, render, regions, scan, layout, previewDoc };
})();
