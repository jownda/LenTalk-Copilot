import { describe, expect, it } from 'vitest';

import {
  buildRunningHubWorkflowNodeInfoList,
  extractRunningHubWorkflowId,
  extractRunningHubWorkflowJson,
  parseRunningHubWorkflow,
} from './runningHubWorkflow';

/** 一份最小但完整的 API 格式工作流: 文本 + 种子 + 参考图 + 保存图片。 */
const IMAGE_WORKFLOW = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 123456, steps: 20, cfg: 7.5, model: ['4', 0], positive: ['6', 0], negative: ['7', 0] },
    _meta: { title: 'KSampler' },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a woman walking on the beach, golden hour, cinematic', clip: ['4', 1] },
    _meta: { title: '正向提示词' },
  },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality', clip: ['4', 1] } },
  '8': {
    class_type: 'LoadImage',
    inputs: { image: 'example.png', upload: 'image' },
    _meta: { title: '角色参考图' },
  },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['3', 0] } },
});

describe('解析 ComfyUI 工作流（API 格式）', () => {
  it('跳过连线型输入，只留下真正可填的字段', () => {
    const schema = parseRunningHubWorkflow(IMAGE_WORKFLOW);
    const keys = schema.fields.map((field) => field.key);
    // model / positive / negative / clip / images 都是连线，不能出现在表单里。
    expect(keys).not.toContain('3.model');
    expect(keys).not.toContain('3.positive');
    expect(keys).not.toContain('6.clip');
    expect(keys).not.toContain('9.images');
    expect(keys).toContain('3.seed');
    expect(keys).toContain('6.text');
  });

  it('按字段语义分配控件，并按 nodeId 数值顺序排列', () => {
    const schema = parseRunningHubWorkflow(IMAGE_WORKFLOW);
    const byKey = new Map(schema.fields.map((field) => [field.key, field]));
    expect(byKey.get('3.seed')?.control).toBe('seed');
    expect(byKey.get('3.steps')?.control).toBe('number');
    expect(byKey.get('3.cfg')?.control).toBe('number');
    expect(byKey.get('6.text')?.control).toBe('textarea');
    expect(byKey.get('8.image')?.control).toBe('image');
    // 采样器名是字符串枚举，做成折叠的 text —— 拿不到完整选项时给下拉只会误导。
    expect(byKey.get('3.seed')?.nodeLabel).toBe('KSampler');
    expect(byKey.get('6.text')?.nodeLabel).toBe('正向提示词');
    expect(schema.fields[0]?.nodeId).toBe('3');
  });

  it('关键参数（文本/素材/种子）默认展开，步数这类收进高级', () => {
    const schema = parseRunningHubWorkflow(IMAGE_WORKFLOW);
    const byKey = new Map(schema.fields.map((field) => [field.key, field]));
    expect(byKey.get('6.text')?.primary).toBe(true);
    expect(byKey.get('8.image')?.primary).toBe(true);
    expect(byKey.get('3.seed')?.primary).toBe(true);
    expect(byKey.get('3.steps')?.primary).toBe(false);
    expect(byKey.get('5.width')?.primary).toBe(false);
  });

  it('推断输出类型：图片 / 视频 / 音频各有对应保存节点', () => {
    expect(parseRunningHubWorkflow(IMAGE_WORKFLOW).outputKind).toBe('image');

    const video = parseRunningHubWorkflow(
      JSON.stringify({
        '1': { class_type: 'VHS_LoadVideo', inputs: { video: 'in.mp4' } },
        '2': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 30 } },
      }),
    );
    expect(video.outputKind).toBe('video');
    expect(video.fields.find((field) => field.key === '1.video')?.control).toBe('video');

    const audio = parseRunningHubWorkflow(
      JSON.stringify({ '1': { class_type: 'SaveAudio', inputs: { filename_prefix: 'out' } } }),
    );
    expect(audio.outputKind).toBe('audio');
  });

  it('短视频优先：同时存在图片与视频输出时按视频处理', () => {
    const schema = parseRunningHubWorkflow(
      JSON.stringify({
        '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'a' } },
        '2': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 24 } },
      }),
    );
    expect(schema.outputKind).toBe('video');
  });

  it('解开 __value__ 包装值', () => {
    const schema = parseRunningHubWorkflow(
      JSON.stringify({
        '6': {
          class_type: 'CLIPTextEncode',
          inputs: { text: 'hello', speak_and_recognation: { __value__: [false, true] } },
        },
      }),
    );
    const wrapped = schema.fields.find((field) => field.key === '6.speak_and_recognation');
    // 包装里是两个值，不是单值 —— 无法用单行输入表达，跳过；但不能因此丢掉 text。
    expect(wrapped).toBeUndefined();
    expect(schema.fields.find((field) => field.key === '6.text')?.control).toBe('textarea');
  });

  it('没有保存节点时给告警并回落到图片', () => {
    const schema = parseRunningHubWorkflow(
      JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } }),
    );
    expect(schema.outputKind).toBe('image');
    expect(schema.warnings.join()).toContain('保存类节点');
  });
});

