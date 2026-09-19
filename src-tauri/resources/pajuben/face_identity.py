#!/usr/bin/env python3
"""本地人物参考库：Apple Vision 检脸，特征只保存在用户输出目录。"""

import base64
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from PIL import Image, ImageFilter, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "face_vision")
SFACE_ENGINE = os.path.join(HERE, "face_sface_engine.py")
SYSTEM_PYTHON = "/usr/bin/python3"
SYSTEM_ARCH = "/usr/bin/arch"
SFACE_VENDOR = os.path.join(HERE, "face_runtime", "vendor39")
LIB_DIRNAME = "_人物识别库"
LIB_FILENAME = "人物库.json"
CANDIDATE_CACHE_FILENAME = "候选人物.json"
VIDEO_EXTS = (".mp4", ".mkv", ".mov", ".avi", ".flv", ".ts", ".m4v", ".wmv")


def face_clarity(path):
    """用边缘方差衡量缩略脸清晰度；越模糊分数越低。"""
    try:
        image = Image.open(path).convert("L")
        width, height = image.size
        if min(width, height) < 72:
            return 0.0
        margin_x, margin_y = max(2, width // 20), max(2, height // 20)
        image = image.crop((margin_x, margin_y, width - margin_x, height - margin_y))
        edges = image.filter(ImageFilter.FIND_EDGES)
        ew, eh = edges.size
        edges = edges.crop((2, 2, max(3, ew - 2), max(3, eh - 2)))
        return float(ImageStat.Stat(edges).var[0])
    except Exception:
        return 0.0


def usable_face(face, min_quality=75, min_clarity=80):
    return (float(face.get("quality", 0)) >= min_quality and
            face_clarity(face.get("crop", "")) >= min_clarity)


def decode_feature(text):
    raw = base64.b64decode(text)
    return struct.unpack("<%df" % (len(raw) // 4), raw)


def cosine(a, b):
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
    return dot / norm if norm else 0.0


def feature_similarity(a, b):
    """将SFace官方判别阈值校准为用户可读置信度；旧768维特征保持原值。"""
    raw = cosine(a, b)
    if len(a) == 128 and len(b) == 128:
        boundary = 0.363  # OpenCV SFace 官方同人余弦阈值
        if raw >= boundary:
            return min(1.0, 0.85 + (raw - boundary) / (1.0 - boundary) * 0.15)
        return max(0.0, raw / boundary * 0.85)
    return raw


def clothing_histogram(path):
    """取人脸缩略图下半部的粗颜色分布；只作为同服装加分，不能单独认人。"""
    try:
        image = Image.open(path).convert("RGB")
        w, h = image.size
        image = image.crop((0, int(h * 0.58), w, h)).resize((32, 16))
        bins = [0.0] * 64
        for r, g, b in image.getdata():
            bins[(r // 64) * 16 + (g // 64) * 4 + (b // 64)] += 1.0
        norm = math.sqrt(sum(x * x for x in bins))
        return tuple(x / norm for x in bins) if norm else tuple(bins)
    except Exception:
        return ()


def frame_keys(item):
    points = item.get("appearances", []) + item.get("samples", [])
    return {(p["video"], p["timestamp"]) for p in points
            if p.get("video") and p.get("timestamp") is not None}


def cooccurrence_conflict(a, b):
    """共享采样时刻的不同候选不能自动合并，镜像等例外交给人工。"""
    return bool(frame_keys(a) & frame_keys(b))


def select_reference_samples(samples, limit=5):
    """从清晰候选中优先覆盖不同集数、时间与外观角度。"""
    remaining = list(samples)
    selected = []
    while remaining and len(selected) < limit:
        def score(sample):
            quality = float(sample.get("quality", 0)) / 1000
            if not selected:
                return quality
            episodes = {s.get("episode") for s in selected}
            new_episode = sample.get("episode") not in episodes
            gaps = [abs(float(sample.get("timestamp") or 0) -
                        float(s.get("timestamp") or 0)) for s in selected
                    if s.get("episode") == sample.get("episode")]
            distance = min(min(gaps, default=60), 60) / 60
            similarity = max((feature_similarity(decode_feature(sample["feature"]),
                              decode_feature(s["feature"])) for s in selected), default=1)
            return 2 * new_episode + distance + (1 - similarity) + quality
        chosen = max(remaining, key=score)
        selected.append(chosen)
        remaining.remove(chosen)
    return selected


def candidate_similarity(a, b):
    av = [decode_feature(x["feature"]) for x in a.get("samples", [])]
    bv = [decode_feature(x["feature"]) for x in b.get("samples", [])]
    face_pairs = sorted(
        (feature_similarity(x, y), i, j)
        for i, x in enumerate(av) for j, y in enumerate(bv))
    # 不能让一张偶然相像、角度特殊或检测偏移的脸决定整组关系。
    # 两边都有多张证据时，至少要求第二个独立配对也相似。
    # 两个配对必须来自两边各自不同的图片。
    face = max((min(s, t) for s, i, j in face_pairs for t, k, l in face_pairs
                if i != k and j != l), default=0.0) if len(av) >= 2 and len(bv) >= 2 else (
                    face_pairs[-1][0] if face_pairs else 0.0)
    ah = [clothing_histogram(x["image"]) for x in a.get("samples", [])[:3]]
    bh = [clothing_histogram(x["image"]) for x in b.get("samples", [])[:3]]
    clothing = max((sum(x * y for x, y in zip(h1, h2)) for h1 in ah for h2 in bh
                    if h1 and h2), default=0.0)
    return face, clothing


def merge_high_confidence(items, face_threshold=0.95,
                          combined_face_threshold=0.92, clothing_threshold=0.94):
    """仅在多张脸高度一致，或脸与服装都高度一致时自动合并。"""
    merged = []
    for item in sorted(items, key=lambda x: -x.get("count", 1)):
        target = None
        best = -1.0
        for existing in merged:
            if cooccurrence_conflict(existing, item):
                continue
            face, clothing = candidate_similarity(existing, item)
            qualifies = (face >= face_threshold or
                         (face >= combined_face_threshold and clothing >= clothing_threshold))
            score = face + clothing * 0.05
            if qualifies and score >= best:
                target, best = existing, score
        if target is None:
            merged.append(item)
        else:
            target["count"] = target.get("count", 1) + item.get("count", 1)
            seen = {x["image"] for x in target.get("samples", [])}
            for sample in item.get("samples", []):
                if sample["image"] not in seen and len(target["samples"]) < 12:
                    target["samples"].append(sample); seen.add(sample["image"])
            target.setdefault("auto_merged_ids", []).append(item["id"])
            existing_points = {
                (x.get("episode"), x.get("timestamp"), x.get("video"))
                for x in target.get("appearances", [])
            }
            target.setdefault("appearances", []).extend(
                x for x in item.get("appearances", [])
                if (x.get("episode"), x.get("timestamp"), x.get("video"))
                not in existing_points)
    for new_id, item in enumerate(merged, 1): item["id"] = new_id
    return merged


def arrange_suspects(items):
    """把未强制合并、但疑似同人的候选相邻排列，交给用户做是/不是确认。"""
    if not items:
        return items
    ranked = sorted(range(len(items)), key=lambda i: -items[i].get("count", 1))
    groups = []
    relation = {}
    for index in ranked:
        best_group = None
        best_score = -1.0
        best_pair = (0.0, 0.0)
        for group in groups:
            anchor = group[0]
            if any(cooccurrence_conflict(items[member], items[index]) for member in group):
                continue
            face, clothing = candidate_similarity(items[anchor], items[index])
            enough_faces = (len(items[anchor].get("samples", [])) >= 2 and
                            len(items[index].get("samples", [])) >= 2)
            qualifies = enough_faces and (
                face >= 0.91 or (face >= 0.88 and clothing >= 0.93))
            score = face + max(0.0, clothing - 0.75) * 0.12
            if qualifies and score > best_score:
                best_group, best_score, best_pair = group, score, (face, clothing)
        if best_group is None:
            groups.append([index])
        else:
            best_group.append(index)
            relation[index] = (best_group[0], *best_pair)
    ordered = []
    for group_no, members in enumerate(sorted(groups,
            key=lambda g: -sum(items[i].get("count", 1) for i in g)), 1):
        anchor = members[0]
        for pos, index in enumerate(members):
            item = items[index]
            item["suspect_group"] = group_no
            if pos:
                _, face, clothing = relation.get(index, (anchor, *candidate_similarity(items[anchor], item)))
                item["similar_to"] = items[anchor]["id"]
                item["face_similarity"] = face
                item["clothing_similarity"] = clothing
                item["same_default"] = bool(
                    face >= 0.94 or (face >= 0.91 and clothing >= 0.95))
            ordered.append(item)
    return ordered


def library_dir(output_dir):
    return os.path.join(os.path.abspath(output_dir), LIB_DIRNAME)


def library_path(output_dir):
    return os.path.join(library_dir(output_dir), LIB_FILENAME)


def load_library(output_dir):
    path = library_path(output_dir)
    if not os.path.exists(path):
        return {"version": 1, "roles": []}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data.get("roles"), list):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"version": 1, "roles": []}


def save_library(output_dir, roles):
    root = library_dir(output_dir)
    os.makedirs(root, exist_ok=True)
    path = library_path(output_dir)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "roles": roles}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return path


def scan_images(images, crop_dir):
    if not images:
        return []
    os.makedirs(crop_dir, exist_ok=True)
    if os.path.isfile(SFACE_ENGINE):
        if sys.platform == "darwin":
            # Finder 可能通过 Rosetta 启动，Python 的 user site 里会混入 Intel
            # wheel。保持识别进程 ARM-only，并加载应用自带的 NumPy/OpenCV。
            command = [SYSTEM_ARCH, "-arm64", SYSTEM_PYTHON,
                       SFACE_ENGINE, "scan", crop_dir, *images]
        else:
            # Windows / Linux 没有 /usr/bin/arch，直接用当前解释器跑跨平台引擎
            # （YuNet 检脸 + SFace 识别，纯 OpenCV，不依赖 Apple Vision）。
            command = [sys.executable, SFACE_ENGINE, "scan", crop_dir, *images]
    else:
        # 平台专属助手（macOS 走 Apple Vision 的 Mach-O 文件）。
        command = [HELPER, "scan", crop_dir, *images]
    env = os.environ.copy()
    if os.path.isfile(SFACE_ENGINE):
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONPATH"] = SFACE_VENDOR
    proc = subprocess.run(command, capture_output=True,
                          text=True, timeout=max(60, len(images) * 3), env=env)
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or "本地人脸检测失败")
    return json.loads(proc.stdout or "[]")


def extract_candidate_frames(video, out_dir, interval=4, max_frames=80):
    os.makedirs(out_dir, exist_ok=True)
    pattern = os.path.join(out_dir, "frame_%05d.jpg")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", video,
                    "-vf", f"fps=1/{max(1, interval)},scale=960:-2", "-frames:v", str(max_frames),
                    "-q:v", "3", pattern], check=True)
    return sorted(os.path.join(out_dir, n) for n in os.listdir(out_dir) if n.endswith(".jpg"))


