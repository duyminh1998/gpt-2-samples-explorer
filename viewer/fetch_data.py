"""Download GPT-2 output-dataset JSONL files into ./data (stdlib only)."""
import argparse
import os
import sys
import time
import urllib.request

BASE = "https://openaipublic.blob.core.windows.net/gpt-2/output-dataset/v1/"

DATASETS = [
    'webtext',
    'small-117M',  'small-117M-k40',
    'medium-345M', 'medium-345M-k40',
    'large-762M',  'large-762M-k40',
    'xl-1542M',    'xl-1542M-k40',
]
SPLITS = ['train', 'valid', 'test']

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, 'data')


def human(n):
    for unit in ['B', 'KB', 'MB', 'GB']:
        if abs(n) < 1024 or unit == 'GB':
            return f"{n:,.1f}{unit}" if unit != 'B' else f"{n:.0f}B"
        n /= 1024.0


def remote_size(url):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get('content-length', 0))


def download(filename, dest_dir, retries=3):
    url = BASE + filename
    path = os.path.join(dest_dir, filename)
    try:
        total = remote_size(url)
    except Exception as e:
        print(f"  ! could not HEAD {filename}: {e}")
        total = 0

    if os.path.exists(path) and total and os.path.getsize(path) == total:
        print(f"  = {filename} already complete ({human(total)})")
        return True

    for attempt in range(1, retries + 1):
        try:
            tmp = path + '.part'
            got = 0
            start = time.time()
            with urllib.request.urlopen(url, timeout=120) as r, open(tmp, 'wb') as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if total:
                        pct = 100.0 * got / total
                        rate = got / max(time.time() - start, 1e-6) / (1 << 20)
                        sys.stdout.write(
                            f"\r  > {filename:<28} {pct:5.1f}%  "
                            f"{human(got)}/{human(total)}  {rate:5.1f}MB/s")
                        sys.stdout.flush()
            os.replace(tmp, path)
            sys.stdout.write(f"\r  + {filename:<28} done  {human(got)}{' ' * 24}\n")
            sys.stdout.flush()
            return True
        except Exception as e:
            print(f"\n  ! attempt {attempt}/{retries} failed for {filename}: {e}")
            time.sleep(2 * attempt)
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--splits', nargs='+', default=['test', 'valid'], choices=SPLITS,
                    help="splits to download (default: test valid; 'train' is ~5.8GB total)")
    ap.add_argument('--datasets', nargs='+', default=DATASETS, choices=DATASETS,
                    help='which model outputs to download (default: all 9)')
    ap.add_argument('--data-dir', default=DATA_DIR)
    args = ap.parse_args()

    os.makedirs(args.data_dir, exist_ok=True)
    targets = [(d, s) for d in args.datasets for s in args.splits]
    print(f"Downloading {len(targets)} file(s) into {args.data_dir}")

    failed = []
    for i, (ds, split) in enumerate(targets, 1):
        fn = f"{ds}.{split}.jsonl"
        print(f"[{i}/{len(targets)}] {fn}")
        if not download(fn, args.data_dir):
            failed.append(fn)

    if failed:
        print(f"\nFAILED ({len(failed)}): " + ', '.join(failed))
        return 1
    print("\nAll downloads complete.")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
