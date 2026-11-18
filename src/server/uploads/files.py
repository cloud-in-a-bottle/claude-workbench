import os
import secrets
from collections.abc import AsyncIterator
from pathlib import Path

MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
# Names on most filesystems top out at 255 bytes, and the temp name below has to fit beside it.
MAX_NAME_BYTES = 200


def valid_upload_name(name: str) -> bool:
    """Whether `name` is a plain file name that can only land directly in the directory it's put in.

    Browsers send just the base name of a picked file, so anything with a separator in it came from
    somewhere else and is refused rather than trimmed.
    """
    return (
        bool(name)
        and name not in (".", "..")
        and "/" not in name
        and "\\" not in name
        and "\0" not in name
        and len(name.encode()) <= MAX_NAME_BYTES
    )


def _numbered(name: str, n: int) -> str:
    """`report.pdf` -> `report (n).pdf`, the way a browser names a second download of a file."""
    if n == 0:
        return name
    stem, dot, ext = name.rpartition(".")
    if not stem:  # no extension, or a dotfile like `.env`
        return f"{name} ({n})"
    return f"{stem} ({n}){dot}{ext}"


async def save_upload(directory: Path, name: str, chunks: AsyncIterator[bytes]) -> Path:
    """Stream an upload into `directory` under `name`, numbering it if that name is taken.

    Nothing already there is ever overwritten. The bytes go to a hidden temp file first and are
    hard-linked into place, which fails rather than clobbers if the name was taken in the meantime,
    so an interrupted upload never leaves a half-written file under the real name.
    """
    tmp = directory / f".upload-{secrets.token_hex(6)}-{name}"
    try:
        with tmp.open("xb") as f:
            async for chunk in chunks:
                f.write(chunk)
        n = 0
        while True:
            dest = directory / _numbered(name, n)
            try:
                os.link(tmp, dest)
            except FileExistsError:
                n += 1
                continue
            return dest
    finally:
        tmp.unlink(missing_ok=True)