_DURATION_PATTERN = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def probe_video_duration(video):
    # 只随包 ffmpeg(没有 ffprobe)的发行版：回退解析 ffmpeg 输出。
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video],
            capture_output=True, text=True, timeout=20, check=True)
        return float(result.stdout.strip())
    except FileNotFoundError:
        pass
    except Exception:
        return 0.0
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-i", video],
                             capture_output=True, text=True, timeout=20).stderr or ""
        match = _DURATION_PATTERN.search(out)
        if not match:
            return 0.0
        hours, minutes, seconds = match.groups()
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except Exception:
        return 0.0


def frame_number(path):
    match = re.search(r"frame_(\d+)", os.path.basename(path))
    return max(0, int(match.group(1)) - 1) if match else 0


def propagate_track_evidence(faces):
    """把相邻抽样帧中同一张脸串成轻量轨迹，并把时间证据传给清晰代表脸。"""
    by_episode = {}
    for face in faces:
        by_episode.setdefault(face.get("episode"), []).append(face)
    for episode_faces in by_episode.values():
        ordered = sorted(episode_faces, key=lambda x: x.get("frame_index", 0))
        for anchor in ordered:
            if not usable_face(anchor):
                continue
            vector = decode_feature(anchor["feature"])
            evidence = {(anchor.get("episode"), anchor.get("timestamp"))}
            for other in ordered:
                distance = abs(other.get("frame_index", 0) - anchor.get("frame_index", 0))
                if not 0 < distance <= 2:
                    continue
                similarity = feature_similarity(vector, decode_feature(other["feature"]))
                if similarity >= 0.80:
                    evidence.add((other.get("episode"), other.get("timestamp")))
            anchor["track_evidence"] = [
                {"episode": ep, "timestamp": ts}
                for ep, ts in sorted(evidence)
                if ep is not None and ts is not None
            ]
    return faces


