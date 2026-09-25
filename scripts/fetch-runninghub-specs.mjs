#!/usr/bin/env node
/**
 * 从 RunningHub 官方 API 文档站抓取**权威**接口定义。
 *
 * 为什么需要它
 * ------------
 * 官方 CLI 内置的 `catalog/data/capabilities.json` 是**打包时的静态快照**, 实测落后
 * 近 4 个月(2026-06-02), Seedance 2.5 这类新模型根本查不到。而官网文档站是实时更新的,
 * 且每页内嵌了完整的接口定义(Remix 的 devalue stream payload)。
 *
 * 于是: 端点是否有效、参数叫什么、枚举有哪些 —— 一律以**文档站**为准。
 *
 * 用法
 * ----
 *   node scripts/fetch-runninghub-specs.mjs list [关键字]      # 列出全部端点(可按关键字过滤)
 *   node scripts/fetch-runninghub-specs.mjs spec <endpoint>    # 输出某端点的权威参数表
 *   node scripts/fetch-runninghub-specs.mjs spec --doc <id>    # 直接按文档 id
 *   node scripts/fetch-runninghub-specs.mjs check              # 校验 runningHubProtocol.ts 里的端点是否都存在
 *
 * 实现要点
 * --------
 * 文档页把数据放在 <script>window.__remixContext.streamController.enqueue("<JSON>")</script>,
 * 可能是多段。每段 JSON 解码后按顺序拼接, 得到 devalue 扁平数组:
 *   [ {"_1": 2, ...}, "loaderData", {...}, ... ]
 * 对象里 "_<n>" 形式的键是**字符串引用**(键名本身也在数组里), 值是数组索引; 负数是指针哨兵。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DOC_ORIGIN = 'https://www.runninghub.cn';
const DOC_BASE = `${DOC_ORIGIN}/runninghub-api-doc-cn`;
/** 任意一个文档页都带完整侧边栏, 用它拿全端点索引。 */
const INDEX_DOC_ID = '498749507';

// ---------------------------------------------------------------------------
// devalue payload 解析
// ---------------------------------------------------------------------------

/** 负数哨兵 → JS 值。 */
function sentinel(index) {
  switch (index) {
    case -1:
    case -7:
      return undefined;
    case -2:
      return true;
    case -3:
      return false;
    case -4:
      return null;
    case -6:
      return NaN;
    default:
      return undefined;
  }
}

/** 从 HTML 里取出拼接好的 devalue 扁平数组文本。 */
export function extractPayloadText(html) {
  const re = /streamController\.enqueue\("((?:[^"\\]|\\.)*)"\)/g;
  const chunks = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    chunks.push(JSON.parse(`"${match[1]}"`));
  }
  if (chunks.length === 0) {
    throw new Error('页面里没有找到 streamController.enqueue 载荷(文档站结构可能变了)');
  }
  return chunks.join('');
}

/** 把 devalue 扁平数组还原成普通 JS 值。 */
export function resolvePayload(payloadText) {
  const data = JSON.parse(payloadText);

  const walk = (value, seen) => {
    if (typeof value === 'number' && Number.isInteger(value)) {
      return at(value, seen);
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, seen));
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        let realKey = key;
        const ref = /^_(\d+)$/.exec(key);
        if (ref) {
          const resolved = at(Number(ref[1]), seen);
          if (typeof resolved === 'string') realKey = resolved;
        }
        out[realKey] = walk(item, seen);
      }
      return out;
    }
    return value;
  };

  const at = (index, seen) => {
    if (index < 0) return sentinel(index);
    if (index >= data.length) return undefined;
    if (seen.has(index)) return undefined;
    return walk(data[index], new Set([...seen, index]));
  };

  return walk(data[0], new Set([0]));
}

// ---------------------------------------------------------------------------
// 文档站访问
// ---------------------------------------------------------------------------

async function fetchDocHtml(docId) {
  const url = `${DOC_BASE}/api-${docId}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) {
    throw new Error(`抓取失败 ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

function docsState(html) {
  const root = resolvePayload(extractPayloadText(html));
  const state = root?.loaderData?.root?.docsDataState;
  if (!state) {
    throw new Error('文档页里没有 docsDataState(结构可能变了)');
  }
  return state;
}

/** 递归收集侧边栏里的所有端点节点。 */
function collectNodes(nodes, out = []) {
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    if (node && typeof node === 'object') {
      if (node.path && node.key) {
        out.push({
          docId: String(node.key).replace(/^apiDetail\./, ''),
          name: node.name ?? '',
          path: node.path,
          method: node.method ?? 'post',
          tags: node.tags ?? [],
        });
      }
      collectNodes(node.children, out);
    }
  }
  return out;
}

/** 取全端点索引(名字/路径/文档 id/分类)。 */
export async function fetchCatalog() {
  const state = docsState(await fetchDocHtml(INDEX_DOC_ID));
  return collectNodes(state.sidebarTree?.sidebarTreeList);
}

