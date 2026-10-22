#!/usr/bin/env python3
import base64
import binascii
import hmac
import json
import os
import re
import secrets
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


MAX_UPLOAD_BYTES = 24 * 1024 * 1024
FILE_NAME_PATTERN = re.compile(r"^[a-f0-9]{32}\.(?:jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac|ogg|flac|webm|mp4|mov)$")
MIME_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/webm": "webm",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
}
MIME_BY_EXTENSION = {extension: mime for mime, extension in MIME_TYPES.items()}

UPLOAD_DIRECTORY = Path(os.environ.get("UPLOAD_DIRECTORY", "/var/lib/lentalk-reference-uploader"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
UPLOAD_TOKEN = os.environ.get("UPLOAD_TOKEN", "")
RETENTION_SECONDS = int(os.environ.get("RETENTION_SECONDS", str(24 * 60 * 60)))


def require_configuration():
    parsed = urlparse(PUBLIC_BASE_URL)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RuntimeError("PUBLIC_BASE_URL must be a public HTTP(S) URL")
    if len(UPLOAD_TOKEN) < 32:
        raise RuntimeError("UPLOAD_TOKEN must contain at least 32 characters")
    UPLOAD_DIRECTORY.mkdir(parents=True, exist_ok=True)


def cleanup_expired_files():
    cutoff = time.time() - RETENTION_SECONDS
    for candidate in UPLOAD_DIRECTORY.iterdir():
        try:
            if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                candidate.unlink()
        except FileNotFoundError:
            continue


class ReferenceAssetHandler(BaseHTTPRequestHandler):
    server_version = "LenTalkReferenceUploader/1.0"

    def log_message(self, format, *args):
        return

    def send_json(self, status, payload):
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        if self.path != "/v1/reference-assets":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {UPLOAD_TOKEN}"
        if not hmac.compare_digest(authorization, expected):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_UPLOAD_BYTES * 2:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid upload size"})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
            content_type = str(payload["content_type"]).lower().split(";", 1)[0].strip()
            extension = MIME_TYPES[content_type]
            raw_data = str(payload["data_base64"]).strip()
            data = base64.b64decode(raw_data, validate=True)
        except (KeyError, TypeError, ValueError, binascii.Error):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid reference asset payload"})
            return
        if not data or len(data) > MAX_UPLOAD_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid upload size"})
            return
        cleanup_expired_files()
        filename = f"{secrets.token_hex(16)}.{extension}"
        destination = UPLOAD_DIRECTORY / filename
        temporary = UPLOAD_DIRECTORY / f".{filename}.tmp"
        temporary.write_bytes(data)
        temporary.chmod(0o644)
        temporary.replace(destination)
        self.send_json(HTTPStatus.CREATED, {"url": f"{PUBLIC_BASE_URL}/reference-assets/{filename}"})

    def do_GET(self):
        prefix = "/reference-assets/"
        if not self.path.startswith(prefix):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        filename = unquote(self.path[len(prefix):].split("?", 1)[0])
        if not FILE_NAME_PATTERN.fullmatch(filename):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        source = UPLOAD_DIRECTORY / filename
        try:
            content = source.read_bytes()
        except FileNotFoundError:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", MIME_BY_EXTENSION[filename.rsplit(".", 1)[1]])
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    require_configuration()
    ThreadingHTTPServer(("127.0.0.1", 8091), ReferenceAssetHandler).serve_forever()