def cluster_match_score(face, cluster):
    """计算一张新脸对整组的可信度，并阻止单张误匹配污染整组。"""
    source = face.get("source", "")
    # 同一原始画面里同时检出的不同人，物理上不可能是同一个人。
    if source and (source in cluster.get("sources", set()) or any(
            sample.get("source") == source for sample in cluster.get("samples", []))):
        return 0.0
    vector = decode_feature(face["feature"])
    scores = sorted(
        (feature_similarity(vector, sample["vector"])
         for sample in cluster.get("samples", [])[:6]),
        reverse=True,
    )
    if not scores:
        return 0.0
    # 组内已有多张脸时需要至少两个参考样本共同支持，避免单链式错误扩散。
    return scores[1] if len(scores) >= 2 else scores[0]


def cluster_faces(faces, threshold=0.91):
    """组级保守聚类：多证据一致才合并，宁可重复也不串人。"""
    clusters = []
    ranked_faces = sorted(
        faces,
        key=lambda x: (x.get("quality", 0), face_clarity(x.get("crop", ""))),
        reverse=True,
    )
    for face in ranked_faces:
        if not usable_face(face):
            continue
        vector = decode_feature(face["feature"])
        best = None
        best_score = threshold
        for cluster in clusters:
            score = cluster_match_score(face, cluster)
            if score > best_score:
                best, best_score = cluster, score
        sample = {"crop": face["crop"], "source": face.get("source", ""),
                  "feature": face["feature"], "vector": vector,
                  "quality": face.get("quality", 0), "engine": face.get("engine", "vision-v1"),
                  "episode": face.get("episode"), "timestamp": face.get("timestamp"),
                  "video": face.get("video", ""),
                  "video_duration": face.get("video_duration"),
                  "track_evidence": face.get("track_evidence", [])}
        appearance = {"episode": face.get("episode"),
                      "timestamp": face.get("timestamp"),
                      "video": face.get("video", "")}
        if best is None:
            clusters.append({"samples": [sample], "appearances": [appearance],
                             "sources": {face.get("source", "")}, "score": 1.0})
        else:
            best["sources"].add(face.get("source", ""))
            if appearance not in best["appearances"]:
                best["appearances"].append(appearance)
            best["samples"] = select_reference_samples(best["samples"] + [sample], 8)
    clusters.sort(key=lambda c: (-len(c["samples"]), -c["samples"][0]["quality"]))
    return clusters


