#!/usr/bin/env python3
"""One command to get the explorer running: download -> index -> serve.

Each step is skipped if it has already been done, so re-running this is cheap.
"""
import argparse
import os
import sqlite3
import subprocess
import sys

DATASETS = [
    'webtext',
    'small-117M',  'small-117M-k40',
    'medium-345M', 'medium-345M-k40',
    'large-762M',  'large-762M-k40',
    'xl-1542M',    'xl-1542M-k40',
]

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(REPO_ROOT, 'data')
DB_PATH = os.path.join(DATA_DIR, 'index.db')


def run(script, *args):
    cmd = [sys.executable, os.path.join(HERE, script), *args]
    print('$ ' + ' '.join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit(r.returncode)


def index_status(files_on_disk):
    """'missing' | 'corrupt' | 'stale' | 'ok' - decides whether to (re)build."""
    if not os.path.exists(DB_PATH):
        return 'missing'
    try:
        conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
        indexed = {r[0] for r in conn.execute("SELECT file FROM datasets")}
        conn.execute("SELECT count(*) FROM docs").fetchone()
        conn.close()
    except sqlite3.DatabaseError:
        return 'corrupt'
    return 'ok' if indexed == files_on_disk else 'stale'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--splits', nargs='+', default=['test', 'valid'],
                    choices=['train', 'valid', 'test'],
                    help='splits to download (default: test valid, ~260MB / 90K samples)')
    ap.add_argument('--datasets', nargs='+', default=DATASETS, choices=DATASETS,
                    help='which model outputs to use (default: all 9)')
    ap.add_argument('--port', type=int, default=8008)
    ap.add_argument('--reindex', action='store_true', help='rebuild the index even if it exists')
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()

    have = {f for f in os.listdir(DATA_DIR) if f.endswith('.jsonl')} \
        if os.path.isdir(DATA_DIR) else set()
    want = {f'{d}.{s}.jsonl' for s in args.splits for d in args.datasets}
    missing = want - have

    if missing:
        print(f"Downloading {len(missing)} dataset file(s)...")
        run('fetch_data.py', '--splits', *args.splits, '--datasets', *args.datasets)
    else:
        print(f"Datasets present in {DATA_DIR} ({len(have)} files) - skipping download.")

    on_disk = {f for f in os.listdir(DATA_DIR) if f.endswith('.jsonl')}
    status = index_status(on_disk)
    why = {
        'missing': 'No index yet',
        'corrupt': f'The index at {DB_PATH} is corrupt or incomplete',
        'stale': 'The index does not cover the files in data/',
    }
    if args.reindex or status != 'ok':
        print(f"{why.get(status, 'Rebuild requested')} - building the search index.")
        print(f"  {len(on_disk)} file(s) to index. With the train splits this "
              f"takes a while and needs plenty of disk.")
        run('build_index.py')
    else:
        print(f"Index present at {DB_PATH} and up to date - "
              f"skipping build (use --reindex to force).")

    serve = ['--port', str(args.port)]
    if args.no_browser:
        serve.append('--no-browser')
    run('app.py', *serve)


if __name__ == '__main__':
    main()
