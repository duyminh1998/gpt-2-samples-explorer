"""Local web app for browsing + searching the GPT-2 output dataset (stdlib only)."""
import argparse
import json
import os
import re
import sqlite3
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
DB_PATH = os.path.join(REPO_ROOT, 'data', 'index.db')
STATIC = os.path.join(HERE, 'static')

MODEL_ORDER = {'webtext': 0, 'small-117M': 1, 'medium-345M': 2,
               'large-762M': 3, 'xl-1542M': 4}
SNIP_OPEN, SNIP_CLOSE = '\x02', '\x03'
MAX_COUNT = 5000
MIN_DISTINCTIVE_TF = 50   # ignore long-tail noise in the 'over-produces' table

_local = threading.local()


def db():
    """Read-only connection for the current request thread.

    ThreadingHTTPServer uses one thread per request, so these must be closed
    when the request finishes (see close_db) or the process leaks a file
    handle per request. Read-only means a concurrent build_index.py run can
    never be blocked by the server, and busy_timeout rides out the moment an
    index is being replaced.
    """
    if getattr(_local, 'conn', None) is None:
        conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True,
                               check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA busy_timeout = 5000')
        _local.conn = conn
    return _local.conn


def close_db():
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        conn.close()
        _local.conn = None


class ApiError(Exception):
    pass


# ---------------------------------------------------------------- query parsing

TOKEN_RE = re.compile(r'"[^"]*"|\S+')


def to_fts_query(q, mode='all'):
    """Turn a user query into a safe FTS5 expression.

    mode: 'all' (every word must appear), 'any', 'phrase' (exact phrase),
          'raw' (pass through untouched - full FTS5 syntax).
    """
    q = (q or '').strip()
    if not q:
        raise ApiError('empty query')
    if mode == 'raw':
        return q
    if mode == 'phrase':
        return '"' + q.replace('"', '') + '"'
    parts = []
    for tok in TOKEN_RE.findall(q):
        if tok.startswith('"') and tok.endswith('"') and len(tok) > 1:
            inner = tok[1:-1].strip()
            if inner:
                parts.append('"' + inner + '"')
            continue
        star = tok.endswith('*')
        word = re.sub(r'[^\w\'-]+', ' ', tok).strip()
        if not word:
            continue
        parts.append('"' + word + '"' + ('*' if star else ''))
    if not parts:
        raise ApiError('query has no searchable words')
    return (' OR ' if mode == 'any' else ' ').join(parts)


def dataset_filter(args):
    """Return (sql_fragment, params) restricting to the requested datasets."""
    names = [n for n in args.get('dataset', []) if n and n != 'all']
    if not names:
        return '', []
    rows = db().execute(
        "SELECT id FROM datasets WHERE name IN (%s)" % ','.join('?' * len(names)),
        names).fetchall()
    ids = [r['id'] for r in rows]
    if not ids:
        raise ApiError('unknown dataset')
    return ' AND docs.dataset_id IN (%s)' % ','.join('?' * len(ids)), ids


# ---------------------------------------------------------------- api handlers

def api_datasets(args):
    rows = [dict(r) for r in db().execute("SELECT * FROM datasets").fetchall()]
    rows.sort(key=lambda r: (MODEL_ORDER.get(r['model'], 9), r['topk'],
                             r['split'], r['name']))
    return {'datasets': rows}


def api_docs(args):
    where, params = dataset_filter(args)
    offset = max(0, int(args.get('offset', [0])[0]))
    limit = min(200, max(1, int(args.get('limit', [50])[0])))
    order = {'index': 'docs.dataset_id, docs.doc_index',
             'longest': 'docs.n_tokens DESC',
             'shortest': 'docs.n_tokens ASC'}.get(args.get('sort', ['index'])[0],
                                                  'docs.dataset_id, docs.doc_index')
    sql = ("SELECT docs.id, docs.dataset_id, docs.doc_index, docs.n_tokens, "
           "docs.ended, substr(docs.text, 1, 320) AS preview FROM docs "
           "WHERE 1=1" + where + f" ORDER BY {order} LIMIT ? OFFSET ?")
    rows = [dict(r) for r in db().execute(sql, params + [limit, offset]).fetchall()]
    total = db().execute("SELECT count(*) c FROM docs WHERE 1=1" + where,
                         params).fetchone()['c']
    return {'docs': rows, 'total': total, 'offset': offset, 'limit': limit}