/** 取某个文档 id 的接口定义, 含权威参数表。 */
export async function fetchSpecByDocId(docId) {
  const state = docsState(await fetchDocHtml(docId));
  const resource = state.resourceData;
  const data = resource?.data;
  if (!data) {
    throw new Error(`文档 ${docId} 没有 resourceData.data`);
  }
  const schema = data.requestBody?.jsonSchema ?? {};
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};
  const parameters = Object.entries(properties).map(([key, spec]) => {
    const items = spec?.items;
    return {
      key,
      type: spec?.type ?? 'unknown',
      required: required.has(key),
      description: spec?.description ?? '',
      enum: spec?.enum,
      default: spec?.default,
      // 数组型参数: 元素类型 / 元素枚举 / 数量上限
      itemType: items?.type,
      itemEnum: items?.enum,
      maxItems: items?.maxItems ?? spec?.maxItems,
      minItems: items?.minItems ?? spec?.minItems,
    };
  });
  return {
    docId: String(docId),
    name: data.name,
    method: (data.method ?? 'post').toUpperCase(),
    path: data.path,
    description: data.description ?? '',
    required: [...required],
    parameters,
    /** 官方给的示例请求体(字符串形式)。 */
    sample: data.requestBody?.data,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 从 runningHubProtocol.ts 里抠出端点 ID 清单(避免 import TS 依赖)。 */
function readLocalEndpoints() {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../src/commands/runningHubProtocol.ts');
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/endpoint:\s*'([^']+)'/g)].map((m) => m[1]);
}

function printSpec(spec) {
  const lines = [];
  lines.push(`# ${spec.name}`);
  lines.push(`${spec.method} ${spec.path}   (文档 id ${spec.docId})`);
  if (spec.description) lines.push(spec.description);
  lines.push('');
  lines.push(`必填: ${spec.required.join(', ') || '(无)'}`);
  lines.push('');
  lines.push('参数:');
  for (const parameter of spec.parameters) {
    const flags = [];
    if (parameter.required) flags.push('必填');
    if (parameter.enum) flags.push(`枚举=${JSON.stringify(parameter.enum)}`);
    if (parameter.itemType) flags.push(`元素=${parameter.itemType}`);
    if (parameter.itemEnum) flags.push(`元素枚举=${JSON.stringify(parameter.itemEnum)}`);
    if (parameter.maxItems !== undefined) flags.push(`上限=${parameter.maxItems}`);
    if (parameter.default !== undefined && parameter.default !== null) {
      const text = JSON.stringify(parameter.default);
      flags.push(`默认=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
    }
    lines.push(`  ${parameter.key.padEnd(24)} ${String(parameter.type).padEnd(9)} ${flags.join(' ')}`);
    if (parameter.description) {
      lines.push(`      ${parameter.description.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'list') {
    const keyword = rest[0]?.toLowerCase();
    const catalog = await fetchCatalog();
    const hits = keyword
      ? catalog.filter((item) =>
          `${item.path} ${item.name} ${item.tags.join(' ')}`.toLowerCase().includes(keyword))
      : catalog;
    console.log(`共 ${catalog.length} 个端点${keyword ? `, 匹配 "${keyword}" 的 ${hits.length} 个` : ''}:`);
    for (const item of hits) {
      console.log(`  ${item.path}\n      ${item.name}  [${item.tags.join(' / ')}]  (doc ${item.docId})`);
    }
    return;
  }

  if (command === 'spec') {
    let docId = rest[0];
    if (docId === '--doc') {
      docId = rest[1];
    } else if (docId && !/^\d+$/.test(docId)) {
      // 按端点路径找文档 id
      const catalog = await fetchCatalog();
      const hit = catalog.find((item) => item.path === docId);
      if (!hit) {
        console.error(`目录里没有端点 ${docId}; 用 list 命令查全量端点`);
        process.exitCode = 1;
        return;
      }
      docId = hit.docId;
    }
    if (!docId) {
      console.error('用法: spec <endpoint 路径 | --doc <文档 id>>');
      process.exitCode = 1;
      return;
    }
    console.log(printSpec(await fetchSpecByDocId(docId)));
    return;
  }

  if (command === 'check') {
    const local = readLocalEndpoints();
    const catalog = await fetchCatalog();
    const known = new Set(catalog.map((item) => item.path));
    const missing = local.filter((endpoint) => !known.has(`/openapi/v2/${endpoint}`));
    console.log(`本地端点 ${local.length} 个, 文档站 ${catalog.length} 个`);
    if (missing.length === 0) {
      console.log('全部命中文档站 ✓');
    } else {
      console.log(`未在文档站找到 ${missing.length} 个:`);
      for (const endpoint of missing) console.log(`  - ${endpoint}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log(`用法:
  node scripts/fetch-runninghub-specs.mjs list [关键字]      列出文档站全部端点
  node scripts/fetch-runninghub-specs.mjs spec <端点路径>    输出该端点的权威参数表
  node scripts/fetch-runninghub-specs.mjs spec --doc <id>    按文档 id 取参数表
  node scripts/fetch-runninghub-specs.mjs check              校验本地端点是否都还在文档站`);
}

// 仅在直接执行时跑 CLI(被 import 时不跑)。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`出错: ${error.message}`);
    process.exitCode = 1;
  });
}
