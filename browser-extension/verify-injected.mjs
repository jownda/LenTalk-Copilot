/**
 * 注入函数自包含性检查 —— `node verify-injected.mjs`
 *
 * 这个扩展有两处用 `chrome.scripting.executeScript` 注入到页面里执行的函数：
 * `background.js` 的 `grabInPage`、`popup.js` 的 `scanPageMedia`。
 *
 * `executeScript` 只把**函数源码**序列化过去，闭包里的任何东西都会丢失 ——
 * 引用外部标识符不会报错在扩展侧，而是变成页面里的 `ReferenceError`，
 * 表现为「抓取全失败」这种最难查的现象（真实踩过：`encodeBase64 is not defined`）。
 *
 * 所以这里用两种方式把函数搬离原作用域后真跑一遍：
 *   - `new Function(fn.toString())`：模拟执行上下文与源码隔离
 *   - `vm.runInContext`：只提供页面应有的全局对象，多引用一个外部名字就抛错
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 真实取过字节的一张跨域图片，用来验证「拿得到 + 字节一致」。 */
const SAMPLE_URL =
  'https://cdn.sanity.io/images/6pat6ky0/production/7380fc47102ced86c1286e832e5b3bbc0ea5d15d-3222x4896.jpg';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/** 从源码里按大括号配对抠出一个具名函数（不依赖它所在文件的作用域）。 */
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

/** 去掉注释与字符串字面量：只留代码，避免注释里提到的名字造成误判。 */
function stripCommentsAndStrings(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// ── 0. 先证明这套检查手段本身有效 ────────────────────────────────────
{
  const outerHelper = () => [1, 2, 3];
  const leaks = async function () {
    return outerHelper();
  };
  // ⚠️ 必须先赋值再 await：`await new Function(...)()` 会被解析成
  // `(await new Function(...))()`，await 根本没作用在调用结果上，异常就捕获不到。
  const isolatedLeak = new Function(`return (${leaks.toString()})`)();
  let threw = null;
  try {
    await isolatedLeak();
  } catch (error) {
    threw = error;
  }
  check(
    '检查手段有效：引用外部标识符的函数隔离后确实会抛 ReferenceError',
    threw instanceof ReferenceError,
    threw ? threw.message : '没有抛错，说明这套检查测不出问题！！！',
  );
}

// ── 1. background.js :: grabInPage（真跑，含跨域图片）────────────────
{
  const source = readFileSync(join(HERE, 'background.js'), 'utf8');
  const chromeStub = {
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      sendMessage: async () => undefined,
    },
    scripting: { executeScript: async () => [] },
    tabs: {},
    // 背景脚本启动时会顺带建右键菜单，下面这些得存在，否则顶层代码直接抛错。
    // 注意这里**故意不给 onShown** —— 真实 Chrome 里它实测就是 undefined，
    // 代码必须能在缺它的环境下正常加载。
    contextMenus: {
      create: (_props, callback) => callback && callback(),
      removeAll: (callback) => callback && callback(),
      refresh() {},
      onClicked: { addListener() {} },
    },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  };
  const mod = new Function('chrome', `${source}\n;return { grabInPage };`)(chromeStub);
  const grabInPage = new Function(`return (${mod.grabInPage.toString()})`)();

  check(
    'grabInPage 代码里不再调用外部标识符',
    !/\bencodeBase64\b/.test(stripCommentsAndStrings(grabInPage.toString())),
  );

  const bytes = new Uint8Array(3000).map((_, index) => index % 251);
  const dataUrl = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
  const small = await grabInPage(dataUrl, 16 * 1024 * 1024);
  const smallBytes = small.ok ? new Uint8Array(Buffer.from(small.base64, 'base64')) : null;
  check(
    '小文件：页面通道返回 ok 且字节一致',
    small.ok === true && smallBytes !== null && sha(smallBytes) === sha(bytes),
    small.ok ? `${small.size} bytes / ${small.contentType}` : small.error,
  );

  const response = await fetch(SAMPLE_URL);
  const expected = new Uint8Array(await response.arrayBuffer());
  const large = await grabInPage(SAMPLE_URL, 16 * 1024 * 1024);
  const largeBytes = large.ok ? new Uint8Array(Buffer.from(large.base64, 'base64')) : null;
  check(
    '跨域图片（1.5 MB，走流式累加分支）：返回 ok 且逐字节一致',
    large.ok === true && largeBytes !== null && sha(largeBytes) === sha(expected),
    large.ok ? `${large.size} bytes / ${large.contentType}` : large.error,
  );

  const capped = await grabInPage(SAMPLE_URL, 64 * 1024);
  check('超过内联上限时返回 tooLarge（改走后台流式通道）', capped.ok === false && capped.tooLarge === true);
}