def cached_video_dir(output_dir):
    root = library_dir(output_dir)
    for filename in ("候选来源.json", "已确认.json"):
        try:
            with open(os.path.join(root, filename), encoding="utf-8") as f:
                value = json.load(f).get("video_dir", "")
            if value:
                return os.path.abspath(value)
        except (OSError, json.JSONDecodeError):
            continue
    return ""


def guess_episode_number(video, fallback):
    """从文件名提取集号，失败时使用排序序号。"""
    name = os.path.splitext(os.path.basename(video))[0]
    for pattern in (r"第\s*(\d+)\s*集", r"(?:EP|E)\s*0*(\d+)", r"(\d+)"):
        match = re.search(pattern, name, re.I)
        if match:
            return int(match.group(1))
    return int(fallback)


def load_candidate_cache(output_dir, video_dir="", anime_mode=False):
    """从已完成的候选缩略图恢复特征，界面重开时无需再扫描整部剧。"""
    source = cached_video_dir(output_dir)
    if video_dir and source and source != os.path.abspath(video_dir):
        return []
    metadata_path = os.path.join(library_dir(output_dir), CANDIDATE_CACHE_FILENAME)
    try:
        with open(metadata_path, encoding="utf-8") as f:
            metadata = json.load(f)
        if (metadata.get("version") != 7 or
                bool(metadata.get("anime_mode")) != bool(anime_mode)):
            return []
        cached_items = metadata.get("items", [])
        if (metadata.get("video_dir") == os.path.abspath(video_dir) and
                cached_items and all(
                    os.path.exists(sample.get("image", ""))
                    for item in cached_items for sample in item.get("samples", []))):
            if anime_mode:
                from anime_identity import clear_face_suggestions
                return clear_face_suggestions(cached_items)
            return cached_items
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    if anime_mode:
        return []
    candidate_dir = os.path.join(library_dir(output_dir), "候选人物")
    if not os.path.isdir(candidate_dir):
        return []
    grouped = {}
    for name in os.listdir(candidate_dir):
        m = re.match(r"^人物(\d+)_(\d+)\.jpg$", name)
        if m:
            grouped.setdefault(int(m.group(1)), []).append(os.path.join(candidate_dir, name))
    if len(grouped) < 3:
        return []
    images = [p for paths in grouped.values() for p in sorted(paths)[:5]]
    with tempfile.TemporaryDirectory(prefix="pajuben_face_cache_") as tmp:
        detected = scan_images(images, tmp)
    by_source = {}
    for face in detected:
        # 人脸缩略图里偶尔仍检出多个脸，只取质量最高的一个。
        old = by_source.get(face["source"])
        if old is None or face.get("quality", 0) > old.get("quality", 0):
            by_source[face["source"]] = face
    # 旧界面可能把同一人拆成许多组；恢复时按改进后的阈值跨组重新聚类。
    recoverable = []
    for image, face in by_source.items():
        item = dict(face)
        item["crop"] = image
        item["quality"] = max(100, item.get("quality", 0))
        if usable_face(item, min_quality=0):
            recoverable.append(item)
    merged = cluster_faces(recoverable, threshold=0.88)
    result = []
    for ident, cluster in enumerate(merged[:60], 1):
        samples = []
        for sample in cluster["samples"][:5]:
            image = sample["crop"]
            old = re.search(r"人物(\d+)_", os.path.basename(image))
            context = os.path.join(
                candidate_dir,
                f"{os.path.splitext(os.path.basename(image))[0]}_上下文.jpg",
            )
            if not os.path.exists(context) and old:
                context = os.path.join(
                    candidate_dir, f"人物{int(old.group(1)):02d}_上下文.jpg")
            samples.append({"image": image, "context": context if os.path.exists(context) else "",
                            "feature": sample["feature"], "engine": sample.get("engine", "opencv-sface-v1")})
        if samples:
            result.append({"id": ident, "samples": samples, "count": len(cluster["samples"])})
    return arrange_suspects(merge_high_confidence(result))


