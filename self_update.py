"""Standalone pre-launch updater for start.bat / launch.sh.

Mirrors app.py's /api/update logic but runs before the server starts and
without importing app.py (so it never opens the SQLite database). Preserves
venv, .git, .env and any *.db files either way.
"""
import os
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

BASE_DIR = Path(__file__).resolve().parent
UPDATE_ZIP_URL = os.environ.get(
    "UFC_V3_UPDATE_ZIP_URL",
    "https://github.com/donkesthour/ufc-bet-tracker-public/archive/refs/heads/main.zip",
).strip()
ZIP_KEEP = {"venv", ".venv", "node_modules", ".git", "__pycache__", "test-results"}


def _git(*args: str) -> tuple[int, str]:
    proc = subprocess.run(["git", *args], cwd=BASE_DIR, capture_output=True, text=True, timeout=120)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def _zip_update() -> str:
    import shutil
    import tempfile
    import zipfile

    with tempfile.TemporaryDirectory(prefix="ufc-update-") as tmp:
        archive = os.path.join(tmp, "update.zip")
        with urlopen(UPDATE_ZIP_URL, timeout=120) as resp, open(archive, "wb") as fh:
            fh.write(resp.read())
        with zipfile.ZipFile(archive) as zf:
            names = zf.namelist()
            if not names or not all(n.startswith(names[0].split("/")[0] + "/") for n in names):
                raise ValueError("unexpected archive layout")
            zf.extractall(tmp)
        extracted = os.path.join(tmp, names[0].split("/")[0])
        for root, dirs, files in os.walk(extracted):
            rel_root = os.path.relpath(root, extracted)
            if rel_root.split(os.sep)[0] in ZIP_KEEP or "__pycache__" in rel_root:
                dirs[:] = []
                continue
            target_dir = BASE_DIR if rel_root == "." else BASE_DIR / rel_root
            target_dir.mkdir(parents=True, exist_ok=True)
            for name in files:
                shutil.copy2(os.path.join(root, name), target_dir / name)
    return f"refreshed from {UPDATE_ZIP_URL}"


def main() -> int:
    if os.environ.get("UFC_V3_UPDATE_DISABLE"):
        print("Update check disabled (UFC_V3_UPDATE_DISABLE set) - skipping.")
        return 0
    code, _ = _git("rev-parse", "--is-inside-work-tree")
    try:
        if code != 0:
            print("Checking for updates (ZIP install)...")
            print(_zip_update())
        else:
            print("Checking for updates (git)...")
            code2, _ = _git("fetch", "origin", "--quiet")
            if code2 != 0:
                print("Could not reach GitHub - skipping update, continuing with current version.")
                return 0
            code3, behind = _git("rev-list", "--count", "HEAD..origin/HEAD")
            if code3 != 0:
                code3, behind = _git("rev-list", "--count", "HEAD..origin/main")
            if code3 == 0 and int(behind or 0) == 0:
                print("Already up to date.")
                return 0
            code4, out = _git("pull", "--ff-only", "origin")
            if code4 != 0:
                print("Update skipped (local changes or network issue):")
                print(out)
                return 0
            print(out)
    except Exception as exc:  # pragma: no cover - never block startup on an update hiccup
        print(f"Update check failed, continuing with current version: {exc}")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
