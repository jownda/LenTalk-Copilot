#!/usr/bin/env node
/**
 * 零风险核验 RunningHub 视频端点是否仍然有效。
 *
 * **为什么需要这个脚本**
 * RunningHub 没有 OpenAI 兼容的模型列表接口(`GET /v1/models` 回 401 空体), 模型
 * 清单只存在于官方 CLI 打包的 `catalog/data/capabilities.json` —— 那是一份**静态
 * 快照**(`version` 字段标着生成日期), 且 `rh model list` 只读本地文件、**没有在线
 * 刷新**(CLI 源码里不存在目录下载 URL)。LenTalk 从这份快照里挑了一批端点写在
 * `src/commands/runningHubProtocol.ts`。
 *
 * 后果有两层, 方向相反:
 *   1. 快照会**缺**新模型 —— 2026-06 的快照里就没有 Seedance 2.5, 得按官网文档手写;
 *   2. 快照里的端点**可能被平台改名/下架** —— 手写与快照都可能过期。
 * 这个脚本解决第 2 层。
 *
 * **探测原理**
 * 向端点发**空 body** `{}`。参数校验必然失败(prompt 通常是必填), 平台回
 * `errorCode 1007 + "field 'prompt' is required"` —— 此时**不会创建任务、不会计费**。
 * 若端点路径已失效则回 `errorCode 1001 Invalid URL`。两者可明确区分。
 *
 * 顺带还能核对字段名: 错误消息里的 `field 'xxx' is required` 直接告诉你该端点
 * 第一个必填参数的平台键名(如 `firstImageUrl` / `imageUrl` / `resolution`)。
 *
 * **用法**
 *   node scripts/check-runninghub-endpoints.mjs
 *   RUNNINGHUB_API_KEY=sk-xxx node scripts/check-runninghub-endpoints.mjs
 *   node scripts/check-runninghub-endpoints.mjs --site ai     # 改用国际站
 *
 * Key 解析顺序: 环境变量 `RUNNINGHUB_API_KEY` → 官方 CLI 配置(`rh auth set-key` 写的
 * `%APPDATA%/rh/config.toml` 或 `~/.config/rh/config.toml`)。**Key 不会被打印。**
 *
 * 退出码: 0 = 全部有效; 1 = 存在失效端点或探测失败。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PROTOCOL_FILE = path.join(REPO_ROOT, 'src', 'commands', 'runningHubProtocol.ts');
const REQUEST_TIMEOUT_MS = 30_000;

/** 端点存在、只是参数没给全 —— 这是「健康」的信号。 */
const OK_CODES = new Set(['1007']);
/** 端点路径不存在 —— 快照过期, 需要更新 `runningHubProtocol.ts`。 */
const DEAD_CODES = new Set(['1001']);

async function resolveApiKey() {
  const fromEnv = (process.env.RUNNINGHUB_API_KEY ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'RUNNINGHUB_API_KEY 环境变量' };

  const configDir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'rh')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'rh');
  try {
    const body = await readFile(path.join(configDir, 'config.toml'), 'utf8');
    const matched = /api_key\s*=\s*"([^"]+)"/.exec(body);
    if (matched?.[1]?.trim()) return { key: matched[1].trim(), source: configDir };
  } catch {
    // 没有 CLI 配置就走下面的报错分支。
  }
  return null;
}

async function extractEndpoints() {
  const source = await readFile(PROTOCOL_FILE, 'utf8');
  const ids = [...source.matchAll(/endpoint:\s*'([^']+)'/g)].map((match) => match[1]);
  return [...new Set(ids)].sort();
}

async function probe(site, endpoint, apiKey) {
  const url = `https://${site}/openapi/v2/${endpoint}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    return {
      code: String(payload.errorCode ?? (response.ok ? '?' : `HTTP${response.status}`)),
      message: String(payload.errorMessage ?? '').trim(),
    };
  } catch (error) {
    return { code: 'NETWORK', message: String(error?.message ?? error).slice(0, 90) };
  }
}

const siteFlag = process.argv.indexOf('--site');
const site = siteFlag === -1 ? 'www.runninghub.cn' : `www.runninghub.${process.argv[siteFlag + 1]}`;

const resolved = await resolveApiKey();
if (!resolved) {
  console.error(
    '未找到 API Key。请先 `rh auth set-key <KEY>`，或设置环境变量 RUNNINGHUB_API_KEY。',
  );
  process.exit(1);
}

const endpoints = await extractEndpoints();
console.log(`站点: ${site}`);
console.log(`Key 来源: ${resolved.source}`);
console.log(`待核验端点: ${endpoints.length} 个（空 body 探测，不会创建任务、不会扣费）\n`);

const dead = [];
const unknown = [];
for (const endpoint of endpoints) {
  const { code, message } = await probe(site, endpoint, resolved.key);
  const tag = OK_CODES.has(code) ? 'ok  ' : DEAD_CODES.has(code) ? 'DEAD' : '????';
  console.log(`${tag} | ${code.padEnd(7)} | ${endpoint.padEnd(52)} | ${message.slice(0, 60)}`);
  if (DEAD_CODES.has(code)) dead.push(endpoint);
  else if (!OK_CODES.has(code)) unknown.push({ endpoint, code, message });
}

console.log('');
if (dead.length === 0 && unknown.length === 0) {
  console.log(`全部 ${endpoints.length} 个端点有效（均为「参数不全」而非「路径无效」）。`);
  process.exit(0);
}
if (dead.length > 0) {
  console.error(`以下 ${dead.length} 个端点已失效，请从 runningHubProtocol.ts 与`);
  console.error('recommendedApis.ts 的 RUNNINGHUB_VIDEO_MODELS 中移除或更正：');
  for (const endpoint of dead) console.error(`  ✗ ${endpoint}`);
}
if (unknown.length > 0) {
  console.error(`\n以下 ${unknown.length} 个端点返回了非预期错误码，需人工确认：`);
  for (const item of unknown) console.error(`  ? ${item.endpoint} -> ${item.code} ${item.message}`);
}
process.exit(1);
