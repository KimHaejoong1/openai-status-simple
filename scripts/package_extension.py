"""Build a Web Store ZIP with an explicit list of runtime files. Python 3 stdlib only."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
FILES = (
    "manifest.json", "popup.html", "popup.js", "styles.css", "status.js", "status-api.js",
    "images/status.svg", "images/icon16.png", "images/icon48.png", "images/icon128.png",
)


def build_package(root=ROOT):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    referenced = {manifest["action"]["default_popup"], *manifest["icons"].values()}
    if not referenced.issubset(FILES):
        raise ValueError("Manifest references files missing from the packaging list.")
    # Read everything before writing, so a missing file cannot produce a partial ZIP.
    payloads = {name: (root / name).read_bytes() for name in FILES}
    output = root / "dist" / "openai-status-reader.zip"
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name, payload in payloads.items():
            info = ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, payload)
    with ZipFile(output) as archive:
        if archive.testzip() is not None or set(archive.namelist()) != set(FILES):
            raise ValueError("ZIP verification failed.")
    print(f"Packaged {len(FILES)} files, version {manifest['version']}: {output}")
    return output


if __name__ == "__main__":
    build_package()