def build_candidates(video_dir, output_dir, seed_count=0, progress=None, reuse_cache=True,
                     anime_mode=False):
    video_dir = os.path.abspath(video_dir)
    old_video_dir = cached_video_dir(output_dir)
    if old_video_dir and old_video_dir != video_dir:
        root = library_dir(output_dir)
        backup = f"{root}_旧剧备份_{time.strftime('%Y%m%d_%H%M%S')}"
        shutil.move(root, backup)
        if progress:
            progress(f"检测到新剧，上一部人物库已保留到：{backup}")
    if reuse_cache:
        cached = load_candidate_cache(output_dir, video_dir, anime_mode)
        if cached:
            if progress: progress(f"已恢复 {len(cached)} 组候选人物，跳过重复扫描…")
            return cached
    videos = sorted(os.path.join(video_dir, n) for n in os.listdir(video_dir)
                    if n.lower().endswith(VIDEO_EXTS))
    if seed_count and seed_count > 0:
        videos = videos[:seed_count]
    if not videos:
        raise RuntimeError("所选文件夹里没有视频")
    root = library_dir(output_dir)
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "候选来源.json"), "w", encoding="utf-8") as f:
        json.dump({"video_dir": video_dir, "scan_scope": "all"},
                  f, ensure_ascii=False, indent=2)
    candidate_dir = os.path.join(root, "候选人物")
    os.makedirs(candidate_dir, exist_ok=True)
    all_faces = []
    with tempfile.TemporaryDirectory(prefix="pajuben_faces_") as tmp:
        for index, video in enumerate(videos, 1):
            if progress:
                progress(f"正在扫描第 {index}/{len(videos)} 个视频…")
            # 全集只做稀疏扫描，避免人物预审比正式扒取还慢；短范围扫描则提高密度。
            interval = 8 if len(videos) > 10 else 4
            max_frames = 30 if len(videos) > 10 else 80
            frames = extract_candidate_frames(video, os.path.join(tmp, f"frames_{index}"),
                                               interval, max_frames)
            detected = scan_images(frames, os.path.join(tmp, f"faces_{index}"))
            episode = guess_episode_number(video, index)
            duration = probe_video_duration(video)
            for face in detected:
                face["episode"] = episode
                face["video"] = video
                face["frame_index"] = frame_number(face.get("source", ""))
                face["timestamp"] = face["frame_index"] * interval
                face["video_duration"] = duration
            all_faces.extend(propagate_track_evidence(detected))
        # 3D动漫角色常共用相近脸模。提高门槛，避免本地真人特征模型先把不同角色硬合并；
        # 后续由视觉模型结合多张完整场景、造型和剧情证据判断。
        clusters = cluster_faces(all_faces, threshold=0.95 if anime_mode else 0.91)
        result = []
        for i, cluster in enumerate(clusters[:60], 1):
            samples = []
            sharp_samples = select_reference_samples(cluster["samples"], 5)
            for j, sample in enumerate(sharp_samples[:5], 1):
                dest = os.path.join(candidate_dir, f"人物{i:02d}_{j}.jpg")
                shutil.copy2(sample["crop"], dest)
                context = ""
                if sample.get("source") and os.path.exists(sample["source"]):
                    context = os.path.join(candidate_dir, f"人物{i:02d}_{j}_上下文.jpg")
                    shutil.copy2(sample["source"], context)
                samples.append({"image": dest, "context": context,
                                "feature": sample["feature"],
                                "engine": sample.get("engine", "opencv-sface-v1"),
                                "episode": sample.get("episode"),
                                "timestamp": sample.get("timestamp"),
                                "video": sample.get("video", ""),
                                "video_duration": sample.get("video_duration"),
                                "track_evidence": sample.get("track_evidence", [])})
            result.append({"id": i, "samples": samples,
                           "appearances": cluster.get("appearances", []),
                           "count": len(cluster.get("appearances", cluster["samples"]))})
    if anime_mode:
        from anime_identity import clear_face_suggestions
        final = clear_face_suggestions(result)
    else:
        final = arrange_suspects(merge_high_confidence(result))
    with open(os.path.join(root, CANDIDATE_CACHE_FILENAME), "w", encoding="utf-8") as f:
        json.dump({"version": 7, "video_dir": video_dir,
                   "anime_mode": bool(anime_mode), "items": final},
                  f, ensure_ascii=False, indent=2)
        f.write("\n")
    return final