// ── 2. popup.js :: scanPageMedia（只提供页面应有的全局，跑到返回为止）──
/** 极小的 DOM 替身：只实现扫描函数真正用到的那几个属性。 */
function makeElement(attrs, extra = {}) {
  return {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelectorAll: () => [],
    ...extra,
  };
}

function makeScanContext({ nodes = {}, entries = [], title = '测试页' } = {}) {
  return vm.createContext({
    document: {
      title,
      // 选择器按关键字兜底，免得测试跟着代码里那串长 meta 选择器一起改。
      querySelectorAll: (selector) => {
        if (selector.includes('meta')) return nodes.meta || [];
        if (selector.includes('link')) return nodes.link || [];
        if (selector.includes('picture')) return nodes.picture || [];
        if (selector.includes('source')) return nodes.source || [];
        return nodes[selector.trim()] || [];
      },
    },
    location: { href: 'https://example.com/page' },
    performance: { getEntriesByType: (type) => (type === 'resource' ? entries : []) },
    URL,
    decodeURIComponent,
    Math,
    Set,
    Array,
    Number,
    String,
    parseInt,
    parseFloat,
  });
}

{
  const source = readFileSync(join(HERE, 'popup.js'), 'utf8');
  const code = extractFunction(source, 'scanPageMedia');

  const empty = vm.runInContext(`(${code})`, makeScanContext());
  let result = null;
  let threw = null;
  try {
    result = empty();
  } catch (error) {
    threw = error;
  }
  check(
    'scanPageMedia 只依赖页面全局（空 DOM 下返回空数组，无 ReferenceError）',
    threw === null && Array.isArray(result) && result.length === 0,
    threw ? threw.message : 'ok',
  );
}

// ── 3. scanPageMedia 的四路来源（含"DOM 里根本没有"的素材）──────────
{
  const source = readFileSync(join(HERE, 'popup.js'), 'utf8');
  const code = extractFunction(source, 'scanPageMedia');

  const entries = [
    // 视频不是 <video src>，而是播放器 fetch 回来喂给 MSE 的 —— DOM 里只有 blob:。
    { name: 'https://cdn.test/hls/master.m3u8', initiatorType: 'xmlhttprequest', transferSize: 900 },
    { name: 'https://cdn.test/noext-video', initiatorType: 'video', transferSize: 5_000_000 },
    // 没有扩展名、但确实被当图片加载过的：
    { name: 'https://cdn.test/photo/hero', initiatorType: 'img', transferSize: 320_000 },
    // 埋点像素 / 小图标：必须挡掉，否则素材库会被垃圾塞满。
    { name: 'https://cdn.test/pixel', initiatorType: 'img', transferSize: 43 },
    // 接口地址：不认识就不猜。
    { name: 'https://cdn.test/api/feed.json', initiatorType: 'fetch', transferSize: 90_000 },
    // 和 DOM 重复的地址，只能出现一次。
    { name: 'https://cdn.test/dup.mp4', initiatorType: 'fetch', transferSize: 8_000_000 },
  ];

  const scan = vm.runInContext(
    `(${code})`,
    makeScanContext({
      nodes: {
        video: [makeElement({ src: 'https://cdn.test/dup.mp4' }, { videoWidth: 1920, videoHeight: 1080 })],
      },
      entries,
    }),
  );
  const items = scan();
  const urls = items.map((item) => item.url);
  const byUrl = new Map(items.map((item) => [item.url, item]));

  check('DOM 里的 video 照旧能扫到', byUrl.get('https://cdn.test/dup.mp4')?.mediaType === 'video');
  check(
    'DOM 与网络记录里的同一地址只出现一次',
    urls.filter((url) => url === 'https://cdn.test/dup.mp4').length === 1,
    urls.join(' , '),
  );
  check(
    '★ DOM 里根本没有、只在网络记录里的视频能扫到（别家扩展看得到的那种）',
    byUrl.get('https://cdn.test/noext-video')?.mediaType === 'video',
    urls.join(' , '),
  );
  check(
    '★ 没有扩展名的图片靠 initiatorType 认出来',
    byUrl.get('https://cdn.test/photo/hero')?.mediaType === 'image',
    urls.join(' , '),
  );
  check('埋点像素（43 字节）被挡掉', !urls.includes('https://cdn.test/pixel'), urls.join(' , '));
  check('不认识的接口地址不会被当成素材', !urls.includes('https://cdn.test/api/feed.json'), urls.join(' , '));
  check(
    'm3u8 被识别为视频，并打上分片清单标记（入库交给应用侧 ffmpeg）',
    byUrl.get('https://cdn.test/hls/master.m3u8')?.mediaType === 'video' &&
      byUrl.get('https://cdn.test/hls/master.m3u8')?.hls === true,
    JSON.stringify(byUrl.get('https://cdn.test/hls/master.m3u8') || null),
  );
  check('普通 mp4 不带分片清单标记', byUrl.get('https://cdn.test/dup.mp4')?.hls === false);
}

