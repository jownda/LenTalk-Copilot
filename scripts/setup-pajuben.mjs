/**
 * 还原「扒剧本」引擎的随包运行时。
 *
 * 背景:
 *   内置的扒剧本要在没装过 Python 的机器上开箱可用, 因此随包一份嵌入式
 *   CPython 3.12.8 + 人物识别依赖(numpy / opencv-headless / Pillow),
 *   外加 YuNet / SFace 两个 ONNX 模型, 合计约 250MB。
 *   它既超出 GitHub git 数据接口的单次请求体上限, 也不该让每次 clone 都背上
 *   这份体积, 因此这些产物不入库, 改为构建前用本脚本从公开源还原
 *   (与 scripts/setup-ffmpeg.mjs 同一套路)。
 *
 * 用法:npm run setup:pajuben    (npm run tauri 会通过 pretauri 自动先执行)
 *
 * 离线复用:
 *   把下列文件放进 .build-tmp/pajuben-cache/ (文件名须完全一致)即可跳过下载。
 *     python-3.12.8-embed-amd64.zip
 *     numpy-2.0.2-cp312-cp312-win_amd64.whl
 *     pillow-11.3.0-cp312-cp312-win_amd64.whl
 *     opencv_python_headless-4.12.0.88-cp37-abi3-win_amd64.whl
 *     face_detection_yunet_2023mar.onnx
 *     face_recognition_sface_2021dec.onnx
 *
 * 前置:
 *   构建机需有 Python 3, 仅用于解压 zip(GitHub windows-latest 与开发机均自带)。
 *   不自己写 zip 解析的原因:Git Bash 的 GNU tar 不认 `C:/` 路径, 而 zip 的
 *   中央目录 / data descriptor 细节容易写错, 直接用标准库 zipfile 最稳。
 *
 * 关于 licenses/:
 *   face_runtime/licenses/ 属于分发 ONNX 模型的合规要求, 已入库, 本脚本只校验存在。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(projectRoot, 'src-tauri/resources/pajuben');
const runtimeDir = join(engineDir, 'runtime');
const sitePackagesDir = join(runtimeDir, 'Lib', 'site-packages');
const modelsDir = join(engineDir, 'face_runtime', 'models');
const licensesDir = join(engineDir, 'face_runtime', 'licenses');
const cacheDir = resolve(projectRoot, '.build-tmp/pajuben-cache');

const PTH_FILENAME = 'python312._pth';
const PTH_CONTENT = [
  'python312.zip',
  '.',
  'Lib\\site-packages',
  '',
  '# Uncomment to run site.main() automatically',
  'import site',
  '',
].join('\n');

/** 嵌入式 CPython:优先国内镜像, 其后官方源;两者内容一致, 用同一个 SHA256 校验。 */
const PYTHON_EMBED = {
  filename: 'python-3.12.8-embed-amd64.zip',
  urls: [
    'https://registry.npmmirror.com/-/binary/python/3.12.8/python-3.12.8-embed-amd64.zip',
    'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip',
  ],
  sha256: '8d3f33be9eb810f23c102f08475af2854e50484b8e4e06275e937be61ce3d2fb',
};

/**
 * 人物识别依赖。版本刻意对齐原软件随包的组合(opencv 4.12.0.88 + numpy 2.0.2):
 * cv2 5.x 改过 FaceDetectorYN.create 的签名, 不能升。
 * 下载地址从 PyPI JSON 接口现取(文件名里带哈希目录, 无法硬编码),
 * 取回的 sha256 会与本表交叉校验。
 */
