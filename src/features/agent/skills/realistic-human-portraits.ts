/**
 * 真实感人物生图（realistic-human-portraits）
 *
 * 生成漂亮自然、手机随拍质感、不显 AI 感的人物照片与提示词
 *
 * ⚠️ 本文件由 `node scripts/import-agent-skill.mjs` 生成，不要手改 —— 重新生成会整份覆盖。
 * 源文件：D:\AI\资产库\BaiduSyncdisk\skill\generate-realistic-human-portraits\SKILL.md
 */
import type { AgentSkill } from "./types";

export const realisticHumanPortraits: AgentSkill = {
  id: "realistic-human-portraits",
  name: "真实感人物生图",
  intro: "生成漂亮自然、手机随拍质感、不显 AI 感的人物照片与提示词",
  // 缩略图：由脚本从 skill 目录复制到 public，随应用打包一起走
  thumbnail: `${import.meta.env.BASE_URL}local-assets/agent-skills/realistic-human-portraits.webp`,
  // 下面这段就是 SKILL.md 正文全文，会原样进入 system prompt —— 不要在这里做精简，
  // 精简即等于替用户改了 skill 的规则。
  rules: `# Generate Realistic Human Portraits

Create attractive people who look photographed rather than rendered. Treat beauty and realism as separate controls: preserve the requested attractiveness first, then add restrained evidence of a real person, camera, garment, and environment.

## Choose the action

1. If the user asks to generate an image, use the available image-generation tool directly.
2. If the user asks for a prompt or template, return one complete copyable prompt block. Keep positive instructions and exclusions together in that block.
3. If the user supplies a reference image, inspect it first. Preserve only the requested identity, composition, pose, clothing, or atmosphere; do not assume all visible traits must be copied.
4. If the target generator is named, use its supported syntax. Otherwise write model-agnostic natural language and omit unsupported parameters.

## Build the portrait in this order

### 1. Lock the person

State age as an explicit adult range when appropriate, gender presentation, ancestry or regional appearance if requested, facial character, hair, expression, pose, and framing.

Translate generic attractiveness into believable structure: harmonious but individual features, clear natural eyes, well-proportioned face, healthy appearance, and a relaxed expression. Do not rely only on words such as \`beautiful\`, \`handsome\`, or \`masterpiece\`.

For ambiguous words such as “女学生” or “男生,” default to an adult university student unless the user clearly requests a child. For children, use age-appropriate family, school, or documentary photography only and omit beauty, glamour, sensuality, makeup, or body-emphasis language.

### 2. Lock the capture conditions

Describe how an ordinary phone obtained the photo:

- modern smartphone, standard 1x lens, handheld
- ordinary auto exposure and auto white balance
- slightly imperfect framing, mild edge distortion, restrained digital noise or compression
- normal indoor daylight, ceiling light, cloudy daylight, or mixed everyday light
- plausible phone depth of field; avoid extreme creamy bokeh unless portrait mode is requested

Prefer observable capture conditions over vague style tags. Do not use \`low-end camera\`, \`bad angle\`, \`harsh light revealing every pore\`, or \`extreme fatigue\` unless the user truly wants an unflattering image.

### 3. Add skin realism locally

Use two to four subtle, localized signs rather than stacking every flaw:

- fine pores mainly around the nose and inner cheeks
- slight tone variation or mild redness near the nose and cheeks
- soft under-eye tone variation
- faint expression lines or nasolabial folds appropriate to age
- natural lip texture, a few tiny blemishes, or very light peach fuzz
- slight facial asymmetry that remains attractive

Ask for skin microtexture to follow the lighting. Keep highlights, pores, and color variation irregular and anatomical, not evenly sprayed across the face. Never equate realism with severe acne, deep wrinkles on a young adult, illness, dirt, greasy skin, or roughened facial structure.

Apply age-specific detail from 《附录 realism-logic.md》 when age is important.

### 4. Stabilize hair, clothing, hands, and room

Use a simple hairstyle with a few independent flyaway strands rather than a dense mass of decorative hair.

Prefer plain cotton, denim, or a simple solid-color garment. Specify a readable collar, sleeves, seams, and folds that follow the body. Avoid logos, text, lace, tiny prints, complex knitwear, plaid, and excessive fabric microdetail unless essential.

When hands are visible, give them a simple action and keep them separated from the face and hair when possible. Ask for natural relaxed fingers, consistent anatomy, and no hidden finger count challenge.

Anchor the setting with three or four ordinary objects and one mild imperfection: rumpled bedding, a charger, a cup, a plain wardrobe, uneven curtains, or a slightly crooked object. Keep the room lived-in but coherent, not generically “messy.”

### 5. Remove photographic polish

Exclude the visual causes of a web-photo look: beauty lighting, golden-hour glamour, cinematic grading, rim light, studio key light, fashion posing, excessive background blur, polished set dressing, poreless skin, face reshaping, and commercial retouching.

Keep exclusions concise. Long negative lists can dilute priorities or cause some generators to reinforce the unwanted concept. State the desired replacement whenever possible, for example: \`ordinary mixed room light, not cinematic lighting\`.

## Balance priorities

For an attractive realistic adult portrait, use this mental weighting:

- 45% identity, attractiveness, expression, and pose
- 25% ordinary camera and lighting behavior
- 15% restrained skin evidence
- 10% clothing, hair, and hand coherence
- 5% lived-in background evidence

When a result is attractive but artificial, modify the camera, light, and local skin evidence before increasing flaws. When a result is realistic but unattractive, reduce defect intensity and tiredness while preserving camera realism.

## Adapt to framing

- **Face close-up:** emphasize eye moisture, local pores, lip texture, mild lens proximity, and cropped spontaneous composition. Keep skin detail subtle because the face occupies most pixels.
- **Near portrait:** balance face, shoulders, simple clothing, and room evidence. This is the most reliable smartphone-realism framing.
- **Half or full body:** reduce facial microdetail and spend more prompt attention on anatomy, garment construction, pose, and environmental scale.

## Output rules

- Follow the user’s language.
- Deliver a prompt as one uninterrupted reusable block, not scattered fragments.
- Preserve the user’s requested attractiveness. “瑕疵感” means subtle human evidence, not ugliness.
- Do not add camera brands, focal lengths, aspect ratios, or generator parameters unless useful or requested.
- Do not append \`8K\`, \`ultra-detailed\`, \`masterpiece\`, \`hyperreal\`, or other polish-amplifying tags.
- When generating an image, keep the final message short and state what was produced.

Use 《附录 prompt-templates.md》 for complete Chinese and English templates. Use 《附录 realism-logic.md》 to diagnose failures and adjust intensity.

---

# 附录（随 SKILL 一同加载的完整参考文档，直接按此执行，不要去读取文件）

## 附录：references/prompt-templates.md

# Prompt Templates

Replace bracketed fields with concrete choices. Keep the final prompt in one block when presenting it to the user.

## Universal Chinese template

\`\`\`text
一张未经精修的现代智能手机随手拍照片。人物是【明确成年年龄或年龄范围】【地区或族裔】【人物类型】，外貌【漂亮 / 帅气 / 有气质 / 朴素但耐看】，面部结构自然协调但具有个人特征，【发型与发色】。人物正在【简单动作】，呈现【脸部特写 / 近景 / 半身 / 全身】，身体姿态放松，【看向镜头 / 看向画外】，表情【安静 / 自然开心 / 若有所思 / 略带疲惫但健康】，像朋友在生活中偶然按下快门，没有刻意摆拍和商业人像表情。

使用普通手机标准1倍镜头手持拍摄，普通自动曝光和自动白平衡，构图略微偏离中心，有轻微自然裁切和很轻的边缘透视，焦点自然落在较近的眼睛或面部。光线来自【普通窗户日光 / 阴天户外光 / 室内顶灯与窗光混合 / 教室荧光灯】，明暗略微不均匀，局部高光可以轻微溢出，色温存在很小的自然偏差；没有电影感布光、轮廓光、黄金时刻氛围、影棚主光或高级写真光。景深符合普通手机拍摄，背景仍能辨认，不使用夸张奶油虚化。

保持人物明显【漂亮 / 帅气 / 有吸引力】，同时让皮肤保留克制而真实的局部细节：鼻翼和内侧脸颊有细小自然毛孔，肤色有轻微不均，眼下有柔和色差，嘴唇有自然纹理，【根据年龄加入一项：一两颗极小瑕疵 / 淡淡表情纹 / 轻微法令纹 / 自然皱纹与色斑】。皮肤细节随光线变化，不均匀分布，面部有极轻微但好看的自然不对称。整体健康、干净、真实，不把瑕疵夸张成粗糙、病态、衰老或难看。

人物穿【简单纯色棉质上衣 / 简洁衬衫 / 牛仔外套 / 朴素工作服】，衣领、肩线、袖口和缝线结构清楚稳定，只有少量由姿势和重力形成的宽缓褶皱，没有logo、文字、蕾丝、格纹或细碎复杂图案。若手部入镜，动作简单放松，手指自然分开，结构一致。头发由清晰的大束发丝和少量独立碎发组成，不形成混乱的线条纹理。

场景是【普通卧室 / 宿舍 / 教室 / 街边 / 小店 / 办公室 / 农村住宅】，背景里能辨认出【三至四个普通生活物件】，尺度和空间关系合理，有一点使用痕迹但不杂乱。照片保留轻微手机压缩、适度数码锐化和极轻微运动柔度，面部、头发、衣服与背景的清晰度彼此一致，像未经美颜、未经磨皮、未经后期精修的普通手机照片。

避免：网红写真感、商业美容人像、影棚摄影、电影感调色、黄金时刻光线、戏剧性阳光、过度背景虚化、完美中心构图、完美对称、瓷娃娃脸、无毛孔皮肤、塑料皮肤、蜡质皮肤、过度磨皮、美颜滤镜、脸部重塑、过度锐化、均匀铺满全脸的毛孔、砂纸皮肤、严重痘痘或皱纹（除非年龄需要）、病态或肮脏感、玻璃眼睛、混乱发丝、融化的衣领、扭曲缝线、随机布料纹理、乱码文字或logo、变形手指、无法辨认的房间结构、3D渲染、数字绘画、明显AI生成质感。
\`\`\`

## Universal English template

\`\`\`text
An unedited casual snapshot taken with a modern smartphone. The subject is a clearly [adult age or age range] [regional or ethnic appearance] [person type], [beautiful / handsome / attractive / quietly charismatic], with harmonious but individual facial structure and [hair description]. They are [simple action] in a [face close-up / near portrait / half-body / full-body] composition, with relaxed posture, [looking at the camera / glancing away], wearing a [calm / naturally cheerful / thoughtful / slightly tired but healthy] expression. The moment feels accidentally captured by a nearby friend, without deliberate fashion posing or a commercial portrait expression.

Handheld standard 1x smartphone lens, ordinary automatic exposure and white balance, slightly off-center framing, a small natural crop, very mild edge perspective, and autofocus falling naturally on the nearer eye or central face. Lighting comes from [ordinary window daylight / overcast outdoor light / mixed ceiling light and window light / classroom fluorescent light], with slightly uneven brightness, minor highlight clipping, and a small realistic color-temperature mismatch. No cinematic setup, rim light, golden-hour glamour, studio key light, or polished portrait lighting. Use plausible smartphone depth of field with recognizable background objects, not exaggerated creamy bokeh.

Keep the person clearly [beautiful / handsome / attractive] while retaining restrained, localized human skin evidence: fine pores mainly around the nose and inner cheeks, mild tone variation, soft under-eye color variation, natural lip texture, and [one age-appropriate detail: one or two tiny blemishes / faint expression lines / mild nasolabial folds / natural wrinkles and pigmentation]. Skin detail changes with the light and is distributed anatomically rather than uniformly. Include slight attractive facial asymmetry. The person remains healthy, clean, and appealing; do not turn realism into roughness, illness, premature aging, or ugliness.

They wear a [plain solid cotton top / simple shirt / denim jacket / practical work garment] with stable readable collar, shoulder, cuff, and seam construction. Use only a few broad folds caused by gravity and pose, with no logos, text, lace, plaid, or tiny complex patterns. If hands are visible, give them one simple relaxed action with naturally separated fingers and consistent anatomy. Build the hair from readable larger locks plus a few independent flyaway strands, not a mass of random lines.

The setting is [ordinary bedroom / dorm room / classroom / street / small shop / office / rural home], containing [three or four specific everyday objects] with consistent scale and geometry. It shows mild evidence of use without becoming indiscriminate clutter. Preserve slight phone compression, moderate digital sharpening, and extremely mild motion softness, with consistent detail across face, hair, clothing, and background. The result should feel like a normal phone photo with no beauty filter, face smoothing, airbrushing, or professional retouching.

Avoid: influencer portrait styling, commercial beauty photography, studio photography, cinematic color grading, golden-hour glamour, dramatic sunbeams, excessive background blur, perfectly centered composition, perfect symmetry, doll-like face, poreless skin, plastic or waxy skin, beauty filters, face reshaping, excessive sharpening, uniformly enlarged pores, sandpaper skin, severe acne or wrinkles unless age-appropriate, sick or dirty appearance, glassy eyes, chaotic hair lines, melting collars, warped seams, random fabric texture, illegible text or logos, deformed fingers, incoherent room geometry, 3D render, digital painting, and an obvious AI-generated look.
\`\`\`

## Compact correction prompt

Use this when editing an otherwise successful image:

\`\`\`text
保留人物的身份、颜值、五官、表情、姿势和整体构图不变，只降低照片的AI感。把光线调整为普通手机自动曝光下的真实生活光；保留鼻翼与内侧脸颊的细小局部毛孔、轻微肤色变化和自然嘴唇纹理，但不要增加痘痘、深皱纹、病态、疲惫或粗糙感。让头发由清晰发束和少量独立碎发组成。把衣服修正为结构稳定的简单纯色布料，衣领、袖口和缝线清楚，褶皱只跟随姿势和重力，不出现随机纹理、乱码图案或融化边缘。背景保留可辨认的普通生活物件和合理空间关系。整体像未经美颜和精修的现代手机随手拍，同时继续保持人物好看。
\`\`\`

## 附录：references/realism-logic.md

# Realism Logic and Corrections

## Core principle

Photographic realism does not come from adding more defects. It comes from agreement among five systems:

1. The person has a specific, attractive, age-appropriate identity.
2. Skin details follow anatomy and light.
3. The camera introduces small, plausible limitations.
4. Clothing, hair, hands, and the room remain structurally coherent.
5. The moment looks incidental rather than art-directed.

Correct the system causing the artificial look instead of making the subject generally uglier.

## Age calibration

### Children

Use clean family-photo, school-photo, or documentary language. Preserve soft natural skin with minor tone variation only. Do not request visible pores, wrinkles, glamour, beauty posing, adult makeup, sensuality, or body emphasis.

### Late teens and young adults

Use subtle pores around the nose and cheeks, mild tone variation, faint under-eye color, natural lip lines, one or two tiny blemishes, and slight facial asymmetry. Keep lines and folds minimal unless expression creates them.

### Adults in their 30s and 40s

Use visible but fine pores, gentle eye-corner lines, faint forehead lines, mild nasolabial folds, under-eye texture, and small pigmentation variation. Keep the face healthy and attractive.

### Adults in their 50s and 60s

Use natural crow’s-feet, forehead and mouth lines, mild skin laxity, pigmentation, and realistic neck or hand texture. Preserve lively eyes, facial dignity, grooming, and recognizable beauty.

### Elderly adults

Use layered wrinkles of different depth, age spots, sun exposure, thinner lips, gray hair variation, and weathered hands. Keep details anatomical and uneven; avoid horror-like exaggeration, uniform cracked texture, or a lifeless expression.

## Observable realism cues

### Skin

Good cues:

- pores concentrated around the nose and inner cheeks
- slight color difference between forehead, cheeks, nose, and under-eyes
- tiny highlights interrupted by pores and peach fuzz
- natural lower-eyelid folds and lip lines
- subtle left-right asymmetry

Bad cues:

- equally large pores everywhere
- repeated dots or noise masquerading as skin texture
- sharp pores on a softly focused phone photo
- every possible blemish included at once
- face detail that is much sharper than hair and clothing

### Smartphone capture

Good cues:

- ordinary 1x-lens perspective
- autofocus prioritizing the nearest eye or central face
- moderate sharpening and compression
- slight highlight clipping near a window
- mixed color temperature from daylight and room lighting
- a small framing error or casual crop

Bad cues:

- perfect studio exposure on every surface
- deep cinematic shadows with a glowing rim light
- full-frame-camera bokeh claimed as a normal phone snapshot
- an intentionally terrible angle that damages attractiveness
- heavy fake noise pasted uniformly over the image

### Clothing

Good cues:

- one plain fabric type
- stable collar, shoulder, cuff, and seam geometry
- a few broad folds caused by gravity and pose
- similar sharpness to adjacent hair and skin

Bad cues:

- random high-frequency woven patterns
- melting necklines or sleeves
- changing fabric type across the garment
- illegible logos and decorative text
- too many tiny folds unrelated to body movement

### Environment

Good cues:

- three or four recognizable objects with consistent scale
- mild asymmetry and evidence of recent use
- believable wall, floor, furniture, and window geometry
- background detail consistent with phone focus

Bad cues:

- generic luxury-bedroom staging
- atmospheric blur hiding all objects
- impossible furniture joins or repeated objects
- indiscriminate clutter that becomes texture soup

## Correction map

| Failure | Likely cause | Prompt correction |
| --- | --- | --- |
| Beautiful but looks like a web portrait | Glamour light, perfect composition, strong bokeh | Replace with ordinary mixed room light, auto exposure, 1x phone lens, casual crop, recognizable room objects |
| Realistic but unattractive | Too many flaws, harsh light, tired/sick wording | Restore attractive facial structure and healthy expression; keep only two subtle skin cues |
| Plastic skin | Poreless beauty prior or conflicting smooth/real terms | Request localized pores, tone variation, natural lip lines, no face smoothing |
| Sandpaper skin | Excessive pore and bump language | Remove \`raw\`, \`rough\`, \`every pore\`, and \`harsh revealing light\`; request restrained local microtexture |
| AI-looking eyes | Perfect symmetry, glassy highlights, over-sharp irises | Request relaxed gaze, slight eyelid asymmetry, ordinary catchlights, natural moist eyes |
| Hair becomes a painted mass | Too much decorative hair detail | Request defined larger locks plus a few independent flyaways |
| Clothes become chaotic | Complex patterns and excessive textile detail | Use a plain solid cotton top, stable collar and seams, broad pose-driven folds, no text or logos |
| Hands deform | Complex hand-face-hair interaction | Give one simple action, keep fingers separated and partly visible, or crop hands out |
| Room looks generated | Vague “beautiful bedroom” language | Name a plain wardrobe, charger, cup, rumpled sheet, neutral wall, and realistic geometry |
| Looks overly noisy | \`low-end phone\`, strong grain, many artifact terms | Use modern phone with mild compression and restrained luminance noise |
| Close-up looks like macro beauty advertising | Perfect center framing and clinical detail | Add slight off-center crop, ordinary phone distance, mild focus falloff, non-commercial room light |

## Iteration rule

Change one subsystem per retry:

1. First correct identity and attractiveness.
2. Then correct light and camera behavior.
3. Then adjust skin intensity.
4. Then correct clothing, hands, or environment.

Do not rewrite every attribute after one bad result. Preserve what already works.`,
};