def api_doc(args):
    if 'id' in args:
        row = db().execute("SELECT * FROM docs WHERE id=?", [int(args['id'][0])]).fetchone()
    else:
        row = db().execute(
            "SELECT docs.* FROM docs JOIN datasets ON datasets.id=docs.dataset_id "
            "WHERE datasets.name=? AND docs.doc_index=?",
            [args['dataset'][0], int(args['index'][0])]).fetchone()
    if not row:
        raise ApiError('document not found')
    d = dict(row)
    ds = db().execute("SELECT * FROM datasets WHERE id=?", [d['dataset_id']]).fetchone()
    d['dataset'] = dict(ds)
    nxt = db().execute("SELECT id FROM docs WHERE dataset_id=? AND doc_index=?",
                       [d['dataset_id'], d['doc_index'] + 1]).fetchone()
    prv = db().execute("SELECT id FROM docs WHERE dataset_id=? AND doc_index=?",
                       [d['dataset_id'], d['doc_index'] - 1]).fetchone()
    d['next_id'] = nxt['id'] if nxt else None
    d['prev_id'] = prv['id'] if prv else None
    return {'doc': d}


def api_random(args):
    where, params = dataset_filter(args)
    row = db().execute(
        "SELECT docs.id FROM docs WHERE 1=1" + where +
        " ORDER BY random() LIMIT 1", params).fetchone()
    if not row:
        raise ApiError('no documents')
    return api_doc({'id': [str(row['id'])]})


def api_search(args):
    mode = args.get('mode', ['all'])[0]
    match = to_fts_query(args.get('q', [''])[0], mode)
    where, params = dataset_filter(args)
    offset = max(0, int(args.get('offset', [0])[0]))
    limit = min(100, max(1, int(args.get('limit', [25])[0])))

    base = ("FROM docs_fts JOIN docs ON docs.id = docs_fts.rowid "
            "WHERE docs_fts MATCH ?" + where)
    sql = (f"SELECT docs.id, docs.dataset_id, docs.doc_index, docs.n_tokens, "
           f"snippet(docs_fts, 0, '{SNIP_OPEN}', '{SNIP_CLOSE}', ' … ', 28) AS snip, "
           f"bm25(docs_fts) AS score {base} ORDER BY score LIMIT ? OFFSET ?")
    try:
        rows = [dict(r) for r in
                db().execute(sql, [match] + params + [limit, offset]).fetchall()]
        capped = db().execute(
            f"SELECT count(*) c FROM (SELECT docs.id {base} LIMIT {MAX_COUNT + 1})",
            [match] + params).fetchone()['c']
        by_ds = {r['dataset_id']: r['c'] for r in db().execute(
            f"SELECT docs.dataset_id, count(*) c {base} GROUP BY 1",
            [match] + params).fetchall()}
    except sqlite3.OperationalError as e:
        raise ApiError(f'bad search query: {e}')
    return {'results': rows, 'total': min(capped, MAX_COUNT),
            'capped': capped > MAX_COUNT, 'by_dataset': by_ds,
            'match': match, 'offset': offset, 'limit': limit}


