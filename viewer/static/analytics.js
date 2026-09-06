/* GPT-2 Output Explorer - analytics view */
'use strict';

const A = {
  data: null,       // /api/analytics payload
  split: null,      // which split the page is showing
  loaded: false,
};

const SERIES = {
  human: 'var(--series-1)',
  temp: 'var(--series-2)',
  k40: 'var(--series-3)',
};
const SERIES_LABEL = {
  human: 'WebText (human)',
  temp: 'GPT-2, temperature 1',
  k40: 'GPT-2, top-k 40',
};

/* --------------------------------------------------------------- helpers */
function aEsc(s) { return window.explorer.esc(s); }
function aFmt(n) { return window.explorer.fmt(n); }
function aBytes(n) { return window.explorer.bytes(n); }

function compact(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function seriesOf(ds) { return window.explorer.kindOf(ds).cls || 'temp'; }

function legend(kinds) {
  return `<div class="legend">` + kinds.map((k) =>
    `<span><i class="swatch" style="background:${SERIES[k]}"></i>${SERIES_LABEL[k]}</span>`
  ).join('') + `</div>`;
}

/**
 * Horizontal bar chart. Rows: {label, value, kind, display, title}
 * Every bar is directly labelled, which is also the relief for the light-mode
 * contrast warning on the aqua slot.
 */
function barChart(rows, opts) {
  opts = opts || {};
  const max = opts.max || Math.max(...rows.map((r) => r.value), 1);
  const bars = rows.map((r) => {
    const w = Math.max(0.6, (100 * r.value) / max);
    return `<div class="bar-row" data-tip="${aEsc(r.title || '')}">
      <span class="lbl">${aEsc(r.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${SERIES[r.kind]}"></span></span>
      <span class="val">${aEsc(r.display)}</span>
    </div>`;
  }).join('');
  const table = `<details class="tableview"><summary>Show as table</summary>
    <table class="data"><thead><tr><th>Dataset</th><th class="num">${aEsc(opts.unit || 'Value')}</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${aEsc(r.label)}</td><td class="num">${aEsc(r.display)}</td></tr>`).join('')}</tbody>
    </table></details>`;
  return `<div class="bars">${bars}</div>${table}`;
}

function sparkHist(hist, kind) {
  const max = Math.max(...hist.map((h) => h.count), 1);
  return `<div class="spark">` + hist.map((h) => {
    const pct = (100 * h.count) / max;
    const hi = h.hi > 1e9 ? '+' : h.hi;
    return `<span class="b" style="height:${Math.max(2, pct)}%;background:${SERIES[kind]}"
      data-tip="${h.lo}-${hi} tokens: ${aFmt(h.count)} samples"></span>`;
  }).join('') + `</div>`;
}

/* --------------------------------------------------------------- tooltip */
function wireTooltips(root) {
  const tip = document.getElementById('tooltip');
  root.querySelectorAll('[data-tip]').forEach((el) => {
    if (!el.dataset.tip) return;
    el.addEventListener('mouseenter', () => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
    });
    el.addEventListener('mousemove', (e) => {
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 280) + 'px';
      tip.style.top = (e.clientY + 16) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

/* ----------------------------------------------------------------- render */
async function renderAnalytics(root) {
  if (!A.data) {
    root.innerHTML = '<div class="loading">Crunching the corpus...</div>';
    try {
      A.data = await window.explorer.api('/api/analytics', {});
    } catch (e) {
      root.innerHTML = `<div class="error">${aEsc(e.message)}</div>`;
      return;
    }
    const splits = [...new Set(A.data.datasets.map((d) => d.split))];
    A.split = splits.includes('test') ? 'test' : splits[0];
  }
  draw(root);
}

function redrawAnalytics() {
  const root = document.getElementById('analyticsWrap');
  if (A.data && document.getElementById('main').dataset.view === 'analytics') draw(root);
}

function draw(root) {
  const all = A.data.datasets;
  const splits = [...new Set(all.map((d) => d.split))];
  const ds = all.filter((d) => d.split === A.split)
    .sort((a, b) => a.topk - b.topk || 0);
  const order = ['webtext', 'small-117M', 'medium-345M', 'large-762M', 'xl-1542M'];
  ds.sort((a, b) => (a.topk - b.topk) || (order.indexOf(a.model) - order.indexOf(b.model)));
  const webtext = ds.find((d) => d.model === 'webtext');
  const t = A.data.totals;

  const maxTemp = Math.max(...ds.filter((d) => !d.topk && d.model !== 'webtext')
    .map((d) => d.distinct_words), 1);
  const minK40 = Math.min(...ds.filter((d) => d.topk).map((d) => d.distinct_words), Infinity);
  const ratioTemp = webtext ? (maxTemp / webtext.distinct_words).toFixed(1) : '?';
  const ratioK40 = webtext && isFinite(minK40) ? (webtext.distinct_words / minK40).toFixed(1) : '?';

  const row = (d, value, display, title) => ({
    label: d.source, value, display, kind: seriesOf(d), title,
  });

  const lenRows = ds.map((d) => row(d, d.avg_tokens,
    Math.round(d.avg_tokens) + ' tok',
    `${d.source}: mean ${Math.round(d.avg_tokens)}, median ${Math.round(d.median_tokens)}, p90 ${Math.round(d.p90_tokens)} BPE tokens`));

  const vocabRows = ds.map((d) => row(d, d.distinct_words, compact(d.distinct_words),
    `${d.source}: ${aFmt(d.distinct_words)} distinct words across ${aFmt(d.n_words)} words`));

  const endedRows = ds.map((d) => row(d, d.pct_ended, d.pct_ended.toFixed(1) + '%',
    `${d.source}: ${d.pct_ended.toFixed(1)}% of samples reached an end-of-text token instead of the length cap`));

  const ttrRows = ds.map((d) => row(d, d.type_token_ratio * 1000,
    (d.type_token_ratio * 1000).toFixed(1),
    `${d.source}: ${aFmt(d.distinct_words)} distinct / ${aFmt(d.n_words)} total words`));

  root.innerHTML = `
  <div class="analytics">
    <h2>Corpus analytics</h2>
    <p class="lede">
      Everything below is computed from the JSONL files on disk. WebText is the human-written
      reference corpus; each GPT-2 model appears twice — once sampled at temperature 1 with no
      truncation, once with top-k 40 truncation. The contrast between those two sampling regimes
      is the most visible pattern in this data.
    </p>

    <div class="tiles">
      <div class="tile"><div class="k">Samples</div><div class="v">${aFmt(t.n_docs)}</div>
        <div class="s">across ${t.n_datasets} dataset files</div></div>
      <div class="tile"><div class="k">Words</div><div class="v">${compact(t.n_words)}</div>
        <div class="s">${aFmt(t.n_chars)} characters</div></div>
      <div class="tile"><div class="k">Corpus on disk</div><div class="v">${aBytes(t.file_bytes)}</div>
        <div class="s">raw .jsonl files</div></div>
      <div class="tile"><div class="k">Search index</div><div class="v">${aBytes(t.db_bytes)}</div>
        <div class="s">SQLite + FTS5</div></div>
      <div class="tile"><div class="k">Longest sample</div><div class="v">${aFmt(Math.max(...all.map((d) => d.p90_tokens)))}</div>
        <div class="s">p90 tokens, worst dataset</div></div>
    </div>

    <div class="card">
      <header>
        <h3>Split</h3>
        <div class="seg" id="splitSeg">${splits.map((s) =>
          `<button data-v="${s}" aria-pressed="${s === A.split}">${s}</button>`).join('')}</div>
        <span class="note" style="margin:0">Charts below show the <b>${aEsc(A.split)}</b> split (${aFmt(ds[0] ? ds[0].n_docs : 0)} samples per dataset).</span>
      </header>
    </div>

    <div class="card">
      <header><h3>Vocabulary size</h3></header>
      <p class="note">Distinct lowercase word forms per dataset, stopwords removed. The two
      sampling regimes fall on opposite sides of human text: untruncated temperature-1 sampling
      reaches into the tail of the distribution and coins <b>${ratioTemp}× more</b> distinct
      word forms than WebText, while top-k 40 cuts that tail off and produces <b>${ratioK40}×
      fewer</b>. Neither is "human-like" — they miss in opposite directions.</p>
      ${legend(['human', 'temp', 'k40'])}
      ${barChart(vocabRows, { unit: 'Distinct words' })}
    </div>

    <div class="card">
      <header><h3>Lexical diversity</h3></header>
      <p class="note">Distinct words per 1,000 words of text — vocabulary size normalised for
      corpus length, so datasets of different word counts are comparable.</p>
      ${legend(['human', 'temp', 'k40'])}
      ${barChart(ttrRows, { unit: 'Distinct per 1K words' })}
    </div>

    <div class="card">
      <header><h3>Average sample length</h3></header>
      <p class="note">Mean length in BPE tokens (the dataset's own <code>length</code> field).
      Hover a bar for the median and p90.</p>
      ${legend(['human', 'temp', 'k40'])}
      ${barChart(lenRows, { unit: 'Mean BPE tokens' })}
    </div>

    <div class="card">
      <header><h3>Samples that ended on their own</h3></header>
      <p class="note">Share of samples where generation emitted an end-of-text token rather than
      hitting the length cap (the <code>ended</code> field).</p>
      ${legend(['human', 'temp', 'k40'])}
      ${barChart(endedRows, { unit: '% ended' })}
    </div>

    <div class="card">
      <header><h3>Length distribution</h3></header>
      <p class="note">Sample counts by token-length bucket, one panel per dataset. Buckets run
      0-32, 32-64, 64-128, 128-192, 192-256, 256-384, 384-512, 512-768, 768-1024, 1024+.</p>
      <div class="smalls">${ds.map((d) => `
        <div class="small">
          <h4>${aEsc(d.source)}</h4>
          <div class="cap">median ${Math.round(d.median_tokens)} tok · ${aFmt(d.n_docs)} samples</div>
          ${sparkHist(d.length_hist, seriesOf(d))}
        </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <header><h3>Most frequent keywords</h3></header>
      <p class="note">Top content words per dataset (stopwords and words under 3 characters
      removed). Click any keyword to search the corpus for it.</p>
      <div class="kw-grid">${ds.map((d) => `
        <div>
          <h4 style="margin:0 0 8px;font-size:12.5px">
            <i class="swatch" style="background:${SERIES[seriesOf(d)]};margin-right:6px"></i>${aEsc(d.source)}
          </h4>
          <div class="chips">${d.top_unigrams.slice(0, 18).map((tm) =>
            `<span class="chip" data-term="${aEsc(tm.term)}"><b>${aEsc(tm.term)}</b><span class="n">${aFmt(tm.tf)}</span></span>`
          ).join('')}</div>
        </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <header><h3>Most frequent two-word phrases</h3></header>
      <p class="note">Bigrams of content words. These expose each dataset's pet topics far more
      sharply than single words do.</p>
      <div class="kw-grid">${ds.map((d) => `
        <div>
          <h4 style="margin:0 0 8px;font-size:12.5px">
            <i class="swatch" style="background:${SERIES[seriesOf(d)]};margin-right:6px"></i>${aEsc(d.source)}
          </h4>
          <div class="chips">${d.top_bigrams.slice(0, 12).map((tm) =>
            `<span class="chip" data-term="${aEsc(tm.term)}" data-mode="phrase"><b>${aEsc(tm.term)}</b><span class="n">${aFmt(tm.tf)}</span></span>`
          ).join('')}</div>
        </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <header><h3>Words this model over-produces</h3></header>
      <p class="note">For each generated dataset, the words whose frequency is most inflated
      relative to WebText of the same split. Ratio is (rate here) ÷ (rate in WebText); a ✳ marks
      terms too rare in WebText to appear in its stored vocabulary, where the ratio is a lower bound.</p>
      <div class="kw-grid">${ds.filter((d) => d.model !== 'webtext').map((d) => `
        <div>
          <h4 style="margin:0 0 8px;font-size:12.5px">
            <i class="swatch" style="background:${SERIES[seriesOf(d)]};margin-right:6px"></i>${aEsc(d.source)}
          </h4>
          <table class="data"><tbody>${d.distinctive.slice(0, 12).map((tm) => `
            <tr><td><span class="term chip" data-term="${aEsc(tm.term)}" style="border:0;background:none;padding:0">${aEsc(tm.term)}</span>${tm.approx ? ' <span style="color:var(--text-muted)">✳</span>' : ''}</td>
                <td class="num">${tm.ratio >= 100 ? Math.round(tm.ratio) : tm.ratio.toFixed(1)}×</td>
                <td class="num" style="color:var(--text-muted)">${aFmt(tm.tf)}</td></tr>`).join('')}
          </tbody></table>
        </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <header><h3>Compare a word across datasets</h3></header>
      <p class="note">How many samples in each dataset contain a given word or phrase — a quick
      way to see whether a phrase is a human habit or a model tic.</p>
      <div class="search-row" style="max-width:420px;margin-bottom:14px">
        <input type="search" id="cmpInput" placeholder="e.g. however, according to, unicorn"
               style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:7px 10px">
        <button class="icon-btn" id="cmpGo">Compare</button>
      </div>
      <div id="cmpOut"></div>
    </div>
  </div>`;

  root.querySelector('#splitSeg').addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    A.split = e.target.dataset.v;
    draw(root);
  });
  root.querySelectorAll('.chip[data-term]').forEach((el) =>
    el.addEventListener('click', () =>
      window.explorer.openSearch(el.dataset.term, el.dataset.mode || 'all')));
  root.querySelector('#cmpGo').onclick = () => compareTerm(root);
  root.querySelector('#cmpInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') compareTerm(root);
  });
  wireTooltips(root);
  root.scrollTop = 0;
}

async function compareTerm(root) {
  const q = root.querySelector('#cmpInput').value.trim();
  const out = root.querySelector('#cmpOut');
  if (!q) { out.innerHTML = ''; return; }
  out.innerHTML = '<div class="loading">Counting...</div>';
  try {
    const mode = /\s/.test(q) ? 'phrase' : 'all';
    const r = await window.explorer.api('/api/term', { q, mode });
    const ds = A.data.datasets.filter((d) => d.split === A.split);
    const order = ['webtext', 'small-117M', 'medium-345M', 'large-762M', 'xl-1542M'];
    ds.sort((a, b) => (a.topk - b.topk) || (order.indexOf(a.model) - order.indexOf(b.model)));
    const rows = ds.map((d) => {
      const c = r.by_dataset[d.id] || 0;
      const pct = (100 * c) / Math.max(1, d.n_docs);
      return {
        label: d.source, value: c, kind: seriesOf(d),
        display: `${aFmt(c)}  (${pct.toFixed(1)}%)`,
        title: `${d.source}: ${aFmt(c)} of ${aFmt(d.n_docs)} samples contain "${q}"`,
      };
    });
    out.innerHTML = legend(['human', 'temp', 'k40']) +
      barChart(rows, { unit: 'Samples containing it' }) +
      `<p class="note" style="margin-top:10px">Searched as <code>${aEsc(mode)}</code> in the
       <b>${aEsc(A.split)}</b> split. <a href="#" id="cmpOpen">Open these results in the reader →</a></p>`;
    out.querySelector('#cmpOpen').onclick = (e) => {
      e.preventDefault();
      window.explorer.openSearch(q, mode);
    };
    wireTooltips(out);
  } catch (e) {
    out.innerHTML = `<div class="error">${aEsc(e.message)}</div>`;
  }
}
