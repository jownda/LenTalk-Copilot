"""Local, content-addressed identity responses and confirmed review snapshots."""
import hashlib
import json
import os
import tempfile


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def read_record(path):
    try:
        with open(path, encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_record(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def candidate_fingerprint(items, video_dir, anime_mode):
    samples = []
    for item in items:
        for sample in item.get("samples", []):
            samples.append({key: sample.get(key) for key in
                ("image", "feature", "video", "episode", "timestamp")})
    return fingerprint({"version": 2 if anime_mode else 1, "video_dir": os.path.realpath(video_dir),
                        "anime_mode": bool(anime_mode), "samples": samples})
