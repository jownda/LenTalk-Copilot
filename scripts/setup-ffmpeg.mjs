/**
 * 还原随包 ffmpeg。
 *
 * 背景:视频超分的 VFR→CFR 归一化依赖 src-tauri/resources/bin/ffmpeg.exe(约 79MB)。
 * 它既不能直接入库(GitHub 的 git 数据接口对单次请求体有上限, 79MB 必然失败),
 * 也不适合留在仓库里让每次 clone 都背上这份体积, 因此改为:
 *   压缩包 ffmpeg.tar.gz 放在 `bundled-tools` Release 资产上, 构建前还原到 resources/bin/。
 *   下载走国内可直连的 GitHub 加速镜像(见 ARCHIVE_URLS), 官方源仅作兜底 —— 国内
 *   直连 github.com 会被重置, 不能要求构建机挂代理。
 * 解压结果与原始二进制 SHA256 一致(04e13079… ad00)。
 *
 * 用法:npm run setup:ffmpeg   (npm run tauri 会通过 pretauri 自动先执行)
 *
 * 为什么不调用系统 tar:
 *   Git Bash 的 GNU tar 会把 `C:/Users/...` 当成远程主机路径(报 "Cannot connect to C"),
 *   Windows 自带 bsdtar 又不认 GNU 的 --force-local。为避免平台差异, 这里用 Node 自行
 *   解 gzip + 解析 tar 头, 零外部命令依赖。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * 候选下载地址, 按序尝试。官方 GitHub 在国内直连会被重置(所以才需要代理),
 * 因此把国内可直连的 GitHub 加速镜像排在前面, 官方地址只作兜底。镜像只是反向
 * 代理, 回的仍是同一份 Release 资产, 所以下面同一个 SHA256 仍然成立。
 * 这些都是免费公开服务, 存活情况会变; 任意一个可用即可。
 */
const ARCHIVE_URLS = [
  // 首选: 实测国内直连最快(约 7-11 MB/s)
  'https://gh-proxy.com/https://github.com/jownda/LenTalk-Copilot/releases/download/bundled-tools/ffmpeg.tar.gz',
  // 备用一: 实测约 1-3 MB/s, 偶发短暂不可用
  'https://ghfast.top/https://github.com/jownda/LenTalk-Copilot/releases/download/bundled-tools/ffmpeg.tar.gz',
  // 备用二: 速度较慢, 仅在前两者都不可用时才会走到
  'https://ghproxy.net/https://github.com/jownda/LenTalk-Copilot/releases/download/bundled-tools/ffmpeg.tar.gz',
  // 兜底: 官方源, 已配置代理的环境从这里成功
  'https://github.com/jownda/LenTalk-Copilot/releases/download/bundled-tools/ffmpeg.tar.gz',
];

/** 单个候选地址的下载总时限。失效镜像不能把构建无限挂住。 */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** 期望的产物 SHA256, 用于解压后自检(与原二进制一致) */
const EXPECTED_SHA256 = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localArchive = resolve(projectRoot, 'src-tauri/resources/ffmpeg.tar.gz');
const outputDir = resolve(projectRoot, 'src-tauri/resources/bin');
const binaryPath = resolve(outputDir, 'ffmpeg.exe');

function fail(message) {
  console.error(`[setup:ffmpeg] ${message}`);
  process.exit(1);
}

/**
 * 从 tar 归档中取出第一个普通文件。
 * 只处理自家生成的包(单个文件、无长文件名/稀疏等扩展), 因此手写解析足够。
 */
function extractFirstRegularFile(tarBuffer) {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    // 全零块表示归档结束
    let allZero = true;
    for (const byte of header) {
      if (byte !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;

    // '0'/'\0' = 普通文件; 'x'/'L'/'g' 等扩展头直接跳过
    if (typeFlag === '0' || typeFlag === '\0') {
      return { name, content: tarBuffer.subarray(dataStart, dataStart + size) };
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

if (existsSync(binaryPath)) {
  console.log('[setup:ffmpeg] 已存在,跳过:', binaryPath);
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

let gzBuffer;
let cleanupPath = null;

if (existsSync(localArchive)) {
  console.log('[setup:ffmpeg] 使用本地压缩包:', localArchive);
  gzBuffer = readFileSync(localArchive);
} else {
  console.log('[setup:ffmpeg] 本地无压缩包,按序尝试镜像…');
  const errors = [];
  for (const url of ARCHIVE_URLS) {
    console.log(`[setup:ffmpeg] ${url}`);
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        errors.push(`${url} -> HTTP ${response.status} ${response.statusText}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        errors.push(`${url} -> 响应为空`);
        continue;
      }
      gzBuffer = buffer;
      console.log(`[setup:ffmpeg] 已下载 ${(buffer.length / 1048576).toFixed(1)} MB`);
      break;
    } catch (error) {
      errors.push(`${url} -> ${error?.message ?? error}`);
    }
  }
  if (!gzBuffer) {
    for (const detail of errors) {
      console.error(`[setup:ffmpeg]   ${detail}`);
    }
    fail(`所有下载地址均失败, 可手动把 ffmpeg.tar.gz 放到 ${localArchive} 后重试`);
  }
  cleanupPath = join(tmpdir(), `lentalk-ffmpeg-${process.pid}.tar.gz`);
  writeFileSync(cleanupPath, gzBuffer);
}

try {
  const entry = extractFirstRegularFile(gunzipSync(gzBuffer));
  if (!entry) {
    fail('压缩包内未找到常规文件');
  }
  writeFileSync(binaryPath, entry.content);
  console.log(`[setup:ffmpeg] 已写出 ${entry.name} (${entry.content.length} B)`);
} catch (error) {
  fail(`解压失败: ${error?.message ?? error}`);
} finally {
  if (cleanupPath) {
    rmSync(cleanupPath, { force: true });
  }
}

// 自检:确认还原出的二进制与原始一致
const digest = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
if (digest !== EXPECTED_SHA256) {
  fail(`校验失败,期望 ${EXPECTED_SHA256} 实际 ${digest}`);
}

console.log('[setup:ffmpeg] 校验通过,已还原:', binaryPath);