// ── 4. background.js :: findPageStreamsInPage（blob 找回真地址那一路）──
// 用户实际报过的问题：右键 MSE 播放器只能拿到 blob:，直接回一句"取不到完整文件"。
// 这个函数负责从 performance 时间线里把真地址捞回来，注入失败就等于功能没了。
/** 只实现这个函数用到的那几个页面 API。 */
function makeStreamContext({ nodes = [], entries = [] } = {}) {
  return vm.createContext({
    document: { querySelectorAll: () => nodes },
    location: { href: 'https://site.test/watch/1' },
    performance: { getEntriesByType: (type) => (type === 'resource' ? entries : []) },
    URL,
    Set,
    Array,
    String,
  });
}

{
  const source = readFileSync(join(HERE, 'background.js'), 'utf8');
  const code = extractFunction(source, 'findPageStreamsInPage');
  const streamFn = vm.runInContext(
    `(${code})`,
    makeStreamContext({
      entries: [
        // 顺序就是请求顺序：master 清单在变体清单之前，这个顺序不能被算法打乱。
        { name: 'https://site.test/hls/master.m3u8' },
        { name: 'https://cdn.test/hls/media.m3u8' },
        // 分片不是素材（几万个 .ts，捞进来会把库塞爆）。
        { name: 'https://cdn.test/hls/seg0.ts' },
        { name: 'https://cdn.test/movie.mp4' },
        { name: 'https://cdn.test/audio/tone.m4a' },
        { name: 'https://cdn.test/api/feed.json' },
        // 正是要绕开的东西，不能被当成"找到了"。
        { name: 'blob:https://site.test/xyz' },
        { name: 'data:image/png;base64,AAAA' },
      ],
      nodes: [makeElement({ href: 'https://cdn.test/preload.mp4' }), makeElement({ src: 'blob:https://site.test/abc' })],
    }),
  );

  let result = null;
  let threw = null;
  try {
    result = streamFn();
  } catch (error) {
    threw = error;
  }
  check('findPageStreamsInPage 只依赖页面全局（无 ReferenceError）', threw === null, threw ? threw.message : 'ok');

  if (result) {
    check(
      '清单按请求先后捞出（master 在最前）',
      result.playlists[0] === 'https://site.test/hls/master.m3u8' && result.playlists.length === 2,
      JSON.stringify(result.playlists),
    );
    check('视频直链与音频各自归类', result.videos.includes('https://cdn.test/movie.mp4') && result.audios.includes('https://cdn.test/audio/tone.m4a'), JSON.stringify(result));
    check('分片 .ts 不会被当成素材', !result.videos.includes('https://cdn.test/hls/seg0.ts'), JSON.stringify(result.videos));
    check('不认识的接口地址不入选', !result.videos.includes('https://cdn.test/api/feed.json'));
    check('blob:/data: 不会被当成找回的结果', JSON.stringify(result).indexOf('blob:') < 0, JSON.stringify(result));
    check('DOM 里 preload 的直链也能捞到', result.videos.includes('https://cdn.test/preload.mp4'), JSON.stringify(result.videos));
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