describe('解析失败时给出可操作的提示', () => {
  it('UI 格式（nodes 数组）要明确指引去导 API 格式', () => {
    expect(() => parseRunningHubWorkflow(JSON.stringify({ nodes: [{ id: 1, type: 'KSampler' }], links: [] }))).toThrow(
      /API/,
    );
  });

  it('非 JSON / 空内容 / 无可填字段 都要报错', () => {
    expect(() => parseRunningHubWorkflow('not json')).toThrow('不是合法的 JSON');
    expect(() => parseRunningHubWorkflow('   ')).toThrow('请先粘贴');
    expect(() => parseRunningHubWorkflow(JSON.stringify({ '1': { class_type: 'X', inputs: { a: ['2', 0] } } }))).toThrow(
      '没有找到可填参数',
    );
  });
});

describe('组装 nodeInfoList', () => {
  it('全部字段都提交（覆盖式 API，不依赖平台模板默认值）', () => {
    const schema = parseRunningHubWorkflow(IMAGE_WORKFLOW);
    const list = buildRunningHubWorkflowNodeInfoList(schema.fields, {});
    expect(list).toHaveLength(schema.fields.length);
    expect(list.find((item) => item.nodeId === '3' && item.fieldName === 'seed')?.fieldValue).toBe('123456');
  });

  it('用户填过的值覆盖默认值，素材字段带 mediaKind 标记', () => {
    const schema = parseRunningHubWorkflow(IMAGE_WORKFLOW);
    const list = buildRunningHubWorkflowNodeInfoList(schema.fields, {
      '6.text': '换成夜晚的沙滩',
      '8.image': 'asset://localhost/local.png',
    });
    const text = list.find((item) => item.fieldName === 'text' && item.nodeId === '6');
    const image = list.find((item) => item.nodeId === '8' && item.fieldName === 'image');
    expect(text?.fieldValue).toBe('换成夜晚的沙滩');
    expect(image?.mediaKind).toBe('image');
    expect(text?.mediaKind).toBeUndefined();
  });
});

describe('从链接里取工作流 ID', () => {
  it('纯 ID / 工作流链接 / 带查询串的链接都认', () => {
    expect(extractRunningHubWorkflowId('1904136902449209346')).toBe('1904136902449209346');
    expect(extractRunningHubWorkflowId('https://www.runninghub.cn/workflow/1904136902449209346')).toBe(
      '1904136902449209346',
    );
    expect(extractRunningHubWorkflowId('https://www.runninghub.cn/workflow/1993964922465878017?from=share')).toBe(
      '1993964922465878017',
    );
    expect(extractRunningHubWorkflowId('   ')).toBe('');
    expect(extractRunningHubWorkflowId('没有数字')).toBe('');
  });
});

describe('解析「拉取工作流」接口的返回', () => {
  const graph = { '3': { class_type: 'KSampler', inputs: { seed: 1 } } };

  it('图在 data.prompt 里且被序列化成字符串（网关最常见的形态）', () => {
    const json = extractRunningHubWorkflowJson({ code: 0, data: { prompt: JSON.stringify(graph) } });
    expect(JSON.parse(json)).toEqual(graph);
  });

  it('图直接在 data 上', () => {
    const json = extractRunningHubWorkflowJson({ code: 0, data: graph });
    expect(JSON.parse(json)).toEqual(graph);
  });

  it('图在顶层（没有 data 包装）', () => {
    expect(JSON.parse(extractRunningHubWorkflowJson(graph))).toEqual(graph);
  });

  it('拿不到任何图时把响应开头带进报错，方便排查', () => {
    expect(() => extractRunningHubWorkflowJson({ code: 0, data: { foo: 'bar' } })).toThrow(/没有返回可解析/);
  });
});
