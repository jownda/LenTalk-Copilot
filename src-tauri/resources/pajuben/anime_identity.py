"""Animation identity decisions use visual evidence, independently of names."""
import copy
from face_identity import cooccurrence_conflict

TRAITS = ("hair_length", "hair_color", "hair_shape", "accessories", "body_shape")


def clear_face_suggestions(items):
    for item in items:
        for key in ("similar_to", "face_similarity", "clothing_similarity", "same_default"):
            item.pop(key, None)
        item["suspect_group"] = item["id"]
    return items


def visual_shortlist(items, predictions, per_person=3):
    """Traits select pairs for actual multi-image inspection, never authorize a merge."""
    pairs = set()
    for item in items:
        pred = predictions.get(item["id"], {})
        traits = pred.get("appearance", {})
        if not isinstance(traits, dict):
            continue
        ranked = []
        for other in items:
            if other is item or cooccurrence_conflict(item, other):
                continue
            rhs = predictions.get(other["id"], {})
            other_traits = rhs.get("appearance", {})
            if not isinstance(other_traits, dict):
                continue
            matches = sum(bool(traits.get(k)) and traits.get(k) not in ("unknown", "不确定")
                          and traits.get(k) == other_traits.get(k) for k in TRAITS)
            same_name = bool(pred.get("name")) and not str(pred["name"]).startswith(
                ("未识别", "背景")) and pred.get("name") == rhs.get("name")
            if matches >= 2 or same_name:
                ranked.append((matches + int(same_name), other["id"]))
        for _, ident in sorted(ranked, reverse=True)[:per_person]:
            pairs.add(tuple(sorted((item["id"], ident))))
    return sorted(pairs)


def strong_same(result):
    try:
        confidence = float(result.get("confidence", 0))
    except (ValueError, TypeError):
        return False
    stable = result.get("matching_traits", [])
    return (result.get("decision") == "same" and confidence >= 0.94
            and result.get("conflicts") == [] and result.get("both_consistent") is True
            and isinstance(stable, list) and all(isinstance(s, str) for s in stable)
            and (len(set(stable) & set(TRAITS)) >= 2 or result.get("context_verified") is True))


def apply_visual_decisions(items, predictions, decisions):
    """Require agreement across every pair in a merged group, blocking transitive mistakes."""
    items = clear_face_suggestions(copy.deepcopy(items))
    groups = [[item] for item in items]
    for pair, result in decisions.items():
        if not strong_same(result):
            continue
        left = next((g for g in groups if any(i["id"] == pair[0] for i in g)), None)
        right = next((g for g in groups if any(i["id"] == pair[1] for i in g)), None)
        if left is None or right is None or left is right:
            continue
        if all(not cooccurrence_conflict(a, b) and strong_same(decisions.get(
                tuple(sorted((a["id"], b["id"]))), {})) for a in left for b in right):
            left.extend(right)
            groups.remove(right)
    merged = []
    for members in groups:
        anchor = members[0]
        if len(members) > 1:
            anchor["visual_merged_ids"] = [m["id"] for m in members]
            anchor["samples"] = [s for m in members for s in m.get("samples", [])]
            anchor["appearances"] = [s for m in members for s in m.get("appearances", [])]
            anchor["count"] = sum(m.get("count", 0) for m in members)
            names = {str(predictions.get(m["id"], {}).get("name", "")).strip()
                     for m in members}
            pred = predictions.setdefault(anchor["id"], {})
            pred["reason"] = "多图造型复核通过，已自动归组。" + str(pred.get("reason", ""))
            if len(names) > 1:
                pred["confidence"] = 0
                pred["reason"] += " 姓名存在差异，只需核对此组姓名。"
        merged.append(anchor)
    # Only genuinely uncertain visual pairs become comparison tasks.
    owner = {m["id"]: g[0] for g in groups for m in g}
    for pair, result in decisions.items():
        if result.get("decision") != "uncertain":
            continue
        a, b = owner.get(pair[0]), owner.get(pair[1])
        if a is None or b is None or a is b or b.get("similar_to"):
            continue
        if any(cooccurrence_conflict(x, y) for x in next(g for g in groups if g[0] is a)
               for y in next(g for g in groups if g[0] is b)):
            continue
        b["similar_to"] = a["id"]
        b["suspect_group"] = a["suspect_group"]
        b["visual_reason"] = str(result.get("reason", "造型证据不充分"))
        predictions.setdefault(b["id"], {})["_same"] = "待确认"
    return merged
