#!/usr/bin/env python3
"""Local annotation server for static HTML.

Serves any project root over HTTP, injects the annotation overlay into HTML
responses, stores comments in a project-local state directory, and appends each
batch marked "sent" to annotations-inbox.jsonl for an agent to consume.

No third-party dependencies. Python 3.9+.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import math
import mimetypes
import os
import shutil
import stat
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path.cwd()
ASSETS = Path(__file__).resolve().parent
STATE_DIR = ROOT / ".annotate"
STATE = "annotations.json"
INBOX = "annotations-inbox.jsonl"
LOCK = threading.Lock()
# A digest retains the delivered payload's identity without caching the full inbox.
INBOXED: dict[tuple[str, str], bytes] | None = None
MAX_BODY = 2 * 1024 * 1024
INJECT = (
    b'<link rel="stylesheet" href="/annotate.css">'
    b'<script src="/annotate.js" defer></script>'
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_bytes(value, indent=None):
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=indent)
    return (text + "\n").encode("utf-8", errors="backslashreplace")


def finite_number(raw):
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError("invalid JSON number")
    return value


class APIError(Exception):
    def __init__(self, status: int, message: str, state: dict | None = None):
        super().__init__(message)
        self.status = status
        self.payload = {**(state or {}), "error": message}


@contextmanager
def state_directory(create=False):
    if create:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield fd
    finally:
        os.close(fd)


def state_file(directory, name, mode):
    def opener(path, flags):
        fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise OSError("not a regular file: " + path)
        return fd

    return open(name, mode, opener=opener)


def annotation_key(item):
    # Old inbox records may predate the explicit sentAt field.
    stamp = item.get("sentAt") or item.get("updatedAt") or item.get("createdAt") or ""
    if not isinstance(item.get("id"), str) or not isinstance(stamp, str):
        raise ValueError("invalid stored annotation revision")
    return item["id"], stamp


def annotation_digest(item):
    # Key order doesn't matter; JSON types do (in Python, True == 1).
    return hashlib.sha256(json.dumps(item, sort_keys=True).encode("ascii")).digest()


def read_state_unlocked():
    try:
        with state_directory() as directory, state_file(directory, STATE, "rb") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {"version": 0, "updated_at": None, "annotations": []}
    if (not isinstance(data, dict) or not isinstance(data.get("annotations"), list)
            or not all(isinstance(item, dict) and isinstance(item.get("id"), str)
                       for item in data["annotations"])):
        raise ValueError("invalid stored annotation state")
    version = data.setdefault("version", 0)
    if type(version) is not int or version < 0:
        raise ValueError("invalid stored annotation version")
    return data


def write_state_unlocked(previous, annotations):
    state = {**previous, "version": previous["version"] + 1,
             "updated_at": now_iso(), "annotations": annotations}
    data = json_bytes(state, indent=2)
    with state_directory(create=True) as directory:
        # Only one server owns a state directory. Remove an abandoned temporary
        # file from a crash; exclusive creation never follows an existing link.
        tmp = STATE + ".tmp"
        try:
            os.unlink(tmp, dir_fd=directory)
        except FileNotFoundError:
            pass
        with state_file(directory, tmp, "xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, STATE, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    return state


def load_inboxed(handle):
    revisions = {}
    handle.seek(0)
    while True:
        start = handle.tell()
        line = handle.readline()
        if not line:
            break
        if not line.strip():
            continue
        try:
            batch = json.loads(line)
        except (ValueError, UnicodeError):
            if line.endswith(b"\n"):
                raise  # Never silently ignore a corrupt completed record.
            handle.truncate(start)  # Interrupted append, not a complete event.
            break
        if not isinstance(batch, dict) or not isinstance(batch.get("annotations"), list):
            raise ValueError("invalid stored inbox batch")
        for item in batch["annotations"]:
            if not isinstance(item, dict):
                raise ValueError("invalid stored inbox annotation")
            revisions.setdefault(annotation_key(item), annotation_digest(item))
        if not line.endswith(b"\n"):
            handle.write(b"\n")
            break
    return revisions


def inboxed_unlocked():
    global INBOXED
    if INBOXED is None:
        try:
            with state_directory() as directory, state_file(directory, INBOX, "r+b") as handle:
                revisions = load_inboxed(handle)
                # A previous append may have failed after writing but before fsync.
                handle.flush()
                os.fsync(handle.fileno())
                os.fsync(directory)
        except FileNotFoundError:
            revisions = {}
        INBOXED = revisions
    return INBOXED


def deliver_unlocked(annotations):
    global INBOXED
    sent = {annotation_key(item): item for item in annotations if item.get("status") == "sent"}
    if not sent:
        return 0
    revisions = inboxed_unlocked()
    fresh = [item for key, item in sent.items() if key not in revisions]
    if not fresh:
        return 0

    try:
        with state_directory(create=True) as directory, state_file(directory, INBOX, "a+b") as handle:
            batch = {"event": "sent", "received_at": now_iso(), "annotations": fresh}
            handle.write(json_bytes(batch))
            handle.flush()
            os.fsync(handle.fileno())
            os.fsync(directory)
        revisions.update((annotation_key(item), annotation_digest(item)) for item in fresh)
        return len(fresh)
    except (OSError, ValueError):
        # A failed flush/fsync may already have appended a complete line.
        # Re-read the log on retry instead of guessing whether to append again.
        INBOXED = None
        raise


def confirmed_state_unlocked():
    # The atomic snapshot doubles as an outbox. Never expose or supersede a
    # sent revision until its JSONL event is durable, even after a restart.
    state = read_state_unlocked()
    deliver_unlocked(state["annotations"])
    return state


def save_annotations(version, items):
    with LOCK:
        state = confirmed_state_unlocked()
        if version != state["version"]:
            raise APIError(409, "annotation snapshot is stale", state)
        previous = {i["id"]: i for i in state["annotations"]}
        for item in items:
            old = previous.get(item["id"])
            if item.get("status") == "fixed":
                if not old or old.get("status") != "fixed" or annotation_digest(item) != annotation_digest(old):
                    raise APIError(409, "only resolve may mark a revision fixed", state)
            elif isinstance(item.get("sentAt"), str):
                key = item["id"], item["sentAt"]
                delivered = inboxed_unlocked().get(key)
                if delivered is not None and (
                        not old or old.get("status") != "sent" or annotation_key(old) != key
                        or item.get("status") != "sent" or annotation_digest(item) != delivered):
                    raise APIError(409, "a delivered revision cannot be changed or reused", state)
        saved = write_state_unlocked(state, items)
        count = deliver_unlocked(items)
        return {**saved, "ok": True, "count": len(items), "sent": count}


def resolve_annotations(items):
    with LOCK:
        state = confirmed_state_unlocked()
        by_id = {i["id"]: i for i in state["annotations"]}
        for revision in items:
            item = by_id.get(revision["id"])
            if not item or item.get("status") != "sent" or item.get("sentAt") != revision["sentAt"]:
                raise APIError(409, "annotation is no longer at the requested sent revision", state)
            if annotation_digest(item) != inboxed_unlocked().get(annotation_key(item)):
                # A snapshot written by an older server might already differ from the inbox.
                raise APIError(409, "current annotation differs from the delivered revision", state)
        stamp = now_iso()
        for revision in items:
            by_id[revision["id"]].update(status="fixed", resolvedAt=stamp)
        saved = write_state_unlocked(state, state["annotations"])
        return {**saved, "ok": True, "resolved": len(items)}


class Handler(BaseHTTPRequestHandler):
    server_version = "HtmlAnnotate/2"

    def parse_request(self):
        if not super().parse_request():
            return False
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            hosts.update(("127.0.0.1", "localhost"))
        host = self.headers.get_all("Host", [])
        if len(host) != 1 or host[0].lower() not in hosts:
            self.send_error(403, "invalid Host")
            return False
        if not self.path.startswith("/") or self.path.startswith("//"):
            self.send_error(400, "expected a local path")
            return False
        return True

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _body(self, status, content_type, data):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, payload, status=200):
        self._body(status, "application/json; charset=utf-8", json_bytes(payload))

    def _get(self, path):
        if path == "/__annotations":
            with LOCK:
                state = confirmed_state_unlocked()
            self._json(state)
        elif path == "/__inbox":
            with LOCK:
                confirmed_state_unlocked()
                try:
                    with state_directory() as directory, state_file(directory, INBOX, "rb") as handle:
                        lines = [line.rstrip(b"\n").decode("utf-8") for line in handle]
                except FileNotFoundError:
                    lines = []
            self._json({"path": str(STATE_DIR / INBOX), "lines": lines})
        elif path in ("/annotate.js", "/annotate.css"):
            mime = "application/javascript" if path.endswith(".js") else "text/css"
            self._body(200, mime + "; charset=utf-8", (ASSETS / path[1:]).read_bytes())
        else:
            self._static(path)

    def _static(self, path):
        parts = [part for part in path.split("/") if part and part != "."]
        if ".." in parts or "\\" in path:
            raise APIError(403, "path is outside the served root")
        # Open each component relative to its pinned parent. This rejects
        # symlinks (including directory indexes) without a check/open race.
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        fd = os.open(ROOT, flags | os.O_DIRECTORY)
        try:
            name = ""
            for name in parts:
                child = os.open(name, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                if not path.endswith("/"):
                    route, question, query = self.path.partition("?")
                    self.send_response(301)
                    self.send_header("Location", route + "/" + question + query)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                for name in ("index.html", "index.htm"):
                    try:
                        child = os.open(name, flags, dir_fd=fd)
                        break
                    except FileNotFoundError:
                        continue
                else:
                    raise APIError(404, "no directory index")
                os.close(fd)
                fd = child
                info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise APIError(403, "not a regular file")
            with os.fdopen(fd, "rb", closefd=False) as handle:
                html = name.lower().endswith((".html", ".htm"))
                mime = "text/html; charset=utf-8" if html else mimetypes.guess_type(name)[0]
                self.send_response(200)
                self.send_header("Content-Type", mime or "application/octet-stream")
                self.send_header("Content-Length", str(info.st_size + (len(INJECT) if html else 0)))
                self.end_headers()
                if self.command != "HEAD":
                    shutil.copyfileobj(handle, self.wfile)
                    if html:
                        # Leave the prologue (including any doctype) and inline scripts untouched.
                        self.wfile.write(INJECT)
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ENOTDIR):
                raise APIError(404, "file not found") from exc
            if exc.errno in (errno.EACCES, errno.EPERM, errno.ELOOP):
                raise APIError(403, "file access denied") from exc
            if exc.errno == errno.ENAMETOOLONG:
                raise APIError(414, "path too long") from exc
            raise
        finally:
            os.close(fd)

    def _post(self, path):
        if path not in ("/__annotations", "/__resolve"):
            raise APIError(404, "not found")
        origin = self.headers.get_all("Origin", [])
        if (not origin and self.headers.get("Sec-Fetch-Site") is not None
                or origin and (len(origin) != 1 or origin[0].lower() != "http://" + self.headers["Host"].lower())):
            raise APIError(403, "cross-origin write denied")
        if (len(self.headers.get_all("Content-Type", [])) != 1
                or self.headers.get_content_type() != "application/json"):
            raise APIError(415, "expected application/json")
        lengths = self.headers.get_all("Content-Length", [])
        if (self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1
                or not lengths[0].isascii() or not lengths[0].isdigit()):
            raise APIError(400, "invalid Content-Length")
        digits = lengths[0].lstrip("0") or "0"
        if len(digits) > len(str(MAX_BODY)) or int(digits) > MAX_BODY:
            raise APIError(413, "annotation body exceeds size limit")
        length = int(digits)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise APIError(400, "incomplete request body")
        try:
            payload = json.loads(raw.decode("utf-8"), parse_float=finite_number, parse_constant=finite_number)
        except (ValueError, RecursionError) as exc:
            raise APIError(400, "invalid JSON") from exc
        items = payload.get("annotations") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise APIError(400, "expected an object containing an annotations list")
        if len(items) > 500:
            raise APIError(413, "at most 500 annotations are allowed")
        ids = set()
        resolve = path == "/__resolve"
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise APIError(400, "each annotation requires a nonempty string id")
            if item["id"] in ids:
                raise APIError(400, "duplicate annotation id")
            ids.add(item["id"])
            if "comment" in item and (not isinstance(item["comment"], str) or len(item["comment"]) > 4000):
                raise APIError(400, "comment must be a string of at most 4000 characters")
            if not resolve and item.get("status", "draft") not in ("draft", "open", "sent", "fixed"):
                raise APIError(400, "invalid annotation status")
            if resolve or item.get("status") == "sent":
                if not isinstance(item.get("sentAt"), str) or not item["sentAt"]:
                    raise APIError(400, "a sent revision requires a nonempty string sentAt")
        if resolve:
            if not items or payload.get("status", "fixed") != "fixed":
                raise APIError(400, "resolve requires sent revisions to mark fixed")
            self._json(resolve_annotations(items))
        else:
            version = payload.get("version")
            if type(version) is not int or version < 0:
                raise APIError(400, "expected a nonnegative integer version")
            self._json(save_annotations(version, items))

    def _handle(self):
        try:
            try:
                path = unquote(self.path.partition("?")[0], errors="strict")
            except UnicodeError as exc:
                raise APIError(400, "invalid URL encoding") from exc
            if "\x00" in path or any(ord(c) < 32 for c in path):
                raise APIError(400, "invalid path")
            if self.command == "POST":
                self._post(path)
            else:
                self._get(path)
        except APIError as exc:
            self._json(exc.payload, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, ValueError, RecursionError) as exc:
            self.log_error("annotation I/O or stored data error: %r", exc)
            self._json({"error": "cannot read or persist annotation data"}, 500)

    do_GET = do_HEAD = do_POST = _handle


def main() -> None:
    global ROOT, STATE_DIR

    parser = argparse.ArgumentParser(description="Serve a project with a live annotation overlay")
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--root", default=".", help="directory to serve (default: cwd)")
    parser.add_argument("--state-dir", default="", help="annotation state directory (default: ROOT/.annotate)")
    args = parser.parse_args()

    ROOT = Path(args.root).expanduser().resolve()
    STATE_DIR = Path(args.state_dir).expanduser().resolve() if args.state_dir else ROOT / ".annotate"
    if not ROOT.is_dir():
        parser.error("--root must be a directory")

    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True

    # Retry a pending outbox on startup even if no browser reconnects. Keep
    # serving on I/O failure: subsequent requests retry after storage is fixed.
    try:
        with LOCK:
            confirmed_state_unlocked()
    except (OSError, ValueError, RecursionError) as exc:
        print(f"annotate: recovery deferred: {exc}", file=sys.stderr, flush=True)

    print("annotate: http://%s:%d/" % (args.host, server.server_port))
    print("annotate: root %s" % ROOT)
    print("annotate: state %s" % (STATE_DIR / STATE))
    print("annotate: inbox %s" % (STATE_DIR / INBOX), flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