def identify_frames(frames, output_dir, work_dir, threshold=0.93, margin=0.025,
                    anime_mode=False):
    # 真人特征模型对3D动漫脸的分值没有可靠身份含义。动漫模式由多模态模型
    # 结合整帧、权威角色表和剧情上下文判断，避免错误姓名成为强制提示。
    if anime_mode:
        return {}
    library = load_library(output_dir)
    roles = [r for r in library.get("roles", []) if r.get("name") and r.get("samples")]
    if not roles:
        return {}
    prepared = []
    for role in roles:
        vectors = []
        for sample in role["samples"]:
            try:
                vectors.append(decode_feature(sample["feature"]))
            except Exception:
                pass
        if vectors:
            prepared.append((role["name"], vectors))
    faces = scan_images([fp for fp, _ in frames], os.path.join(work_dir, "identified_faces"))
    hints = {}
    for face in faces:
        vector = decode_feature(face["feature"])
        scores = sorted(((max(feature_similarity(vector, v) for v in vectors), name)
                         for name, vectors in prepared), reverse=True)
        if not scores:
            continue
        score, name = scores[0]
        second = scores[1][0] if len(scores) > 1 else 0.0
        if score >= threshold and score - second >= margin:
            hints.setdefault(face["source"], {})[name] = max(
                score, hints.setdefault(face["source"], {}).get(name, 0))
    return {fp: sorted(names) for fp, names in hints.items()}