def api_analytics(args):
    conn = db()
    datasets = api_datasets(args)['datasets']
    by_id = {d['id']: d for d in datasets}

    # relative unigram frequencies, used for the "vs WebText" comparison
    rel, floor = {}, {}
    for ds in datasets:
        rows = conn.execute(
            "SELECT term, tf FROM terms WHERE dataset_id=? AND n=1", [ds['id']]).fetchall()
        words = max(ds['n_words'] or 1, 1)
        rel[ds['id']] = {r['term']: r['tf'] / words for r in rows}
        floor[ds['id']] = (min((r['tf'] for r in rows), default=1)) / words

    base_by_split = {d['split']: d['id'] for d in datasets if d['model'] == 'webtext'}

    out = []
    for ds in datasets:
        terms = [dict(r) for r in conn.execute(
            "SELECT n, term, tf, df FROM terms WHERE dataset_id=? "
            "ORDER BY n, tf DESC", [ds['id']]).fetchall()]
        hist = [dict(r) for r in conn.execute(
            "SELECT lo, hi, count FROM length_hist WHERE dataset_id=? ORDER BY lo",
            [ds['id']]).fetchall()]

        distinctive = []
        base_id = base_by_split.get(ds['split'])
        if base_id and base_id != ds['id']:
            b_rel, b_floor = rel[base_id], floor[base_id]
            for t in terms:
                if t['n'] != 1 or t['tf'] < MIN_DISTINCTIVE_TF:
                    continue
                mine = rel[ds['id']].get(t['term'], 0)
                theirs = b_rel.get(t['term'])
                approx = theirs is None
                theirs = b_floor if approx else theirs
                if mine > 0 and theirs > 0:
                    distinctive.append({'term': t['term'], 'tf': t['tf'],
                                        'ratio': mine / theirs, 'approx': approx})
            distinctive.sort(key=lambda x: -x['ratio'])
            distinctive = distinctive[:25]

        out.append({**ds,
                    'top_unigrams': [t for t in terms if t['n'] == 1][:40],
                    'top_bigrams': [t for t in terms if t['n'] == 2][:40],
                    'length_hist': hist,
                    'distinctive': distinctive})
    totals = {
        'n_datasets': len(out),
        'n_docs': sum(d['n_docs'] or 0 for d in out),
        'n_words': sum(d['n_words'] or 0 for d in out),
        'n_chars': sum(d['n_chars'] or 0 for d in out),
        'file_bytes': sum(d['file_bytes'] or 0 for d in out),
        'db_bytes': os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0,
    }
    return {'datasets': out, 'totals': totals}


def api_term(args):
    """Occurrence counts for one term across every dataset (for the compare tool)."""
    match = to_fts_query(args.get('q', [''])[0], args.get('mode', ['all'])[0])
    rows = db().execute(
        "SELECT docs.dataset_id, count(*) c FROM docs_fts JOIN docs "
        "ON docs.id=docs_fts.rowid WHERE docs_fts MATCH ? GROUP BY 1", [match]).fetchall()
    return {'match': match, 'by_dataset': {r['dataset_id']: r['c'] for r in rows}}


ROUTES = {
    '/api/datasets': api_datasets,
    '/api/docs': api_docs,
    '/api/doc': api_doc,
    '/api/random': api_random,
    '/api/search': api_search,
    '/api/analytics': api_analytics,
    '/api/term': api_term,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # local dev tool: never let the browser serve a stale asset
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _index(self):
        """Serve index.html with a cache-busting stamp on its own assets."""
        stamp = str(int(max(os.path.getmtime(os.path.join(STATIC, f))
                            for f in os.listdir(STATIC))))
        with open(os.path.join(STATIC, 'index.html'), 'r', encoding='utf-8') as fh:
            body = fh.read().replace('{{V}}', stamp).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ('/', '/index.html'):
            return self._index()
        route = ROUTES.get(parsed.path)
        if route is None:
            return super().do_GET()
        try:
            self._json(route(parse_qs(parsed.query)))
        except ApiError as e:
            self._json({'error': str(e)}, 400)
        except sqlite3.DatabaseError as e:
            self._json({'error': f'{e}. The index may be corrupt or incomplete - '
                                 f'rebuild it with: python3 viewer/run.py --reindex'}, 500)
        except Exception as e:  # noqa: BLE001 - surface errors in the UI
            self._json({'error': f'{type(e).__name__}: {e}'}, 500)
        finally:
            close_db()


def main():
    global DB_PATH
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--port', type=int, default=8008)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--db', default=DB_PATH)
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()
    DB_PATH = args.db
    if not os.path.exists(DB_PATH):
        print(f"No index at {DB_PATH}.\n"
              f"Run:  python3 viewer/fetch_data.py  &&  python3 viewer/build_index.py")
        return 1

    try:
        probe = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
        n = probe.execute("SELECT count(*) FROM docs").fetchone()[0]
        probe.close()
    except sqlite3.DatabaseError as e:
        print(f"The index at {DB_PATH} is unusable ({e}).\n"
              f"Rebuild it with:  python3 viewer/run.py --reindex")
        return 1

    port = args.port
    for attempt in range(20):
        try:
            httpd = ThreadingHTTPServer((args.host, port), Handler)
            break
        except OSError:
            port += 1
    else:
        print('could not bind a port')
        return 1

    url = f"http://{args.host}:{port}/"
    print(f"GPT-2 sample viewer  ->  {url}   ({n:,} documents indexed)")
    print("Ctrl-C to stop.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
