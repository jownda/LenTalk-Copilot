/**
 * 用真实 Chrome 加载扩展，端到端验证：
 *   1. service worker 能正常启动，顶层代码完整执行
 *   2. contextMenus 权限生效、菜单项真的被创建
 *   3. 后台消息通道可用（popup 不会卡在"正在扫描页面…"）
 *   4. popup 页面无 JS 报错
 *   5. **在真实页面 DOM 上跑 scanPageMedia，真能扫到图片**
 *   6. **预览播放：点缩略图能放，防盗链资源能自动回落到"页面身份取字节"**
 *   7. **blob: 找回：MSE 播放器的真地址能从页面时间线里捞出来（右键保存 HLS 靠它）**
 *
 * 为什么需要它：mock 出来的 chrome 环境**测不出真实环境的差异**。
 * 实测真实 Chrome 里 `chrome.contextMenus.onShown` 就是 undefined，
 * 而 mock 里给它造了一个，于是"这行抛错会拖垮整个后台"这个致命 bug 完全测不出来。
 * 预览同理：直链带不带 Referer、`<video>` 遇 403 会不会触发 error 事件、
 * 回落后的 blob 能不能解码，这些都只有真浏览器说了算。
 *
 * 依赖 playwright-core + 一个带完整扩展支持的 Chrome（headless shell 不支持扩展），
 * 以及 ffmpeg（现场生成一个 8 KB 的 VP8 视频当素材；没有就跳过预览用例）。
 * 可用环境变量覆盖：LENTALK_EXT_DIR / PLAYWRIGHT_CORE / CHROME_EXEC。
 *
 * 用法：node verify-in-chrome.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 从 playwright 的浏览器缓存里找一个能加载扩展的完整 Chrome。 */
function findChrome() {
  if (process.env.CHROME_EXEC) return process.env.CHROME_EXEC;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('chromium-')) continue;
    const root = join(cache, entry);
    for (const arch of readdirSync(root)) {
      const candidate = join(
        root,
        arch,
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing'
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** playwright-core 的入口文件。ESM 不认 NODE_PATH，只能按路径引。 */
function findPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    join(homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core', 'index.js'),
    join(HERE, 'node_modules', 'playwright-core', 'index.js'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const playwrightPath = findPlaywright();
const chromePath = findChrome();
if (!playwrightPath) {
  console.error('找不到 playwright-core，请设置 PLAYWRIGHT_CORE 指向其 index.js');
  process.exit(1);
}
if (!chromePath) {
  console.error('找不到可加载扩展的 Chrome，请设置 CHROME_EXEC 指向可执行文件');
  process.exit(1);
}

// playwright-core 是 CJS，ESM 下要取 default 再解构。
const { chromium } = (await import(playwrightPath)).default;

const EXT = process.env.LENTALK_EXT_DIR || HERE;
const EXEC = chromePath;

const pass = [];
const fail = [];
const check = (label, ok, detail = '') => (ok ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ''}`);

/** 从源码里按大括号配对抠出一个具名函数，好在页面里原样跑一遍。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到函数 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号不配对`);
}

// 用一个带真实尺寸图片的页面测扫描：128/48 应留下，16 应被过滤掉。
// 另外刻意放了一些「只有网络记录里有、DOM 里没有」的素材，用来验证 performance 那一路。
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>扫描测试页</title>
<meta property="og:image" content="/icons/icon48.png">
</head><body>
<img src="/icons/icon128.png" alt="大图">
<img src="/icons/icon16.png" alt="太小的图标">
<video src="/clip.webm" poster="/icons/icon128.png"></video>
<audio src="/tone.webm"></audio>
<a href="/icons/icon48.png">直链图片</a>
<a href="/hls/index.m3u8">播放列表</a>
<!-- MSE 播放器带封面：HLS 卡片没有自己的封面，缩略图就是从它身上借的 -->
<video id="mse" poster="/icons/icon128.png"></video>
<script>
  // 只在网络层出现、DOM 里读不到的素材：播放器 fetch 回来再喂给 MSE 播放时就是这样。
  // 扩展拿不到 webRequest 权限，但页面自己的 performance 时间线里记着这些地址。
  fetch('/dynamic/clip.mp4').catch(function () {});
  var hero = new Image();
  hero.src = '/naked/hero-image';

  // MSE 播放器的真实样子：字节 fetch 回来喂给 <video>，DOM 上只剩一个 blob:。
  // 这正是"右键保存 HLS 提示取不到完整文件"的现场，真地址只能从时间线里捞。
  var mse = document.getElementById('mse');
  fetch('/clip.webm')
    .then(function (r) { return r.blob(); })
    .then(function (b) { mse.src = URL.createObjectURL(b); })
    .catch(function () {});
  // 播放器真正拉的是这份清单，DOM 里不会有它。
  fetch('/hls/index.m3u8').catch(function () {});
  // 单文件切片型清单（Pinterest 的形态）：整支视频编成一个文件，分片全靠 BYTERANGE
  // 区分。这条记录让扫描能识出它，用来验证「预览一直转圈」那个 bug。
  fetch('/hls-single/index.m3u8').catch(function () {});
</script>
</body></html>`;

const profile = mkdtempSync(join(tmpdir(), 'lentalk-ext-'));
const clips = mkdtempSync(join(tmpdir(), 'lentalk-clip-'));
let context = null;
let server = null;
/** HLS 流是否生成成功（缺 libx264/hls 封装器时不影响其它用例）。 */
let hlsReady = false;
/** 单文件切片型 HLS 是否生成成功（Pinterest 那种 BYTERANGE 形态）。 */
let singleReady = false;
/** /hls/ 的命中统计：用来证明分片确实是**页面身份**取回来的。 */
let hlsPageHits = 0;
let hlsBlocked = 0;
/** /hls-single/ 的命中统计：带 Range 的请求数 vs 整份拉走的次数。 */
let singleRangeHits = 0;
let singleFullHits = 0;
/** 每一次 /hls-single/ 请求的明细（文件名 + Range），出问题时能看清到底取了哪几段。 */
const singleRequests = [];

/**
 * 现场生成测试素材，不往扩展目录里塞任何二进制：
 *   - clip.webm：不到 10 KB 的 VP8 视频（Chromium 自带 VP8 解码，不依赖私有编解码器）
 *   - extra.png：约 200 KB 的图片，用来验证"只看网络记录"的那一路（有体积门槛）
 *   - index.m3u8 + segN.ts：真的 HLS 流（h264），用于验证 m3u8 能被 hls.js 播出来
 */
function makeFixtures() {
  try {
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=160x120:rate=10:duration=1',
        '-c:v', 'libvpx',
        '-pix_fmt', 'yuv420p',
        join(clips, 'clip.webm'),
      ],
      { stdio: 'ignore' }
    );
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=256x256',
        '-frames:v', '1',
        '-compression_level', '0',
        join(clips, 'extra.png'),
      ],
      { stdio: 'ignore' }
    );
  } catch {
    return false;
  }

  // HLS 单独做：它比上面两个多依赖 libx264 与 hls 封装器，生成失败不该把普通预览的用例一起废掉。
  try {
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=160x120:rate=10:duration=3',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '0',
        '-hls_segment_filename', join(clips, 'seg%d.ts'),
        join(clips, 'index.m3u8'),
      ],
      { stdio: 'ignore' }
    );
    hlsReady = existsSync(join(clips, 'index.m3u8'));
  } catch {
    hlsReady = false;
  }

  // 单文件切片型 HLS（Pinterest 的形态）：整支视频编成一个文件，清单里每段都用
  // `#EXT-X-BYTERANGE` 指向它的一段。这就是「预览一直转圈」的现场 —— loader 一旦
  // 丢掉 hls.js 给出的字节区间，就会去拉整份文件。
  try {
    mkdirSync(join(clips, 'single'), { recursive: true });
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=160x120:rate=10:duration=3',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'baseline',
        '-level', '3.0',
        // 每 10 帧（=1 秒）一个关键帧，切出来的分片才不止一个。
        '-g', '10',
        '-keyint_min', '10',
        '-sc_threshold', '0',
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '0',
        '-hls_segment_type', 'fmp4',
        '-hls_flags', 'single_file',
        '-hls_fmp4_init_filename', 'init.mp4',
        join(clips, 'single', 'index.m3u8'),
      ],
      { stdio: 'ignore' }
    );
    singleReady = existsSync(join(clips, 'single', 'index.m3u8'));
  } catch {
    singleReady = false;
  }
  return true;
}

