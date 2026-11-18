"""Build the standalone A.L.I.C.E. desktop app with PyInstaller and archive it for download.

    pip install -r requirements.txt -r packaging/requirements-build.txt
    python packaging/build_desktop.py            # builds dist/ALICE and dist/ALICE-<platform>.<zip|tar.gz>
    python packaging/build_desktop.py --skip-selftest

The model weights are not bundled: each install creates its own untrained model on first launch
and learns locally. The optional warm-start lessons ship inside the app.
"""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "ALICE"


def platform_tag() -> str:
    system = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}.get(platform.system(), platform.system().lower())
    machine = platform.machine().lower().replace("amd64", "x86_64").replace("aarch64", "arm64")
    return f"{system}-{machine}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-selftest", action="store_true")
    args = parser.parse_args()
    dist = ROOT / "dist"
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--windowed", "--onedir",
        "--name", NAME,
        "--distpath", str(dist), "--workpath", str(ROOT / "build"), "--specpath", str(ROOT / "build"),
        "--add-data", f"{ROOT / 'alice' / 'data'}{':'}alice/data",
        "--hidden-import", "local_model",
        # Large optional PyTorch/NumPy extras the app never uses.
        "--exclude-module", "torch.utils.tensorboard", "--exclude-module", "matplotlib",
        "--exclude-module", "IPython", "--exclude-module", "pytest", "--exclude-module", "PIL",
        str(ROOT / "alice_app.py"),
    ]
    subprocess.run(command, check=True, cwd=ROOT)
    app_dir = dist / NAME
    if platform.system() == "Darwin" and (dist / f"{NAME}.app").exists():
        app_dir = dist / f"{NAME}.app"
    executable = dist / NAME / (f"{NAME}.exe" if platform.system() == "Windows" else NAME)
    if not args.skip_selftest:
        subprocess.run([str(executable), "--selftest"], check=True)
    archive_base = dist / f"{NAME}-{platform_tag()}"
    archive_format = "gztar" if platform.system() == "Linux" else "zip"
    archive = shutil.make_archive(str(archive_base), archive_format, root_dir=app_dir.parent, base_dir=app_dir.name)
    print(f"Built {archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