const WHEELS = [
  {
    project: 'numpy',
    version: '2.0.2',
    filename: 'numpy-2.0.2-cp312-cp312-win_amd64.whl',
    marker: join(sitePackagesDir, 'numpy', '__init__.py'),
    sha256: 'cfd41e13fdc257aa5778496b8caa5e856dc4896d4ccf01841daee1d96465467a',
  },
  {
    project: 'pillow',
    version: '11.3.0',
    filename: 'pillow-11.3.0-cp312-cp312-win_amd64.whl',
    marker: join(sitePackagesDir, 'PIL', '__init__.py'),
    sha256: 'a6444696fce635783440b7f7a9fc24b3ad10a9ea3f0ab66c5905be1c19ccf17d',
  },
  {
    project: 'opencv-python-headless',
    version: '4.12.0.88',
    filename: 'opencv_python_headless-4.12.0.88-cp37-abi3-win_amd64.whl',
    marker: join(sitePackagesDir, 'cv2', '__init__.py'),
    sha256: '86b413bdd6c6bf497832e346cd5371995de148e579b9774f8eba686dee3f5528',
  },
];

/** YuNet 检脸 + SFace 识别模型(OpenCV Zoo)。 */
const MODELS = [
  {
    filename: 'face_detection_yunet_2023mar.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  },
  {
    filename: 'face_recognition_sface_2021dec.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
  },
];

const LICENSE_FILES = ['YuNet-LICENSE', 'SFace-LICENSE'];

let failed = false;

function fail(message) {
  console.error(`[setup:pajuben] ${message}`);
  failed = true;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** 找一个可用的 Python 3(GitHub windows-latest 为 `python`, 部分环境只有 `py -3`)。 */
function findPython() {
  const candidates = [
    { command: 'python', prefix: [] },
    { command: 'python3', prefix: [] },
    { command: 'py', prefix: ['-3'] },
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate.command,
      [...candidate.prefix, '-c', 'import sys;print(sys.version_info[0])'],
      { encoding: 'utf8' },
    );
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === '3') {
      return candidate;
    }
  }
  return null;
}

function extractZip(python, archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync(
    python.command,
    [...python.prefix, '-m', 'zipfile', '-e', archivePath, destDir],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    fail(`解压失败: ${archivePath}`);
    return false;
  }
  return true;
}

/** 缓存优先, 否则按序尝试多个 URL;返回校验通过的 Buffer。 */
async function acquire(filename, urls, expectedSha256) {
  const cached = join(cacheDir, filename);
  if (existsSync(cached)) {
    const buffer = readFileSync(cached);
    if (sha256(buffer) === expectedSha256) {
      console.log(`[setup:pajuben] 命中缓存 ${filename} (${mb(buffer.length)})`);
      return buffer;
    }
    console.warn(`[setup:pajuben] 缓存校验失败, 改为下载: ${filename}`);
  }

  const errors = [];
  for (const url of urls) {
    console.log(`[setup:pajuben] 下载 ${filename}`);
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        errors.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const digest = sha256(buffer);
      if (digest !== expectedSha256) {
        errors.push(`${url} -> SHA256 不符(期望 ${expectedSha256} 实际 ${digest})`);
        continue;
      }
      console.log(`[setup:pajuben]   完成 ${mb(buffer.length)}`);
      return buffer;
    } catch (error) {
      errors.push(`${url} -> ${error?.message ?? error}`);
    }
  }
  for (const detail of errors) {
    console.error(`[setup:pajuben]   ${detail}`);
  }
  fail(`无法获取 ${filename}(可手动放进 .build-tmp/pajuben-cache/ 后重试)`);
  return null;
}

