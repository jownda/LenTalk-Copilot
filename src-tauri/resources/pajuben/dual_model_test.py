#!/usr/bin/env python3
"""单集双模型测试：音频转写 + 视觉拉片 + 文本合并。"""

import argparse
import base64
import os
import shutil
import tempfile

import pajuben


def save(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def audio_messages(audio_path, ep):
    data = base64.b64encode(open(audio_path, "rb").read()).decode()
    prompt = f"""你是专业影视听写员。完整听写短剧第{ep}集音频。
要求：
1. 按时间顺序输出，约每5至10秒标一次【分:秒】时间戳。
2. 完整保留所有人物台词、旁白、内心独白和有意义的环境声，不得总结或改写。
3. 能判断说话人就写姓名，不能确定写“未知角色”，不要猜姓名。
4. 听不清处写【听不清】，不要编造。
5. 只输出带时间戳的听写稿。"""
    return [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "input_audio", "input_audio": {"data": data, "format": "mp3"}},
    ]}]


def vision_messages(frames, ep, known_roles, batch_no=1, batch_total=1):
    prompt = f"""你是专业短剧拉片师。下面是第{ep}集按时间顺序抽取的120帧画面。
当前是画面批次 {batch_no}/{batch_total}。只分析本批画面，不猜台词。逐镜头记录场景、人物位置、动作链、表情、神态、视线、手部动作、人物进出和反应镜头。
每条必须带【分:秒】时间戳；不同镜头或人物反应另起一条，不得把几十秒内容概括成一句。
表情要写可见变化，例如眉眼、嘴角、视线和身体姿态；看不清就不写，严禁脑补心理。
已知角色表如下，能确认时必须使用其中姓名：
{known_roles or '暂无'}
只输出画面拉片记录。"""
    content = [{"type": "text", "text": prompt}]
    for fp, t in frames:
        mm, ss = int(t) // 60, int(t) % 60
        content.append({"type": "text", "text": f"【{mm:02d}:{ss:02d}】"})
        content.append({"type": "image_url", "image_url": {
            "url": f"data:image/jpeg;base64,{pajuben.b64_file(fp)}", "detail": "low"}})
    return [{"role": "user", "content": content}]


def merge_prompt(ep, transcript, vision, known_roles):
    return f"""你是短剧剧本整理师。把同一集的音频听写和画面拉片按时间戳严格对齐，整理为标准拉片剧本。

硬性要求：
- 台词、旁白和内心独白以音频听写为准，不能删减或改写含义。
- 场景、动作、表情和人物反应以画面拉片为准，不能脑补。
- 不得只写剧情摘要；完整保留动作链、神态、视线和反应镜头。
- 同一地点连续戏不拆场；地点或日夜/内外改变才开新场。
- 场号严格为 {ep}-1、{ep}-2……
- 使用已知角色姓名；无法确认时保留“未知角色”，不要强猜。
- 结尾输出完整角色表。

已知角色表：
{known_roles or '暂无'}

【音频听写】
{transcript}

【画面拉片】
{vision}

输出格式：
# 第{ep}集
{ep}-1场 日/夜 内/外 地点
人物：……
△ 动作、表情和反应。
角色名：台词
角色名（VO）：旁白
角色名（OS）：内心独白

角色表
角色名：身份
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--ep", type=int, default=1)
    ap.add_argument("--base", default="https://ark.cn-beijing.volces.com/api/v3")
    ap.add_argument("--audio-model", default="doubao-seed-2-0-lite-260428")
    ap.add_argument("--vision-model", default="doubao-seed-2-1-pro-260628")
    ap.add_argument("--key", default=os.environ.get("PAJUBEN_API_KEY", ""))
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--roles-file", default="")
    args = ap.parse_args()
    if not args.key:
        raise SystemExit("缺少 API Key")

    known = ""
    if args.roles_file and os.path.exists(args.roles_file):
        known = open(args.roles_file, encoding="utf-8").read()
    os.makedirs(args.output_dir, exist_ok=True)
    audio_out = os.path.join(args.output_dir, f"第{args.ep}集_音频听写.txt")
    vision_out = os.path.join(args.output_dir, f"第{args.ep}集_画面拉片.txt")
    final_out = os.path.join(args.output_dir, f"第{args.ep}集_双模型.txt")
    if os.path.exists(final_out) and os.path.getsize(final_out) > 100:
        print(f"[3/3] 复用已完成双模型结果：{final_out}", flush=True)
        return

    workdir = tempfile.mkdtemp(prefix="dual_pajuben_")
    try:
        if os.path.exists(audio_out) and os.path.getsize(audio_out) > 100:
            transcript = open(audio_out, encoding="utf-8").read()
            print(f"[1/3] 复用已完成音频听写：{audio_out}", flush=True)
        else:
            print("[1/3] 提取并听写音频…", flush=True)
            audio = pajuben.extract_audio(args.video, workdir)
            if not audio:
                raise RuntimeError("视频没有可用音轨")
            transcript = pajuben.call_api(args.base, args.key, args.audio_model,
                                          audio_messages(audio, args.ep), "", timeout=420)
            save(audio_out, transcript)
            print(f"[1/3] 已保存：{audio_out}", flush=True)

        # 72帧足以覆盖1–3分钟短剧；每批24帧，显著降低单次请求体积和超时率。
        frame_budget = 72
        batch_size = 24
        print(f"[2/3] 抽取{frame_budget}帧并分析画面…", flush=True)
        frame_dir = os.path.join(workdir, "frames")
        os.makedirs(frame_dir)
        duration = pajuben.probe_duration(args.video)
        fps = frame_budget / duration if duration > frame_budget else 1
        frames = pajuben.extract_frames(args.video, fps, 512, frame_budget, frame_dir)
        batches = [frames[i:i + batch_size] for i in range(0, len(frames), batch_size)]
        vision_parts = []
        for i, batch in enumerate(batches, 1):
            part_out = os.path.join(args.output_dir,
                                    f"第{args.ep}集_画面拉片_{i}-{len(batches)}.txt")
            if os.path.exists(part_out) and os.path.getsize(part_out) > 100:
                part = open(part_out, encoding="utf-8").read()
                print(f"[2/3] 复用画面批次 {i}/{len(batches)}", flush=True)
            else:
                print(f"[2/3] 分析画面批次 {i}/{len(batches)}（{len(batch)}帧）…", flush=True)
                part = pajuben.call_api(
                    args.base, args.key, args.vision_model,
                    vision_messages(batch, args.ep, known, i, len(batches)), "", timeout=420)
                save(part_out, part)
            vision_parts.append(part)
        vision = "\n\n".join(vision_parts)
        save(vision_out, vision)
        print(f"[2/3] 已保存：{vision_out}", flush=True)

        print("[3/3] 按时间戳合并剧本…", flush=True)
        final = pajuben.call_text(args.base, args.key, args.vision_model,
                                  merge_prompt(args.ep, transcript, vision, known), "", timeout=420)
        save(final_out, final)
        print(f"[3/3] 完成：{final_out}", flush=True)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
