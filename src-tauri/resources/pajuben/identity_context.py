"""Bounded story evidence and validation for uncertain character pairs."""
import os
import re


def covers_timestamp(text, timestamp):
    """文本里是否有场景覆盖这个时间点（秒）。

    场景头的时间标注有两种写法，都要认：
    - 旧格式 `时间：MM:SS-MM:SS` —— 起止时间码直接写着，最精确，优先用；
    - 新格式 `总时长：N秒` —— 只有长度没有起点，按剧本的时间顺序累加推出各场区间
      （剧本严格按播放顺序输出，闪回也落在它真实占用的时段里，所以累加成立）。
    """
    if timestamp is None or "未找到匹配时间段" in text:
        return False
    moment = float(timestamp)
    spans = [
        (int(a) * 60 + int(b), int(c) * 60 + int(d))
        for a, b, c, d in re.findall(r"时间[：:]\s*(\d+):(\d+)\s*[-–—]\s*(\d+):(\d+)", text)
    ]
    if spans:
        return any(lo <= moment <= hi for lo, hi in spans)
    cursor = 0.0
    for raw in re.findall(r"总时长[：:]\s*(\d+(?:\.\d+)?)\s*秒", text):
        end = cursor + float(raw)
        if cursor <= moment <= end:
            return True
        cursor = end
    return False


def collect_context(items, output_dir, story_loader, library):
    sources = []
    for item in items:
        seen = set()
        for sample in item.get("samples", []):
            ep, timestamp = sample.get("episode"), sample.get("timestamp")
            if ep is None or (ep, timestamp) in seen:
                continue
            seen.add((ep, timestamp))
            text = story_loader(output_dir, [sample], per_episode=1600)
            if text:
                sources.append({"id": f"S{len(sources) + 1}", "candidate": item["id"],
                    "episode": ep, "timestamp": timestamp, "text": text,
                    "direct": covers_timestamp(text, timestamp)})
            if len(seen) >= 3:
                break
    episodes = sorted({s["episode"] for s in sources})
    neighbors = sorted({ep + delta for ep in episodes for delta in (-1, 1)
                        if ep + delta > 0 and ep + delta not in episodes})[:4]
    background = story_loader(output_dir, neighbors, per_episode=600)
    videos = {os.path.realpath(s["video"]) for item in items for s in item.get("samples", [])
              if s.get("video")}
    roles = []
    for role in library.get("roles", []):
        if any(s.get("video") and os.path.realpath(s["video"]) in videos
               for s in role.get("samples", [])):
            roles.append({k: role.get(k, "") for k in ("name", "identity", "type")})
    return {"sources": sources, "neighbor_background": background,
            "confirmed_roles": roles[:20]}


def validate_context_result(result, context, candidate_ids):
    result = dict(result)
    result.pop("context_verified", None)
    sources = {s["id"]: s for s in context["sources"]}
    covered = set()
    valid = []
    citations = result.get("citations", [])
    for citation in citations if isinstance(citations, list) else []:
        if not isinstance(citation, dict):
            continue
        source = sources.get(citation.get("source_id"))
        quote = citation.get("quote")
        if (source and source["direct"] and isinstance(quote, str) and len(quote.strip()) >= 4
                and quote in source["text"]):
            covered.add(source["candidate"])
            valid.append({"kind": "context", "episode": source["episode"],
                          "timestamp": source["timestamp"], "quote": quote})
    result["context_verified"] = set(candidate_ids).issubset(covered)
    result["validated_evidence"] = valid
    if not result["context_verified"]:
        result["decision"] = "uncertain"
        result["reason"] = "上下文证据未覆盖双方或引用无法核验，暂不自动合并。"
    return result