/** 从 PyPI JSON 接口取 wheel 的最终下载地址。 */
async function resolveWheelUrl(project, version, filename) {
  const response = await fetch(`https://pypi.org/pypi/${project}/${version}/json`, {
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  const wanted = filename.toLowerCase();
  const entry = (payload.urls ?? []).find(
    (item) => String(item.filename).toLowerCase() === wanted,
  );
  if (!entry) {
    throw new Error(`PyPI 上找不到 ${filename}`);
  }
  return entry.url;
}

async function main() {
  // 随包运行时目前只有 Windows 一套(嵌入式 python.exe + win_amd64 wheel)。
  // macOS 走系统 python3:引擎本体是纯 stdlib, 人物识别缺依赖时探测会自动降级。
  if (process.platform !== 'win32') {
    console.log(`[setup:pajuben] ${process.platform} 不随包运行时, 跳过`);
    return;
  }

  const python = findPython();
  if (!python) {
    fail('构建机缺少 Python 3(仅用于解压 zip, 请安装后重试)');
    return;
  }
  console.log(`[setup:pajuben] 使用解释器 ${python.command} ${python.prefix.join(' ')}`.trim());

  // 1) 嵌入式解释器
  if (existsSync(join(runtimeDir, 'python.exe'))) {
    console.log('[setup:pajuben] 嵌入式解释器已存在, 跳过');
  } else {
    const buffer = await acquire(PYTHON_EMBED.filename, PYTHON_EMBED.urls, PYTHON_EMBED.sha256);
    if (!buffer) return;
    const archivePath = join(cacheDir, PYTHON_EMBED.filename);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(archivePath, buffer);
    if (!extractZip(python, archivePath, runtimeDir)) return;
    console.log('[setup:pajuben] 嵌入式解释器已解压到 runtime/');
  }

  // 2) 打开 site, 并把 Lib/site-packages 纳入搜索路径
  //    (嵌入式发行版默认 `import site` 被注释掉, 不改这份 ._pth 装不进依赖)
  writeFileSync(join(runtimeDir, PTH_FILENAME), PTH_CONTENT, 'utf8');

  // 3) 人物识别依赖
  for (const wheel of WHEELS) {
    if (existsSync(wheel.marker)) {
      console.log(`[setup:pajuben] ${wheel.project} 已存在, 跳过`);
      continue;
    }
    let url;
    try {
      url = await resolveWheelUrl(wheel.project, wheel.version, wheel.filename);
    } catch (error) {
      fail(`查询 ${wheel.filename} 下载地址失败: ${error?.message ?? error}`);
      return;
    }
    const buffer = await acquire(wheel.filename, [url], wheel.sha256);
    if (!buffer) return;
    const archivePath = join(cacheDir, wheel.filename);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(archivePath, buffer);
    // wheel 内部没有 `.data/` 目录, 直接解到 site-packages 即为正确布局
    if (!extractZip(python, archivePath, sitePackagesDir)) return;
    console.log(`[setup:pajuben] ${wheel.project} 已安装`);
  }

  // 4) 人脸模型
  for (const model of MODELS) {
    const target = join(modelsDir, model.filename);
    if (existsSync(target)) {
      console.log(`[setup:pajuben] ${model.filename} 已存在, 跳过`);
      continue;
    }
    const buffer = await acquire(model.filename, [model.url], model.sha256);
    if (!buffer) return;
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(target, buffer);
    console.log(`[setup:pajuben] ${model.filename} 已写入`);
  }

  // 5) 许可证(入库文件, 此处只确认没被误删)
  for (const name of LICENSE_FILES) {
    if (!existsSync(join(licensesDir, name))) {
      fail(`缺少许可证文件 face_runtime/licenses/${name}(应随仓库入库)`);
    }
  }
  if (failed) return;

  // 6) 端到端自检:用还原出来的解释器做与运行时探针完全一致的检查
  const selfCheck = spawnSync(
    join(runtimeDir, 'python.exe'),
    [
      '-X',
      'utf8',
      '-c',
      "import cv2, numpy, PIL\n" +
        "assert hasattr(cv2, 'FaceDetectorYN') and hasattr(cv2, 'FaceRecognizerSF'), 'OpenCV 版本过低'\n" +
        "print('FACE_OK', __import__('sys').version.split()[0], cv2.__version__, numpy.__version__, PIL.__version__)",
    ],
    { encoding: 'utf8' },
  );
  if (selfCheck.status !== 0 || !selfCheck.stdout.includes('FACE_OK')) {
    fail(`自检失败: ${(selfCheck.stderr || selfCheck.stdout || '').trim()}`);
    return;
  }
  console.log(`[setup:pajuben] 自检通过 ${selfCheck.stdout.replace('FACE_OK', '').trim()}`);
  console.log('[setup:pajuben] 运行时已就绪:', runtimeDir);
}

await main();
if (failed) {
  process.exit(1);
}
