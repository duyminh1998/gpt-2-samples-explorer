"""Build a SQLite (FTS5) index + analytics over the downloaded GPT-2 JSONL files."""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, 'data')
DB_PATH = os.path.join(REPO_ROOT, 'data', 'index.db')

STOPWORDS = set("""
a about above after again against all am an and any are aren't as at be because been before being
below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down
during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here
here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself
let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves
out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their
theirs them themselves then there there's these they they'd they'll they're they've this those through
to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's
where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're
you've your yours yourself yourselves will just also one two get got like said says say make made many
much even back go going went come came take took see seen us new now well still may might must upon
every another something anyone someone thing things way ways however therefore though although
""".split())

WORD_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")
TOP_UNIGRAMS = 20000   # wide, so cross-dataset frequency ratios are exact
TOP_BIGRAMS = 400
MIN_TF = 3
MAX_VOCAB = 2_000_000       # trim the term counters once they exceed this
PRUNE_TARGET = 1_200_000    # ...down to this, so trimming stays infrequent
LEN_BUCKETS = [0, 32, 64, 128, 192, 256, 384, 512, 768, 1024, 1 << 30]

SCHEMA = """
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;

CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE,          -- e.g. small-117M-k40.test
    source TEXT,               -- e.g. small-117M-k40
    model TEXT,                -- e.g. small-117M
    topk INTEGER,              -- 1 if k40 sampling
    split TEXT,
    file TEXT,
    file_bytes INTEGER,
    n_docs INTEGER,
    n_chars INTEGER,
    n_words INTEGER,
    n_tokens INTEGER,          -- sum of the dataset's own `length` field (BPE tokens)
    distinct_words INTEGER,
    avg_tokens REAL,
    median_tokens REAL,
    p90_tokens REAL,
    avg_word_len REAL,
    pct_ended REAL,
    type_token_ratio REAL
);

CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY,
    dataset_id INTEGER NOT NULL,
    doc_index INTEGER NOT NULL,   -- 0-based position within its file
    orig_id INTEGER,
    ended INTEGER,
    n_tokens INTEGER,
    n_chars INTEGER,
    n_words INTEGER,
    text TEXT
);

CREATE TABLE IF NOT EXISTS terms (
    dataset_id INTEGER NOT NULL,
    n INTEGER NOT NULL,        -- 1 = unigram, 2 = bigram
    term TEXT NOT NULL,
    tf INTEGER NOT NULL,       -- total occurrences
    df INTEGER NOT NULL        -- documents containing it
);

CREATE TABLE IF NOT EXISTS length_hist (
    dataset_id INTEGER NOT NULL,
    lo INTEGER, hi INTEGER, count INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    text, content='docs', content_rowid='id', tokenize='porter unicode61'
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS idx_docs_ds ON docs(dataset_id, doc_index);
CREATE INDEX IF NOT EXISTS idx_terms_ds ON terms(dataset_id, n, tf DESC);
CREATE INDEX IF NOT EXISTS idx_lh_ds ON length_hist(dataset_id);
"""


def parse_name(filename):
    base = filename[:-len('.jsonl')]
    source, split = base.rsplit('.', 1)
    topk = 1 if source.endswith('-k40') else 0
    model = source[:-len('-k40')] if topk else source
    return dict(name=base, source=source, model=model, topk=topk, split=split)


