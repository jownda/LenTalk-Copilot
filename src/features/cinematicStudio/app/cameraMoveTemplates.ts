import type { Locale } from "./i18n";

export type CameraMoveTemplateGroup = "common" | "classic" | "masters";

export interface CameraMoveTemplate {
  id: string;
  label: string;
  description: string;
}

export const CAMERA_MOVE_TEMPLATE_GROUPS: CameraMoveTemplateGroup[] = ["common", "classic", "masters"];

export const CAMERA_MOVE_TEMPLATES: Record<Locale, Record<CameraMoveTemplateGroup, CameraMoveTemplate[]>> = {
  zh: {
    common: [
      { id: "locked-close", label: "静观特写", description: "相机保持锁定，眼平高度，中近景；焦点始终停在主体眼睛上，只保留摄影师呼吸带来的极轻微沉降，让表演自己发生。" },
      { id: "slow-push", label: "缓慢推进", description: "相机从中景缓慢、匀速推近到近景；在角色意识到关键信息时开始推进，结束时稳定停在眼睛上，对焦不游移。" },
      { id: "slow-pull", label: "缓慢后拉", description: "从近景平稳后拉到中远景；在人物决定退让或意识到孤立时开始，逐步露出周围空间，结束后保持静止。" },
      { id: "lateral-track", label: "侧向跟拍", description: "摄影机与人物保持平行，在腰部高度侧向跟拍；步伐节奏带来真实重量转移，始终维持人物前方的移动空间。" },
      { id: "follow-behind", label: "背后跟随", description: "相机在人物后方半步跟随，保持肩背与前方目的地同框；人物转身或停住时相机延迟半拍再稳定落位。" },
      { id: "reaction-handoff", label: "反应切换", description: "先稳定观察说话者，在对方台词尚未结束时平稳移向听者的反应；镜头落在听者眼睛上并停住，不抢在表演前移动。" },
      { id: "pressured-handheld", label: "手持压迫", description: "近距离手持，机位略低于视线；由摄影师呼吸、脚步和重心转移产生克制的微小沉降，紧跟角色失控边缘，但不使用数字抖动。" },
      { id: "orbit-reveal", label: "环绕揭示", description: "围绕主体缓慢弧线移动，先遮住关键信息，再在角色抬眼或转身时揭示对手或环境；结束于稳定的双人关系构图。" },
      { id: "rack-focus", label: "焦点转移", description: "机位保持稳定，焦点从前景主体缓慢转移到后景信息或反应人物；焦点变化由一次目光、停顿或台词触发，两个焦点之间不来回抽动。" },
      { id: "whip-handoff", label: "甩镜连接", description: "在前一节拍动作达到峰值时快速甩镜，沿明确方向掠过环境，甩镜结束立即锁定下一主体；动作带动转场，落点保持清晰。" },
    ],
    classic: [
      { id: "hitchcock-push-pull", label: "希区柯克推拉", description: "角色意识到威胁的瞬间，相机稳定后退同时反向变焦，背景透视明显拉伸而人物大小基本保持；效果只服务于主观失衡，结束后立即稳住。" },
      { id: "welles-deep-focus", label: "奥逊·威尔斯深焦", description: "低机位广角构图，前景、中景和后景的关键人物都保持清晰；让权力关系在同一画面内发生，镜头克制地保持观察。" },
      { id: "kubrick-symmetry", label: "库布里克对称推进", description: "严格居中对称构图，稳定直线缓慢推进；人物保持在画面中轴，速度冷静而不可阻挡，推进只在空间或心理压力升级时开始。" },
      { id: "telephoto-surveillance", label: "长焦窥视", description: "远距离长焦隔着前景观察人物，压缩空间并保留遮挡；相机几乎不动，只在角色暴露关键信息时极慢微调构图。" },
      { id: "ford-doorway", label: "福特门框构图", description: "相机稳定置于门框或窗框之外，以框中框观察人物进出；人物跨越门槛时才改变构图，让空间边界承担关系变化。" },
      { id: "leone-hold", label: "莱昂内凝固对峙", description: "极缓慢地从环境细节推进到人物眼睛，长时间保持沉默和微动作；切换只发生在视线、手指或呼吸出现决定性变化时。" },
      { id: "spielberg-blocking", label: "斯皮尔伯格调度长镜", description: "稳定移动镜头在同一镜内重排前中后景人物；通过人物走位、遮挡和入画完成信息交接，不用无动机的切镜。" },
      { id: "peckinpah-impact", label: "派金帕冲击切换", description: "在动作真正接触的瞬间切入短促、清晰的不同角度；每次切换都保留动作方向和因果，不用随机摇晃替代冲击。" },
    ],
    masters: [
      { id: "scorsese-passage", label: "斯科塞斯穿行", description: "稳定器长镜头贴着主角穿过空间，前后景人物和事件依次进入画面；相机运动由主角明确目的驱动，在关键关系处短暂停留再继续。" },
      { id: "wong-delayed-follow", label: "王家卫延迟跟随", description: "手持或轻稳拍以半拍延迟跟随人物，保留人物离开画面和重新进入的空隙；焦点短暂游移后回到眼神，让距离感留在画面里。" },
      { id: "tarkovsky-gaze", label: "塔可夫斯基凝视", description: "长时间稳定观察，极缓慢地平移或推进；让风、光、水汽和人物微动作共同积累时间，镜头不替角色解释情绪。" },
      { id: "depalma-surveillance", label: "德帕尔玛分离窥视", description: "缓慢横移或环绕，把主体与威胁分置在同一空间层次；镜头先让观众看见危险，再延迟让角色发现，运动始终平滑克制。" },
      { id: "malick-drift", label: "马利克游移凝望", description: "轻手持在人物周围游移，偶尔向光线、树叶或手部细节偏离，再回到人物；镜头像被当下感官吸引，而非机械追踪。" },
      { id: "fincher-precision", label: "芬奇精密推进", description: "机位、速度和构图严格受控，直线推进或平移几乎无可见误差；在角色试图维持控制时保持秩序，让微小失控更明显。" },
      { id: "soderbergh-observer", label: "索德伯格冷静观察", description: "略偏侧面的稳定机位保持适度距离，以简洁推拉或横移跟随信息变化；不替角色煽情，把判断留给表演和剪辑。" },
      { id: "kurosawa-weather", label: "黑泽明动态空间", description: "让人物、风雨、尘土或旗帜共同驱动横移和跟拍；运动方向清晰，人物在深度空间中进出，环境力量持续可见。" },
    ],
  },
  en: {
    common: [
      { id: "locked-close", label: "Locked close observation", description: "Hold a locked eye-level medium close-up. Keep focus on the subject's eyes; only the operator's breath creates a nearly imperceptible settle, letting the performance occur on its own." },
      { id: "slow-push", label: "Slow push-in", description: "Move evenly from a medium shot into a close-up. Start the push when the character understands the key information, finish locked on the eyes, and never let focus wander." },
      { id: "slow-pull", label: "Slow pull-back", description: "Ease back from a close shot to a medium-wide view as the person concedes or registers isolation. Reveal the surrounding space gradually, then hold still." },
      { id: "lateral-track", label: "Lateral tracking", description: "Track parallel to the character at waist height. Let footfalls create real weight transfer while preserving moving room in front of the subject." },
      { id: "follow-behind", label: "Follow from behind", description: "Follow half a step behind the character, holding shoulders and destination in frame. When they turn or stop, let the camera arrive a half-beat later and settle." },
      { id: "reaction-handoff", label: "Reaction handoff", description: "Observe the speaker steadily, then move smoothly to the listener's reaction before the line fully ends. Land on the listener's eyes and hold; never move ahead of the performance." },
      { id: "pressured-handheld", label: "Pressured handheld", description: "Work close in handheld, slightly below eyeline. Operator breath, footsteps, and weight shifts create restrained micro-settling near the character's breaking point; no digital shake." },
      { id: "orbit-reveal", label: "Orbit reveal", description: "Arc slowly around the subject, withholding key information until a lifted gaze or turn reveals the other person or environment. Finish in a stable two-person relationship frame." },
      { id: "rack-focus", label: "Rack focus", description: "Keep the camera locked while focus travels from a foreground subject to background information or a reacting person. A glance, pause, or line triggers the shift; never hunt between points." },
      { id: "whip-handoff", label: "Whip-pan handoff", description: "Whip-pan in one clear direction at the peak of the prior beat, pass across the environment, then immediately lock onto the next subject. The action drives the cut and the landing remains sharp." },
    ],
    classic: [
      { id: "hitchcock-push-pull", label: "Hitchcock push-pull", description: "At the instant the character registers threat, track backward while zooming in the opposite direction. Stretch the background perspective while keeping the subject nearly the same size, then settle immediately." },
      { id: "welles-deep-focus", label: "Welles deep focus", description: "Use a low, wide composition with key figures in foreground, middle ground, and background all readable. Let power relations play in one frame; keep the camera's observation restrained." },
      { id: "kubrick-symmetry", label: "Kubrick symmetry push", description: "Keep a strict centered, symmetrical composition and make a stable straight slow push. The subject stays on the image axis; begin only as spatial or psychological pressure rises." },
      { id: "telephoto-surveillance", label: "Telephoto surveillance", description: "Observe from a distant telephoto position through foreground obstruction. Compress space and remain nearly still, making only a very slow reframing when the character exposes crucial information." },
      { id: "ford-doorway", label: "Ford doorway frame", description: "Keep the camera stable beyond a doorway or window, using a frame within the frame to observe entries and exits. Recompose only when a character crosses the threshold." },
      { id: "leone-hold", label: "Leone standoff hold", description: "Move from environmental detail to eyes with extreme patience, sustaining silence and tiny gestures. Cut only when a gaze, finger, or breath makes a decisive change." },
      { id: "spielberg-blocking", label: "Spielberg blocking take", description: "A stable moving shot rearranges foreground, middle ground, and background figures within one take. Use entrances, occlusion, and staging to hand off information instead of unmotivated cuts." },
      { id: "peckinpah-impact", label: "Peckinpah impact handoff", description: "At the instant of real contact, cut through short, clear angles. Preserve screen direction and causality in every cut; never substitute random shaking for impact." },
    ],
    masters: [
      { id: "scorsese-passage", label: "Scorsese passage", description: "A stabilised long take travels with the protagonist through the space as people and events enter foreground and background. The movement follows a clear objective, briefly pausing at key relationships before continuing." },
      { id: "wong-delayed-follow", label: "Wong Kar-wai delayed follow", description: "Handheld or lightly stabilised coverage follows the character a half-beat late, preserving the empty space after departures and before re-entries. Let focus drift briefly, then return to the eyes." },
      { id: "tarkovsky-gaze", label: "Tarkovsky gaze", description: "Sustain a long, steady observation with an extremely slow pan or push. Let wind, light, vapor, and tiny gestures accumulate time; the camera does not explain the character's emotion." },
      { id: "depalma-surveillance", label: "De Palma divided surveillance", description: "Slowly track or arc to place the subject and threat in the same spatial plane. Let the audience see danger first, then delay the character's discovery; keep the movement smooth and restrained." },
      { id: "malick-drift", label: "Malick drifting gaze", description: "Use a light handheld drift around the character, occasionally pulled toward light, leaves, or hand detail before returning. The camera follows immediate sensation rather than mechanical pursuit." },
      { id: "fincher-precision", label: "Fincher precision move", description: "Keep position, speed, and composition rigorously controlled; a straight push or track has almost no visible error. Maintain order as the character tries to maintain control, making small failures visible." },
      { id: "soderbergh-observer", label: "Soderbergh observer", description: "Hold a slightly offset stable vantage at an appropriate distance, using concise pushes, pulls, or lateral adjustments as information changes. Do not sentimentalize for the character." },
      { id: "kurosawa-weather", label: "Kurosawa dynamic space", description: "Let people, wind, rain, dust, or flags jointly drive lateral tracking and follow moves. Keep direction clear as figures enter and leave depth; the force of the environment remains visible." },
    ],
  },
};

export function cameraMoveTemplateLibrary(locale: Locale): string {
  return CAMERA_MOVE_TEMPLATE_GROUPS.map((group) => CAMERA_MOVE_TEMPLATES[locale][group]
    .map((template) => `[${template.label}] ${template.description}`)
    .join("\n"))
    .join("\n");
}