const hasFixtures = makeFixtures();

function report() {
  console.log(`\n通过 ${pass.length} 项，失败 ${fail.length} 项`);
  pass.forEach((line) => console.log(`  ✓ ${line}`));
  fail.forEach((line) => console.log(`  ✗ ${line}`));
}

try {
  // 127.0.0.1 恰好是扩展唯一有 host 权限的域，不需要 activeTab 也能注入。
  server = createServer((request, response) => {
    if (request.url === '/hls.min.js') {
      // 对照实验用：把扩展里的 hls.js 原样递给页面，好在**页面身份**下试同一份流。
      try {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(readFileSync(join(HERE, 'vendor', 'hls.min.js')));
      } catch {
        response.writeHead(404);
        response.end('no hls.js');
      }
      return;
    }
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE_HTML);
      return;
    }
    if (request.url === '/clip.webm' || request.url === '/protected/clip.webm' || request.url === '/tone.webm') {
      // 防盗链演示：只认带 Referer 的请求。
      // popup 里的 <video> 直链播放带不了 Referer（referrerPolicy=no-referrer）→ 403；
      // 而注入到页面里取字节是**页面**发的请求，自带 Referer → 200。
      // 这正是这个扩展存在的理由，也是预览回落要验证的分支。
      const guarded = request.url === '/protected/clip.webm';
      if (guarded && !request.headers.referer) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      if (!hasFixtures) {
        response.writeHead(404);
        response.end('no clip');
        return;
      }
      response.writeHead(200, { 'content-type': 'video/webm' });
      response.end(readFileSync(join(clips, 'clip.webm')));
      return;
    }
    if (request.url === '/dynamic/clip.mp4' || request.url === '/naked/hero-image' || request.url === '/after-rescan.png') {
      // 这三个都**不在 DOM 里**（前两个由页面脚本 fetch/Image 加载，第三个重扫时才插进去），
      // 用来验证 performance 那一路在真实浏览器里确实拿得到。
      if (!hasFixtures) {
        response.writeHead(404);
        response.end('no fixture');
        return;
      }
      const isVideo = request.url === '/dynamic/clip.mp4';
      response.writeHead(200, { 'content-type': isVideo ? 'video/webm' : 'image/png' });
      response.end(readFileSync(join(clips, isVideo ? 'clip.webm' : 'extra.png')));
      return;
    }
    if (request.url.startsWith('/hls-single/')) {
      // 单文件切片型：整支视频一个文件，分片靠 Range 区分。这里刻意**支持 Range 并
      // 记账** —— 只断言「能播出来」分不清「按区间取」与「整份拉走」，而后者正是
      // 预览一直转圈的原因。
      const referer = String(request.headers.referer || '');
      if (!referer.includes('127.0.0.1') || referer.includes('chrome-extension')) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      const name = request.url.slice('/hls-single/'.length).split('?')[0];
      let file = null;
      try {
        file = readFileSync(join(clips, 'single', name));
      } catch {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      const rangeHeader = String(request.headers.range || '');
      singleRequests.push({ name, range: rangeHeader || '(无)', size: file.length });
      const match = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
      if (match) {
        singleRangeHits += 1;
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), file.length - 1);
        const slice = file.subarray(start, end + 1);
        response.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${file.length}`,
          'content-length': slice.length,
        });
        response.end(slice);
        return;
      }
      singleFullHits += 1;
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.end(file);
      return;
    }
    if (request.url.startsWith('/hls/')) {
      // 模拟站点对 HLS 的防盗链：只认**页面**发出的请求（Referer 带页面地址）。
      // popup 的源是 chrome-extension://，直取这里必然 403 ——
      // 所以这段流能播出来，只可能是因为清单与分片都是页面身份取回来的。
      const referer = String(request.headers.referer || '');
      if (!referer.includes('127.0.0.1') || referer.includes('chrome-extension')) {
        hlsBlocked += 1;
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      hlsPageHits += 1;
      const name = request.url.slice('/hls/'.length).split('?')[0];
      try {
        const file = readFileSync(join(clips, name));
        response.writeHead(200, {
          'content-type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        });
        response.end(file);
      } catch {
        response.writeHead(404);
        response.end('not found');
      }
      return;
    }
    try {
      const file = readFileSync(join(EXT, request.url.replace(/^\/+/, '')));
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(file);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pagePort = server.address().port;
  const pageUrl = `http://127.0.0.1:${pagePort}/`;

  context = await chromium.launchPersistentContext(profile, {
    executablePath: EXEC,
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
    ],
  });

  // 先把被测页面打开，好拿到它的 tabId。
  const target = await context.newPage();
  await target.goto(pageUrl, { waitUntil: 'load' });
  await target.waitForTimeout(300);

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  }
  check('service worker 已启动', Boolean(worker), worker ? worker.url() : '没等到 serviceworker 事件');

  if (!worker) {
    report();
    process.exitCode = 1;
  } else {
    const extensionId = new URL(worker.url()).host;
    const swErrors = [];
    worker.on('console', (message) => {
      if (message.type() === 'error') swErrors.push(message.text());
    });
    worker.on('close', () => swErrors.push('service worker 意外关闭'));

    const probe = await worker.evaluate(() => ({
      contextMenus: typeof chrome.contextMenus === 'object' && chrome.contextMenus !== null,
      action: typeof chrome.action === 'object' && chrome.action !== null,
      storage: typeof chrome.storage === 'object' && chrome.storage !== null,
      hasMessageListener:
        typeof chrome.runtime.onMessage.hasListeners === 'function'
          ? chrome.runtime.onMessage.hasListeners()
          : 'no-api',
      onShownOnThisChrome: typeof chrome.contextMenus.onShown,
    }));
    check('contextMenus 权限生效', probe.contextMenus);
    check('chrome.action 可用', probe.action);
    check('chrome.storage 可用', probe.storage);
    check('后台消息通道已注册（顶层代码完整执行）', probe.hasMessageListener === true, String(probe.hasMessageListener));
    console.log(`  本机 Chrome 的 contextMenus.onShown = ${probe.onShownOnThisChrome}`);

    const menus = await worker.evaluate(async () => {
      const created = [];
      const original = chrome.contextMenus.create;
      chrome.contextMenus.create = function (props, callback) {
        created.push({
          id: props.id,
          title: props.title,
          parentId: props.parentId,
          type: props.type,
          contexts: props.contexts,
        });
        return original.call(chrome.contextMenus, props, callback);
      };
      let error = null;
      try {
        await buildContextMenus({ force: true });
      } catch (thrown) {
        error = String(thrown && thrown.message ? thrown.message : thrown);
      }
      chrome.contextMenus.create = original;
      return { created, error };
    });
    check('菜单构建不抛错', menus.error === null, menus.error || '');
    check('菜单项已创建', menus.created.length > 0, `共 ${menus.created.length} 项`);
    check('有一键保存项', menus.created.some((item) => item.id === 'lentalk-save-quick'));
    check('有「不分类」项', menus.created.some((item) => item.parentId === 'lentalk-save-pick'));
    console.log('  菜单项：');
    menus.created
      .filter((item) => !item.parentId || item.id === 'lentalk-save-pick')
      .forEach((item) => console.log(`    ${item.id}  =  ${item.title ?? `[${item.type}]`}`));

    // popup 页面：打开看有没有 JS 报错、后台能不能应答
    const popupErrors = [];
    const popup = await context.newPage();
    popup.on('pageerror', (error) => popupErrors.push(`pageerror: ${error.message}`));
    popup.on('console', (message) => {
      if (message.type() === 'error') popupErrors.push(`console: ${message.text()}`);
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForTimeout(800);
    check('popup 页面无 JS 报错', popupErrors.length === 0, popupErrors.join(' | '));

    const reply = await popup.evaluate(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('__timeout__'), 45000);
          chrome.runtime.sendMessage({ type: 'lentalk:status' }, (response) => {
            clearTimeout(timer);
            resolve(response ?? null);
          });
        })
    );
    check('后台能响应状态查询（popup 不会卡住）', reply !== '__timeout__' && reply !== null, JSON.stringify(reply));

    // 真实 DOM 上跑扫描：这是"扫描不到图片"这个症状的直接验证。
    const scan = await popup.evaluate(
      async (url) => {
        const tabs = await chrome.tabs.query({});
        const mine = tabs.find((tab) => tab.url === url);
        if (!mine) return { error: `找不到标签页 ${url}` };
        const injections = await chrome.scripting.executeScript({
          target: { tabId: mine.id },
          func: scanPageMedia,
        });
        const items = injections && injections[0] ? injections[0].result : null;
        if (!Array.isArray(items)) return { error: '注入没有返回数组' };
        return {
          items: items.map((item) => ({
            url: item.url,
            mediaType: item.mediaType,
            hls: item.hls === true,
            poster: item.poster || '',
          })),
        };
      },
      pageUrl
    );

    check('真实页面扫描成功返回', !scan.error, scan.error || '');
    if (!scan.error) {
      const has = (suffix) => scan.items.some((item) => item.url.endsWith(suffix));
      console.log(`  扫到 ${scan.items.length} 项：`);
      scan.items.forEach((item) => console.log(`    [${item.mediaType}${item.hls ? ' · HLS' : ''}] ${item.url}`));

      check('扫到了 128px 的图', has('/icons/icon128.png'));
      check('扫到了 og:image 与直链', has('/icons/icon48.png'));
      check('16px 的小图标被过滤掉', !has('/icons/icon16.png'), scan.items.map((i) => i.url).join(' , '));
      check('扫到了页面里的视频', has('/clip.webm'));
      check('扫到了页面里的音频', has('/tone.webm'));
      // 下面三条是这次新增的"网络记录"那一路 —— 也正是别家扩展看得到、我们之前看不到的那类。
      check(
        '★ 只被 fetch 拉过、DOM 里没有的视频也扫到了',
        has('/dynamic/clip.mp4'),
        scan.items.map((i) => i.url).join(' , ')
      );
      check(
        '★ 没有扩展名的图片靠网络记录认出来',
        has('/naked/hero-image'),
        scan.items.map((i) => i.url).join(' , ')
      );
      check(
        '★ m3u8 被识别为视频并标上分片清单',
        scan.items.some((item) => item.url.endsWith('/hls/index.m3u8') && item.mediaType === 'video' && item.hls),
        JSON.stringify(scan.items.filter((item) => item.hls))
      );
      check(
        '检测到的分片清单都标成了 HLS（页面上两份：常规分片 + 单文件切片）',
        scan.items.filter((item) => item.hls).length === 2 &&
          scan.items.filter((item) => item.hls).every((item) => item.mediaType === 'video')
      );
      // 清单本身不可能带封面，卡片的缩略图只能从页面上那个 MSE 播放器的 poster 借 ——
      // 否则只有一个「HLS」字样，用户认不出是哪个视频。
      const hlsWithPoster = scan.items
        .filter((item) => item.hls)
        .map((item) => ({ url: item.url, poster: item.poster }));
      check(
        'HLS 卡片借到了页面播放器的封面（不再只有一个「HLS」字样）',
        hlsWithPoster.some((item) => item.url.includes('hls-single') && item.poster),
        JSON.stringify(hlsWithPoster)
      );
    }

    // ── 右键落在 blob: 上：从页面时间线里把真地址找回来 ────────────────
    // 用户实际报的问题：MSE 播放器的 <video> 的 src 是 blob:，右键保存只能得到
    // "临时播放流，拿不到完整文件"。真地址得从 performance 时间线里捞 ——
    // 这一步在真浏览器里跑一遍，才能证明时间线真的记得住那些地址。
    {
      const mse = await target.evaluate(() => {
        const video = document.getElementById('mse');
        return { src: video ? video.src : '', kind: video ? video.getAttribute('src').slice(0, 5) : '' };
      });
      check('测试页里确实有一个 MSE 式的 blob: 视频（DOM 问不到真地址）', mse.src.startsWith('blob:'), JSON.stringify(mse));

      const code = extractFunction(readFileSync(join(HERE, 'background.js'), 'utf8'), 'findPageStreamsInPage');
      // 注入函数必须完全自包含：这里用页面自己的上下文跑它的源码，等价于 executeScript。
      const found = await target.evaluate(`(${code})()`);
      check(
        '★ 真机上能从页面时间线里找回 HLS 清单（DOM 里只有 blob:）',
        Array.isArray(found.playlists) && found.playlists.some((url) => url.endsWith('/hls/index.m3u8')),
        JSON.stringify(found)
      );
      check('找回的结果里不含 blob:/data:', JSON.stringify(found).indexOf('blob:') < 0, JSON.stringify(found));
      check(
        '页面里那个真视频直链也是找回的候选',
        found.videos.concat(found.audios).some((url) => url.endsWith('/clip.webm')),
        JSON.stringify(found)
      );
    }

    // ── popup 交互：默认不勾选 / 筛选 / 重新扫描 / HLS 走应用侧 ffmpeg ──
    // 真 popup 是弹窗，测试里它自己就是"当前标签页"，init() 会去注入它自己
    // （扩展页面注不进去）。把 tabs.query 换成"永远返回被测页面"，
    // popup 就以为被测页面是当前标签页了 —— 这样测的才是真实的 init() 流程。
    await popup.evaluate((url) => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async () => {
        const tabs = await real({});
        return tabs.filter((tab) => tab.url === url);
      };
    }, pageUrl);

    await popup.evaluate(() => init());
    await popup.waitForTimeout(300);

    const initial = await popup.evaluate(() => ({
      items: state.items.length,
      selected: state.selected.size,
      checked: Array.from(document.querySelectorAll('.card input')).filter((input) => input.checked).length,
      summary: document.getElementById('summary').textContent,
      rescanLabel: document.getElementById('rescan').textContent,
      rescanDisabled: document.getElementById('rescan').disabled,
      chips: Array.from(document.querySelectorAll('.chip')).map((chip) => chip.textContent),
    }));
    check('默认一个都不勾选', initial.selected === 0 && initial.checked === 0, JSON.stringify(initial));
    check('扫完在页脚给出可见结果（不是静悄悄）', /扫到|没有找到/.test(initial.summary), initial.summary);
    check(
      '扫描按钮回到可用状态（不会卡在"扫描中…"）',
      initial.rescanLabel === '重新扫描' && initial.rescanDisabled === false,
      JSON.stringify(initial)
    );
    check('筛选按钮带各类数量', initial.chips.some((text) => /^视频 \d+$/.test(text)), initial.chips.join(' / '));

    const filters = await popup.evaluate(() => {
      const result = {};
      ['all', 'image', 'video', 'audio'].forEach((id) => {
        document.querySelector(`.chip[data-filter="${id}"]`).click();
        result[id] = {
          cards: document.querySelectorAll('.card').length,
          expected: state.items.filter((item) => id === 'all' || item.mediaType === id).length,
          active: document.querySelector('.chip.active').dataset.filter,
        };
      });
      return result;
    });
    ['all', 'image', 'video', 'audio'].forEach((id) => {
      check(
        `筛选「${id}」只显示该类型（${filters[id].cards}/${filters[id].expected}）`,
        filters[id].cards === filters[id].expected && filters[id].active === id && filters[id].expected > 0,
        JSON.stringify(filters[id])
      );
    });

    const hls = await popup.evaluate(() => {
      document.querySelector('.chip[data-filter="all"]').click();
      const card = Array.from(document.querySelectorAll('.card')).find((node) => node.title.includes('.m3u8'));
      if (!card) return { error: '网格里没有 m3u8 卡片' };
      const checkbox = card.querySelector('input');
      const disabled = checkbox.disabled;
      const label = card.querySelector('.meta .type').textContent;
      document.getElementById('select-all').click();
      return {
        label,
        disabled,
        pickedHls: Array.from(state.selected).some((url) => url.endsWith('.m3u8')),
        selected: state.selected.size,
        total: state.items.length,
      };
    });
    check('m3u8 卡片标成「HLS 流」', hls.label === 'HLS 流', JSON.stringify(hls));
    // HLS 现在也能入库了：交给应用侧的 ffmpeg 拉流合并，所以不再禁用勾选。
    check('m3u8 的勾选框可以勾选（交给应用侧 ffmpeg 拉流合并）', hls.disabled === false, JSON.stringify(hls));
    check('「全选」会把 m3u8 一起勾上', hls.pickedHls === true && hls.selected === hls.total, JSON.stringify(hls));

    // 重新扫描：往页面里插一张新图，再点按钮，看新图会不会出现。
    await target.evaluate(
      () =>
        new Promise((resolve) => {
          const image = document.createElement('img');
          image.onload = () => resolve(true);
          image.onerror = () => resolve(false);
          image.src = '/after-rescan.png';
          document.body.appendChild(image);
        })
    );
    const rescanned = await popup.evaluate(async () => {
      document.getElementById('rescan').click();
      const started = Date.now();
      while (Date.now() - started < 20000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (document.getElementById('rescan').textContent === '重新扫描') break;
      }
      return {
        button: document.getElementById('rescan').textContent,
        found: state.items.some((item) => item.url.endsWith('/after-rescan.png')),
        selected: state.selected.size,
      };
    });
    check('点「重新扫描」真的重扫了（新插进页面的图能扫到）', rescanned.found === true, JSON.stringify(rescanned));
    check('重扫结束后默认仍不勾选任何项', rescanned.selected === 0, JSON.stringify(rescanned));

    // ── 预览播放：真实点击 → 直链播 / 防盗链回落 ─────────────────────
    if (!hasFixtures) {
      check('生成测试素材（本机没找到 ffmpeg？）', false, '跳过预览用例');
    } else {
      const clipUrl = `http://127.0.0.1:${pagePort}/clip.webm`;
      const guardedUrl = `http://127.0.0.1:${pagePort}/protected/clip.webm`;

      const tabId = await popup.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const mine = tabs.find((tab) => tab.url === url);
        return mine ? mine.id : 0;
      }, pageUrl);

      /** 驱动一次真实打开，等媒体加载出元数据，再把现场读回来。 */
      const runPeek = async (assetUrl) =>
        popup.evaluate(
          async ([url, id]) => {
            state.tabId = id;
            openPeek({
              url,
              mediaType: 'video',
              name: 'clip',
              fileName: 'clip.webm',
              poster: '',
              width: 160,
              height: 120,
            });
            const video = document.querySelector('#peek-stage video');
            if (!video) return { error: '预览层里没有生成 video 元素' };
            const started = Date.now();
            while (video.readyState < 1 && Date.now() - started < 20000) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return {
              visible: !document.getElementById('peek').hidden,
              src: video.src,
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              errorCode: video.error ? video.error.code : 0,
              note: document.getElementById('peek-note').textContent,
            };
          },
          [assetUrl, tabId]
        );

      // (a) 点缩略图这条真实路径：缩略图得是按钮、能开预览、且不许连带勾选。
      const clicked = await popup.evaluate(
        (url) => {
          state.items = [
            {
              url,
              mediaType: 'video',
              name: 'clip',
              fileName: 'clip.webm',
              poster: '',
              width: 160,
              height: 120,
              extension: '',
            },
          ];
          state.selected = new Set();
          renderGrid();
          const thumb = document.querySelector('.card .thumb.playable');
          if (!thumb) return { error: '没有生成可播放的缩略图' };
          thumb.click();
          return {
            tag: thumb.tagName,
            hasGlyph: Boolean(thumb.querySelector('.thumb-play')),
            opened: !document.getElementById('peek').hidden,
            selected: state.selected.size,
            checkbox: document.querySelector('.card input').checked,
          };
        },
        clipUrl
      );
      check('视频缩略图渲染成按钮并带播放标记', clicked.tag === 'BUTTON' && clicked.hasGlyph === true, JSON.stringify(clicked));
      check('点缩略图真的打开预览层', clicked.opened === true, JSON.stringify(clicked));
      // 缩略图在 <label> 里，不拦住事件的话浏览器会把点击转给复选框。
      check(
        '点缩略图不会顺手反选勾选框',
        clicked.selected === 0 && clicked.checkbox === false,
        `selected=${clicked.selected} checkbox=${clicked.checkbox}`
      );

      // (b) 直链能播：不该触发任何回落。
      const direct = await runPeek(clipUrl);
      check('直链播放：视频元素出现且可见', direct.visible === true, JSON.stringify(direct));
      check('直链播放：确实解出了视频（不是只有个空框）', direct.readyState >= 1 && direct.videoWidth === 160, JSON.stringify(direct));
      check('直链播放：没有多余回落（src 仍是原地址）', direct.src === clipUrl, direct.src);
      check('直链播放：不弹解释性提示', direct.note === '', direct.note);

      // (c) 防盗链回落：直链 403 → 自动改用页面身份取字节。
      const guarded = await runPeek(guardedUrl);
      check('防盗链：回落后的 blob 真的解码出来了', guarded.readyState >= 1 && guarded.videoWidth === 160, JSON.stringify(guarded));
      check('防盗链：src 已换成页面身份取回的字节', String(guarded.src).startsWith('blob:'), guarded.src);
      check('防盗链：明确告诉用户为什么直链放不了', guarded.note.length > 0, guarded.note);
      if (guarded.note) console.log(`  预览回落提示：${guarded.note}`);

      // (c2) HLS：Chrome 的 <video> 原生不吃 m3u8，必须靠 hls.js 逐段取回。
      if (!hlsReady) {
        check('生成 HLS 测试流（本机 ffmpeg 缺 libx264 或 hls 封装器？）', false, '跳过 HLS 用例');
      } else {
        const hlsUrl = `http://127.0.0.1:${pagePort}/hls/index.m3u8`;
        const hitsBefore = hlsPageHits;

        // 先单独验一次取字节本身：把「取不到」和「取到了但 hls.js 用不了」分开。
        const probe = await popup.evaluate(
          async ([url, id]) => {
            try {
              const fetched = await hlsFetchBytes(url, id);
              return {
                bytes: fetched.bytes.byteLength,
                head: new TextDecoder().decode(fetched.bytes.slice(0, 32)),
              };
            } catch (error) {
              return { error: String((error && error.message) || error) };
            }
          },
          [hlsUrl, tabId]
        );
        check('HLS：清单能取回来', probe.bytes > 0 && probe.head.startsWith('#EXTM3U'), JSON.stringify(probe));

        const hls = await popup.evaluate(
          async ([url, id]) => {
            state.tabId = id;
            openPeek({
              url,
              mediaType: 'video',
              hls: true,
              name: 'hls',
              fileName: 'index.m3u8',
              extension: 'm3u8',
            });
            const video = document.querySelector('#peek-stage video');
            if (!video) return { error: '预览层里没有生成 video 元素' };
            // 把 hls.js 的所有错误（含非致命）都收下来 —— 只盯 fatal 会漏掉真正卡住的原因。
            const hlsErrors = [];
            if (peek.hls && window.Hls) {
              peek.hls.on(window.Hls.Events.ERROR, (_event, data) => {
                hlsErrors.push({ details: data.details, fatal: data.fatal === true, reason: data.reason || '' });
              });
            }
            const diag = {
              hlsVersion: window.Hls ? window.Hls.version : '',
              loaderIsCustom: Boolean(
                peek.hls && peek.hls.config && peek.hls.config.loader === PageChannelLoader
              ),
              loaderName: peek.hls && peek.hls.config && peek.hls.config.loader ? peek.hls.config.loader.name : '',
            };
            const started = Date.now();
            while (video.videoWidth === 0 && Date.now() - started < 15000) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            const segment = await hlsFetchBytes(url.replace('index.m3u8', 'seg0.ts'), id)
              .then((result) => result.bytes.byteLength)
              .catch((error) => `ERR ${(error && error.message) || error}`);
            return {
              src: video.src,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              currentTime: video.currentTime,
              readyState: video.readyState,
              buffered: video.buffered.length ? video.buffered.end(0) : 0,
              note: document.getElementById('peek-note').textContent,
              diag,
              hlsErrors,
              segBytes: segment,
              msState:
                peek.hls && peek.hls.mediaSource ? peek.hls.mediaSource.readyState : 'no-media-source',
              sourceBuffers:
                peek.hls && peek.hls.mediaSource ? peek.hls.mediaSource.sourceBuffers.length : -1,
            };
          },
          [hlsUrl, tabId]
        );

        check(
          'HLS：真的解出了画面（<video src=m3u8> 在 Chrome 里必然播不了）',
          hls.videoWidth === 160 && hls.videoHeight === 120,
          JSON.stringify(hls)
        );
        check('HLS：缓冲区里真的有数据（不只是解出元数据）', hls.readyState >= 2 && hls.buffered > 0, JSON.stringify(hls));
        check('HLS：没有把 m3u8 直接塞给 <video src>', !String(hls.src).endsWith('.m3u8'), `src=${hls.src}`);
        check('HLS：没有报错提示', hls.note === '', hls.note);
        check(
          'HLS：清单与分片确实走的是页面身份通道（带页面 Referer）',
          hlsPageHits > hitsBefore,
          `页面通道 ${hlsPageHits - hitsBefore} 次，被拒 ${hlsBlocked} 次`
        );
      }

      // (c3) 单文件切片型 HLS：整支视频一个文件、分片靠 BYTERANGE 区分（Pinterest 就是
      // 这种）。这条曾经一直转圈 —— loader 丢掉了 hls.js 给的字节区间，每次都去拉整份
      // 文件，撞上取字节上限。所以这里不仅看能不能播，还要看**是不是按区间取**。
      if (!singleReady) {
        check('生成单文件切片 HLS（BYTERANGE 形态）', false, '跳过单文件切片用例');
      } else {
        const singleUrl = `http://127.0.0.1:${pagePort}/hls-single/index.m3u8`;
        const rangeBefore = singleRangeHits;
        const fullBefore = singleFullHits;

        // 字节探针：按**清单声明的**区间取一段，看回来的到底是不是一个完整的 box。
        // 这一层排除「取字节通道本身把数据搞坏了」，剩下的才轮到 hls.js。
        const probeRange = await popup.evaluate(
          async ([base, id]) => {
            const read = async (start, end) => {
              const got = await hlsFetchBytes(base, id, { start, end });
              const bytes = got.bytes;
              const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
              return {
                asked: end - start + 1,
                got: bytes.byteLength,
                size: view.getUint32(0),
                box: new TextDecoder().decode(bytes.slice(4, 8)),
              };
            };
            return { init: await read(0, 806), first: await read(807, 6397) };
          },
          [`http://127.0.0.1:${pagePort}/hls-single/index.m4s`, tabId]
        );
        // ffmpeg 切出来的 fMP4 分片以 `sidx`（段索引）开头、`moof` 跟在后面，两者都是
        // 合法起点 —— 这里真正要盯的是**长度与清单声明一致**：多一个字节 MSE 就崩。
        check(
          '单文件切片 HLS：按清单区间取回的字节长度精确相符（差一个字节 MSE 就报错）',
          probeRange.init.box === 'ftyp' &&
            (probeRange.first.box === 'moof' || probeRange.first.box === 'sidx') &&
            probeRange.init.got === probeRange.init.asked &&
            probeRange.first.got === probeRange.first.asked,
          JSON.stringify(probeRange)
        );

        const single = await popup.evaluate(
          async ([url, id]) => {
            state.tabId = id;
            openPeek({
              url,
              mediaType: 'video',
              hls: true,
              name: 'single',
              fileName: 'index.m3u8',
              extension: 'm3u8',
            });
            const video = document.querySelector('#peek-stage video');
            if (!video) return { error: '预览层里没有生成 video 元素' };
            // 非致命错误也要收：append 失败常常先报 non-fatal，光看 fatal 会漏掉原因。
            const hlsErrors = [];
            const bufferEvents = [];
            if (peek.hls && window.Hls) {
              peek.hls.on(window.Hls.Events.ERROR, (_event, data) => {
                hlsErrors.push({
                  details: data.details,
                  fatal: data.fatal === true,
                  type: data.type,
                  reason: data.reason || '',
                  error: data.error ? String(data.error.message || data.error) : '',
                });
              });
              // SourceBuffer 何时建起来、每次 append 送进去多少字节 —— 卡在 append 时，
              // 这几个数字最能说明问题。
              peek.hls.on(window.Hls.Events.BUFFER_CREATED, (_event, data) => {
                bufferEvents.push({ ev: 'created', tracks: Object.keys((data && data.tracks) || {}) });
              });
              peek.hls.on(window.Hls.Events.BUFFER_APPENDING, (_event, data) => {
                bufferEvents.push({
                  ev: 'appending',
                  type: data && data.type,
                  bytes: data && data.data ? data.data.byteLength : -1,
                });
              });
              peek.hls.on(window.Hls.Events.BUFFER_APPENDED, (_event, data) => {
                bufferEvents.push({ ev: 'appended', type: data && data.type });
              });
            }
            const started = Date.now();
            while (video.videoWidth === 0 && Date.now() - started < 15000) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return {
              videoWidth: video.videoWidth,
              readyState: video.readyState,
              buffered: video.buffered.length ? video.buffered.end(0) : 0,
              note: document.getElementById('peek-note').textContent,
              hlsErrors,
              bufferEvents,
            };
          },
          [singleUrl, tabId]
        );

        check(
          '单文件切片 HLS：画面解得出来（这里以前一直转圈）',
          single.videoWidth === 160,
          JSON.stringify(single)
        );
        check(
          '单文件切片 HLS：分片按字节区间取（丢掉区间就会整份拉走 → 转圈）',
          singleRangeHits > rangeBefore,
          `带 Range ${singleRangeHits - rangeBefore} 次，不带 Range ${singleFullHits - fullBefore} 次`
        );
        check('单文件切片 HLS：没有报错提示', single.note === '', single.note);

        // 隔离实验：把同一份流交给**页面身份**下的 hls.js 自带 loader（新开一个同源页面，
        // 从扩展里把 hls.js 递过去）。页面与素材同源，既不受 CORS 也不受防盗链影响 ——
        // 它能播而我们的不能，问题就在取字节通道；它也播不了，就是这类流的封装问题。
        const barePage = await context.newPage();
        let bare = { error: '未执行' };
        try {
          await barePage.goto(pageUrl, { waitUntil: 'domcontentloaded' });
          await barePage.addScriptTag({ url: `http://127.0.0.1:${pagePort}/hls.min.js` });
          bare = await barePage.evaluate(async (url) => {
            const media = document.createElement('video');
            document.body.appendChild(media);
            const instance = new window.Hls({ enableWorker: false });
            const errors = [];
            instance.on(window.Hls.Events.ERROR, (_event, data) => {
              errors.push({
                details: data.details,
                fatal: data.fatal === true,
                error: data.error ? String(data.error.message || data.error) : '',
              });
            });
            instance.attachMedia(media);
            instance.loadSource(url);
            const started = Date.now();
            while (media.videoWidth === 0 && Date.now() - started < 12000) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            const result = { videoWidth: media.videoWidth, errors };
            try {
              instance.destroy();
            } catch {
              // 无所谓。
            }
            return result;
          }, singleUrl);
        } finally {
          await barePage.close();
        }
        check(
          '对照：页面身份下 hls.js 自带 loader 能放（放不了说明是流的封装问题）',
          bare.videoWidth === 160,
          JSON.stringify(bare)
        );
        console.log('  单文件切片的请求明细（对照实验之后，含两边）：');
        singleRequests.forEach((entry) => {
          console.log(`    ${entry.name}  Range=${entry.range}  文件 ${entry.size} 字节`);
        });
      }

      // (d) 关闭：媒体元素必须被摘掉（否则后台还在播、blob 也回收不掉）。
      const closed = await popup.evaluate(() => {
        document.getElementById('peek-close').click();
        return {
          hidden: document.getElementById('peek').hidden,
          children: document.getElementById('peek-stage').childElementCount,
        };
      });
      check('点「关闭」后预览层收起', closed.hidden === true, JSON.stringify(closed));
      check('关闭后媒体元素已移除（对象地址得已回收）', closed.children === 0, JSON.stringify(closed));

      const escaped = await popup.evaluate(async (missingUrl) => {
        // 用本机这个必然 404 的地址，别拿外部域名 —— 沙箱里 DNS 会挂在解析上。
        openPeek({ url: missingUrl, mediaType: 'video', name: 'missing', fileName: 'missing.mp4' });
        const opened = !document.getElementById('peek').hidden;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return { opened, hidden: document.getElementById('peek').hidden };
      }, `${clipUrl}?missing`);
      check('Esc 能关掉预览层', escaped.opened === true && escaped.hidden === true, JSON.stringify(escaped));
    }

    // ── 右键保存的真实闭环：saveFromContext → 应用 /hls → ffmpeg 拉流 → 素材落库 ──
    // 这一段以前没人测过：mock 只验「有没有发出请求」，真机只验「能不能扫到」，
    // 而「HLS 流还是存不了」恰好落在中间那段真实链路上。
    // 菜单点击本身没法自动化，所以直接在 service worker 里调 saveFromContext ——
    // 它下面跑的就是点击时一模一样的那条路。
    const saveTabId = await popup.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const mine = tabs.find((tab) => tab.url === url);
      return mine ? mine.id : 0;
    }, pageUrl);

    /** 跑一次右键保存，把角标/悬停提示捕下来 —— 那正是用户唯一能看到的反馈。 */
    const runContextSave = async (contextInfo) =>
      worker.evaluate(
        async ([info, tabInfo]) => {
          const titles = [];
          const originalTitle = chrome.action.setTitle;
          const originalBadge = chrome.action.setBadgeText;
          chrome.action.setTitle = function (props) {
            titles.push(String((props && props.title) || ''));
            return Promise.resolve();
          };
          chrome.action.setBadgeText = function (props) {
            titles.push(`badge:${(props && props.text) || ''}`);
            return Promise.resolve();
          };
          try {
            await saveFromContext(info, tabInfo, '');
          } catch (error) {
            titles.push(`throw:${(error && error.message) || error}`);
          } finally {
            chrome.action.setTitle = originalTitle;
            chrome.action.setBadgeText = originalBadge;
          }
          return {
            titles,
            outcome: titles.filter((line) => line.startsWith('LenTalk 素材捕手 — ')).pop() || '',
          };
        },
        [contextInfo, { id: saveTabId, url: pageUrl, title: '扫描测试页' }]
      );

    if (!hlsReady) {
      check('右键保存 HLS：生成测试流（本机 ffmpeg 缺 libx264？）', false, '跳过右键保存用例');
    } else {
      const hlsSaveUrl = `http://127.0.0.1:${pagePort}/hls/index.m3u8`;

      const savedHls = await runContextSave({
        mediaType: 'video',
        linkUrl: hlsSaveUrl,
        frameUrl: pageUrl,
        frameId: 0,
      });
      check('右键保存 HLS：最终反馈是「已入库」', savedHls.outcome.includes('已入库'), savedHls.titles.join(' | '));
      check('右键保存 HLS：提示里标了「HLS 流」', savedHls.outcome.includes('HLS 流'), savedHls.outcome);
      if (savedHls.outcome) console.log(`  右键保存 HLS 反馈：${savedHls.outcome}`);

      // blob: 那一路才是真实站点的现场 —— MSE 播放器，DOM 里只剩一个 blob:
      // 地址要从页面 performance 时间线里捞，再交给应用去拉。
      const savedBlob = await runContextSave({
        mediaType: 'video',
        srcUrl: 'blob:http://127.0.0.1:1/mse-placeholder',
        frameUrl: pageUrl,
        frameId: 0,
      });
      check(
        '右键保存 blob 视频：从页面时间线找回地址后也入库了',
        savedBlob.outcome.includes('已入库'),
        savedBlob.titles.join(' | ')
      );

      // 应用没开时不该静悄悄失败：提示里必须能看出是「应用没启动」。
      const offline = await worker.evaluate(async () => {
        const alive = await resolveBridge();
        return alive ? alive.port : 0;
      });
      console.log(`  当前探测到的应用端口：${offline || '没探测到'}`);
      check('扩展能探测到正在运行的应用（右键保存的前提）', offline > 0, String(offline));
    }

    check('service worker 无控制台报错', swErrors.length === 0, swErrors.join(' | '));
  }
} catch (error) {
  check('启动 Chrome 并加载扩展', false, String(error && error.message ? error.message : error));
} finally {
  // 顺序要紧：先关浏览器再关服务端。
  // 反过来的话，媒体元素可能还挂着 keep-alive 连接，server.close() 要等它自然断开，
  // 整个脚本就卡在收尾（真踩过）。
  if (context) await context.close().catch(() => undefined);
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(profile, { recursive: true, force: true });
  rmSync(clips, { recursive: true, force: true });
  report();
  process.exit(fail.length === 0 ? 0 : 1);
}
