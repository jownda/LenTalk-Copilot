import type { PromptOptimizerTaskType } from './canvasNodes';

export interface ReversePromptContext {
  taskType: PromptOptimizerTaskType;
  purpose: string;
  imageCount: number;
  lang: 'zh' | 'en';
}

const TASK_LABEL_ZH: Record<string, string> = {
  auto: '自动判断',
  character: '人物',
  location: '地点/环境',
  prop: '道具',
  edit: '编辑',
  texture: '纹理修复',
  viewChange: '机位反转',
};

const TASK_LABEL_EN: Record<string, string> = {
  auto: 'auto-detect',
  character: 'character',
  location: 'location / environment',
  prop: 'prop',
  edit: 'edit',
  texture: 'texture repair',
  viewChange: 'view change',
};

export function reversePromptSystemPrompt(lang: 'zh' | 'en'): string {
  const text = lang === 'zh'
    ? [
        '你是 LIRA 提示词反推器。你会收到一张或多张参考图片，任务是从图片反推出可直接用于图片生成的结构化提示词。',
        '',
        '规则：',
        '- 仔细观察图片中的主体，把观察到的具体外观直接写进提示词，不要使用“待补充”“某某”等占位符。',
        '- 人物：同一人物跨画面保持一致；完整写出性别、年龄、发型发色、五官、服装、表情、姿态。',
        '- 角色设定图：三格布局（左正面全身、中背面全身、右大幅特写），纯中性灰背景；两张全身照从颈部以下取景，头部与脸部只出现在四分之三侧面特写中；无影棚、无设备、无墙壁、无轮廓光；双手空置，不持道具。',
        '- 地点/环境：明确空间纵深、建筑与自然元素、静谧氛围。',
        '- 道具/产品：三视图或俯拍、材质与磨损状态、无品牌空白表面。',
        '- 编辑/机位反转：保留原有身份、服装、构图、光线与调色，只改指定内容。',
        '- 使用电影级摄影词汇，如 ARRI Alexa、ARRI/Cooke 镜头、soft falloff、cinematic grading。',
        '- 构图清晰：景别、机位、主体、背景、光线方向与阴影。',
        '要求：只输出最终提示词文本，不要解释、不要 Markdown 代码块、不要前后缀；严格遵循用户消息指定的输出语言，不得切换。',
      ]
    : [
        'You are a LIRA prompt reverse-engineer. You receive one or more reference images and must turn them into a structured image-generation prompt.',
        '',
        'Rules:',
        '- Observe the subject carefully and write the concrete appearance directly into the prompt. Do not use placeholders such as "TBD" or "someone".',
        '- Character: keep the same person consistent across panels; fully describe gender, age, hairstyle and hair color, facial features, clothing, expression, and posture.',
        '- Character sheet: three panels (front full-body left, back full-body middle, large close-up right) on a solid neutral grey background; both full-body panels are framed from the neck down, the head and face appear only in the three-quarter close-up; no studio, no equipment, no walls, no rim light; hands empty, no props.',
        '- Location/environment: make spatial depth, architecture and natural elements, and a quiet atmosphere explicit.',
        '- Prop/product: three-view or overhead shot, material and wear, blank unbranded surface.',
        '- Edit/view change: keep the original identity, clothing, framing, lighting and grading; change only what is requested.',
        '- Use cinematic cinematography vocabulary such as ARRI Alexa, ARRI/Cooke lenses, soft falloff, cinematic grading.',
        '- Keep the composition clear: shot size, camera position, subject, background, light direction and shadows.',
        'Output only the final prompt text, no explanation, no Markdown code block, no prefix or suffix. Follow the output language requested in the user message exactly.',
      ];

  return text.join('\n');
}

export function reversePromptUserMessage(context: ReversePromptContext): string {
  const task = context.lang === 'zh'
    ? TASK_LABEL_ZH[context.taskType]
    : TASK_LABEL_EN[context.taskType];

  const lines: string[] = [];

  if (context.lang === 'zh') {
    lines.push('请根据我提供的参考图片反推提示词。');
    lines.push('');
    lines.push(`任务类型：${task}`);
    lines.push('输出语言：中文');
    lines.push(`参考图片数量：${context.imageCount}`);
    if (context.purpose.trim()) {
      lines.push(`补充意图：${context.purpose.trim()}`);
    }
    lines.push('');
    lines.push('请把图片中的主体外观直接写入提示词描述，不要使用占位符；最终只输出结构化提示词文本。');
  } else {
    lines.push('Reverse-engineer a prompt from the reference images I provided.');
    lines.push('');
    lines.push(`Task type: ${task}`);
    lines.push('Output language: English');
    lines.push(`Reference image count: ${context.imageCount}`);
    if (context.purpose.trim()) {
      lines.push(`Additional intent: ${context.purpose.trim()}`);
    }
    lines.push('');
    lines.push('Write the observed subject appearance directly into the prompt, with no placeholder; output only the final structured prompt text.');
  }

  return lines.join('\n');
}

export interface ReversePromptCombineContext {
  draft: string;
  taskType: PromptOptimizerTaskType;
  imageCount: number;
  lang: 'zh' | 'en';
}

export function reversePromptCombineUserMessage(context: ReversePromptCombineContext): string {
  const task = context.lang === 'zh'
    ? TASK_LABEL_ZH[context.taskType]
    : TASK_LABEL_EN[context.taskType];

  if (context.lang === 'zh') {
    return [
      '请结合参考图片反推主体外观，并把它与我的草稿合并成一段完整、可直接用于图片生成的最终提示词。',
      '',
      '要求：',
      '- 保留草稿中已有的“@图N”引用标记不变；',
      '- 把图片中观察到的具体外观直接写入提示词；',
      '- 草稿中明确写的要求优先保留。',
      '',
      `任务类型：${task}`,
      '输出语言：中文',
      `参考图片数量：${context.imageCount}`,
      '',
      `草稿：\n${context.draft.trim()}`,
    ].join('\n');
  }

  return [
    'Combine the appearance reversed from the reference images with my draft into a complete image-generation prompt.',
    '',
    'Requirements:',
    '- Keep any existing "@图N" reference markers in the draft unchanged;',
    '- Write the appearance observed in the images directly into the prompt;',
    '- Preserve explicit requests from my draft.',
    '',
    `Task type: ${task}`,
    'Output language: English',
    `Reference image count: ${context.imageCount}`,
    '',
    `Draft:\n${context.draft.trim()}`,
  ].join('\n');
}