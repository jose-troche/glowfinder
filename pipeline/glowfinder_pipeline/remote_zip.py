"""Read one member out of a large remote zip using HTTP range requests.

ProteinGym ships every assay's MSA in a single 1.5 GB archive; glowfinder
needs one ~2 MB alignment. zipfile only needs a seekable file, so give it one
backed by Range requests instead of downloading the archive.
"""

from __future__ import annotations

import io
import zipfile

import requests

from .download import USER_AGENT

BLOCK = 1 << 20


class HttpRangeFile(io.RawIOBase):
    def __init__(self, url: str, session: requests.Session | None = None):
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        head = self.session.get(url, headers={"Range": "bytes=0-0"}, timeout=60, allow_redirects=True)
        if head.status_code != 206:
            raise RuntimeError(f"{url} does not support range requests (HTTP {head.status_code})")
        self.url = head.url
        self.size = int(head.headers["Content-Range"].rsplit("/", 1)[1])
        self.pos = 0
        self._cache: dict[int, bytes] = {}

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.pos, io.SEEK_END: self.size}[whence]
        self.pos = max(0, base + offset)
        return self.pos

    def _block(self, index: int) -> bytes:
        if index not in self._cache:
            start = index * BLOCK
            end = min(start + BLOCK, self.size) - 1
            resp = self.session.get(self.url, headers={"Range": f"bytes={start}-{end}"}, timeout=120)
            resp.raise_for_status()
            self._cache[index] = resp.content
        return self._cache[index]

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        out = bytearray()
        while n > 0:
            block = self._block(self.pos // BLOCK)
            start = self.pos % BLOCK
            chunk = block[start : start + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, b) -> int:
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def extract_member(url: str, member: str) -> tuple[str, bytes]:
    """Return (member name, bytes) for an exact member path inside the remote zip."""
    with zipfile.ZipFile(HttpRangeFile(url)) as zf:
        return member, zf.read(member)
