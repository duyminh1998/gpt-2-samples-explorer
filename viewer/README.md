# GPT-2 Output Explorer

A local web app for reading and searching the GPT-2 output dataset. No dependencies
beyond the Python standard library — no pip install, no venv, no build step.

```bash
python3 viewer/run.py
```

That downloads the data (if it isn't there yet), builds a search index (if it isn't
there yet), starts a server on <http://127.0.0.1:8008> and opens your browser.
Re-running it just starts the server.

## What you get

**Read** — a two-pane reader: sample list on the left, full text on the right.
Serif by default at a comfortable measure, with size, line-height, width, letter
spacing, typeface and theme (dark / sepia / light) all adjustable from the `Aa`
menu and remembered across sessions. Bookmark samples with `s`, browse them with `b`.

**Markup blocks** — samples where the scrape collapsed an HTML page onto one long
line are re-broken into indented blocks, one tag per line, with tag names,
attributes and values tinted. `Blocks` in the reader bar (or `f`) toggles it. The
line breaks and indentation are CSS only — no character of the sample is added,
removed or moved — so annotations and search hits land on the same text either
way. Each block also has a `Preview` tab that renders the markup as a page inside
a hard sandbox: `sandbox=""` and a CSP of `default-src 'none'`, so no script runs
and nothing is fetched from the network.

**Annotate** — select any passage to highlight, underline or strike it in one of
five colours, and attach a note to it. Marks are anchored to character offsets in
the sample, so they come back every time you open it again. `✎` opens the notes
panel: every mark, newest first, filterable, scoped to all samples or just the one
you are reading, click to jump back to it. Delete one from that list or from its
editor, or use *Clear…* for the current sample or the whole lot. Stored in
localStorage, like bookmarks.

**Search** — full-text search across every sample, backed by SQLite FTS5. Four
query modes: *all words*, *any word*, *exact phrase*, and raw FTS5 syntax (for
`NEAR()`, `OR`, prefixes, and the rest). Hits are highlighted in the result
snippets and again inside the sample, with `n` / `N` to jump between them.

**Analytics** — corpus summary, and per-dataset: vocabulary size, lexical
diversity, mean/median sample length, share of samples that ended on their own,
length distributions, top keywords, top bigrams, the words each model most
over-produces relative to WebText, and a tool to compare any word's frequency
across all nine datasets.

## Keyboard

| key | action |
|---|---|
| `j` / `k` | next / previous sample |
| `n` / `N` | next / previous match inside the sample |
| `/` | focus search |
| `r` | random sample |
| `s` / `b` | bookmark / show bookmarks |
| `h` / `u` / `x` | highlight / underline / strike the selection |
| `m` | attach a note to the selection |
| `a` | show notes & highlights |
| `f` | lay collapsed markup out as blocks |
| `g` | go to a sample index |
| `t` | cycle theme |
| `-` / `=` | text smaller / larger |
| `\` | toggle the list pane |
| `?` | shortcuts |

## The pieces

| file | what it does |
|---|---|
| `run.py` | download → index → serve, skipping whatever is already done |
| `fetch_data.py` | downloads `.jsonl` files from the OpenAI Azure bucket into `data/` |
| `build_index.py` | builds `data/index.db`: documents, FTS5 index, per-dataset stats and term counts |
| `app.py` | `http.server` JSON API + static files |
| `static/` | the UI (`index.html`, `app.js`, `annotate.js`, `markup.js`, `analytics.js`, `style.css`) |

Each is runnable on its own:

```bash
python3 viewer/fetch_data.py --splits test valid       # or: --splits train
python3 viewer/build_index.py                          # --limit 500 for a fast trial run
python3 viewer/app.py --port 8008
```

## Data size

`run.py` defaults to the **test and valid** splits: 18 files, ~260 MB on disk,
90,000 samples (5,000 per dataset per split), indexing to a ~420 MB SQLite file
in about two minutes.

The **train** splits are much bigger — ~650-750 MB per file, ~6.5 GB total, 2.25M
samples. They work fine, but expect a long download, a long build, and a ~10 GB
index (keep ~20 GB free). One 250K-sample train file measured at ~4 minutes and
1.0 GB of index, so the full set runs around 40 minutes:

```bash
python3 viewer/run.py --splits train test valid
```

Builds are atomic: `build_index.py` writes `index.db.building` and swaps it in
only on success, so an interrupted build never damages the index you already
have. (`--only`, which updates specific datasets, is the exception — it has to
work in place.)

Everything lands in `data/`, which is already in `.gitignore`.

## Notes on the analytics

- Keyword counts use a simple `[a-z]+` tokenizer on lowercased text, with English
  stopwords and words under 3 characters removed. They are *not* BPE tokens; the
  per-sample `length` field is, and the length charts use that.
- "Words this model over-produces" compares each term's rate against WebText of
  the same split, restricted to terms occurring at least 50 times. A ✳ marks terms
  too rare in WebText to be in its stored vocabulary (`tf < 3`), where the shown
  ratio is a lower bound.
- `build_index.py` stores the top 20,000 unigrams and top 400 bigrams per dataset,
  so cross-dataset frequency ratios are exact for anything reasonably common.
- Term counting over the train splits uses lossy counting: once a counter passes
  `MAX_VOCAB` entries the rare tail is dropped and the drop threshold rises. The
  head of the distribution — everything actually displayed — is unaffected, but
  counts for very rare terms in huge corpora are lower bounds.