def percentile(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def prune_to(tf, df, floor, target):
    """Lossy-counting trim: raise the floor until `tf` fits under `target`.

    A fixed floor of 1 is not enough on the train splits - once the set of
    terms seen twice is itself larger than the cap, every document triggers a
    full O(vocab) sweep that frees nothing, and the build grinds to a halt.
    Raising the floor guarantees each sweep makes progress and leaves headroom
    before the next one.
    """
    while len(tf) > target:
        floor += 1
        for term, c in list(tf.items()):
            if c <= floor:
                del tf[term]
                df.pop(term, None)
    return floor


def index_file(conn, path, limit=None):
    meta = parse_name(os.path.basename(path))
    file_bytes = os.path.getsize(path)
    cur = conn.cursor()
    cur.execute("SELECT id FROM datasets WHERE name=?", (meta['name'],))
    row = cur.fetchone()
    if row:
        ds_id = row[0]
        cur.execute("DELETE FROM docs WHERE dataset_id=?", (ds_id,))
        cur.execute("DELETE FROM terms WHERE dataset_id=?", (ds_id,))
        cur.execute("DELETE FROM length_hist WHERE dataset_id=?", (ds_id,))
    else:
        cur.execute(
            "INSERT INTO datasets(name, source, model, topk, split, file, file_bytes) "
            "VALUES(?,?,?,?,?,?,?)",
            (meta['name'], meta['source'], meta['model'], meta['topk'],
             meta['split'], os.path.basename(path), file_bytes))
        ds_id = cur.lastrowid
    conn.commit()

    uni_tf, uni_df = Counter(), Counter()
    bi_tf, bi_df = Counter(), Counter()
    uni_floor = bi_floor = 0
    lengths = []
    n_docs = n_chars = n_words = n_tokens = n_ended = 0
    word_char_total = 0
    hist = [0] * (len(LEN_BUCKETS) - 1)
    batch = []
    start = time.time()

    with open(path, 'r', encoding='utf-8') as fh:
        for i, line in enumerate(fh):
            if limit and i >= limit:
                break
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            text = d.get('text', '')
            tokens = d.get('length') or 0
            ended = 1 if d.get('ended') else 0

            words = WORD_RE.findall(text.lower())
            content = [w for w in words if w not in STOPWORDS and len(w) > 2]

            uni_tf.update(content)
            uni_df.update(set(content))
            bigrams = [f"{a} {b}" for a, b in zip(content, content[1:])]
            bi_tf.update(bigrams)
            bi_df.update(set(bigrams))
            # streaming top-k: on very large corpora (the train splits) drop the
            # rare tail rather than let the counters grow without bound
            if len(uni_tf) > MAX_VOCAB:
                uni_floor = prune_to(uni_tf, uni_df, uni_floor, PRUNE_TARGET)
            if len(bi_tf) > MAX_VOCAB:
                bi_floor = prune_to(bi_tf, bi_df, bi_floor, PRUNE_TARGET)

            n_docs += 1
            n_chars += len(text)
            n_words += len(words)
            n_tokens += tokens
            n_ended += ended
            word_char_total += sum(len(w) for w in words)
            lengths.append(tokens)
            for b in range(len(hist)):
                if LEN_BUCKETS[b] <= tokens < LEN_BUCKETS[b + 1]:
                    hist[b] += 1
                    break

            batch.append((ds_id, i, d.get('id'), ended, tokens,
                          len(text), len(words), text))
            if len(batch) >= 2000:
                cur.executemany(
                    "INSERT INTO docs(dataset_id, doc_index, orig_id, ended, n_tokens,"
                    " n_chars, n_words, text) VALUES(?,?,?,?,?,?,?,?)", batch)
                batch.clear()
                sys.stdout.write(f"\r    indexing... {n_docs:,} docs "
                                 f"({time.time() - start:,.0f}s)")
                sys.stdout.flush()

    if batch:
        cur.executemany(
            "INSERT INTO docs(dataset_id, doc_index, orig_id, ended, n_tokens,"
            " n_chars, n_words, text) VALUES(?,?,?,?,?,?,?,?)", batch)

    lengths.sort()
    cur.execute("""UPDATE datasets SET file_bytes=?, n_docs=?, n_chars=?, n_words=?,
                   n_tokens=?, distinct_words=?, avg_tokens=?, median_tokens=?,
                   p90_tokens=?, avg_word_len=?, pct_ended=?, type_token_ratio=?
                   WHERE id=?""",
                (file_bytes, n_docs, n_chars, n_words, n_tokens, len(uni_tf),
                 (n_tokens / n_docs) if n_docs else 0,
                 percentile(lengths, 0.5), percentile(lengths, 0.9),
                 (word_char_total / n_words) if n_words else 0,
                 (100.0 * n_ended / n_docs) if n_docs else 0,
                 (len(uni_tf) / n_words) if n_words else 0,
                 ds_id))

    cur.executemany("INSERT INTO length_hist(dataset_id, lo, hi, count) VALUES(?,?,?,?)",
                    [(ds_id, LEN_BUCKETS[b], LEN_BUCKETS[b + 1], hist[b])
                     for b in range(len(hist))])

    rows = [(ds_id, 1, t, c, uni_df[t]) for t, c in uni_tf.most_common(TOP_UNIGRAMS)
            if c >= MIN_TF]
    rows += [(ds_id, 2, t, c, bi_df[t]) for t, c in bi_tf.most_common(TOP_BIGRAMS)]
    cur.executemany("INSERT INTO terms(dataset_id, n, term, tf, df) VALUES(?,?,?,?,?)", rows)
    conn.commit()
    sys.stdout.write(f"\r    {n_docs:,} docs, {n_words:,} words, "
                     f"{len(uni_tf):,} distinct  ({time.time() - start:,.0f}s)\n")
    return ds_id, n_docs


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--data-dir', default=DATA_DIR)
    ap.add_argument('--db', default=DB_PATH)
    ap.add_argument('--limit', type=int, default=None,
                    help='only index the first N docs per file (for a quick trial)')
    ap.add_argument('--only', nargs='*', default=None,
                    help='only index files whose name contains one of these strings')
    args = ap.parse_args()

    files = sorted(f for f in os.listdir(args.data_dir) if f.endswith('.jsonl'))
    if args.only:
        files = [f for f in files if any(s in f for s in args.only)]
    if not files:
        print(f"No .jsonl files in {args.data_dir}. Run fetch_data.py first.")
        return 1

    # A full build goes to a scratch file and is swapped in atomically at the
    # end. The build uses journal_mode=OFF for speed, which means an interrupted
    # write leaves an unrecoverable file - so it must never be the live index.
    # `--only` updates specific datasets and has to work in place.
    in_place = bool(args.only)
    target = args.db
    work = target if in_place else target + '.building'
    if not in_place and os.path.exists(work):
        os.remove(work)

    conn = sqlite3.connect(work)
    conn.executescript(SCHEMA)

    try:
        total = 0
        for i, f in enumerate(files, 1):
            print(f"[{i}/{len(files)}] {f}")
            _, n = index_file(conn, os.path.join(args.data_dir, f), args.limit)
            total += n

        print("Building full-text search index (this is the slow part)...")
        conn.execute("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')")
        conn.executescript(INDEXES)
        conn.commit()
        print("Optimizing...")
        conn.execute("INSERT INTO docs_fts(docs_fts) VALUES('optimize')")
        conn.commit()
        if in_place:
            # only worth it after DELETEs left free pages behind; a fresh build
            # has nothing to reclaim and VACUUM would copy the whole file
            print("Vacuuming...")
            conn.execute("VACUUM")
        conn.close()
    except KeyboardInterrupt:
        conn.close()
        if not in_place:
            os.remove(work)
            print("\nInterrupted - discarded the partial index, "
                  "the existing one (if any) is untouched.")
        else:
            print(f"\nInterrupted during an in-place --only build. {target} may be "
                  f"damaged; rebuild it with: python3 viewer/build_index.py")
        return 130

    if not in_place:
        os.replace(work, target)
    print(f"\nIndexed {total:,} documents -> {target} "
          f"({os.path.getsize(target) / (1 << 20):,.0f} MB)")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
