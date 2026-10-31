/**
 * 扫描函数的回归测试（不依赖浏览器）。
 *
 * `scanPageMedia` / `findPageStreamsInPage` 都会被 `chrome.scripting.executeScript` 序列化到
 * 页面里单独执行，所以它们必须自包含 —— 这也让它们能在 Node 里被原样抽出来跑：
 * 从源文件切出函数体，用桩对象喂 `document` / `performance` / `location`。
 *
 * 跑法：`node browser-extension/tests/scan-page-media.test.cjs`
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

/** 从源码里切出 `function name() {...}` 的完整函数体（按大括号配平）。 */
function extractFunction(source, header) {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`找不到 ${header}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${header} 的大括号不配平`);
}

/**
 * 抖音真实地址形态：主机是 `v*-web.douyinvod.com`，路径以 `/video/tos/` 开头，
 * **没有扩展名**，媒体类型只写在 `mime_type=video_mp4` 这个查询参数里；
 * 每次请求的 `s=` / `t=` 签名都不同。
 */
const DOUYIN_VIDEO =
  'https://v3-web.douyinvod.com/8b8b4c0f/video/tos/cn/tos-cn-ve-15/oQ8XkA1b2C3d/?a=6383&br=3396&mime_type=video_mp4&s=abcd&t=1234&tn=tt';
const DOUYIN_VIDEO_RESIGNED = DOUYIN_VIDEO.replace('s=abcd', 's=zzzz').replace('t=1234', 't=9999');
const DOUYIN_PAGE =
  'https://www.douyin.com/video/7597321157112565018?modeFrom=userLike&secUid=MS4wLjABAAAA';

function fakeVideo(src, poster) {
  return {
    currentSrc: src,
    poster,
    videoWidth: 720,
    videoHeight: 1280,
    getAttribute(name) {
      return name === 'src' ? src : null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function runScan(entries, videos) {
  const document = {
    title: '这是我的抖音视频文案 #日常',
    querySelectorAll(selector) {
      return selector === 'video' ? videos || [] : [];
    },
  };
  const performance = { getEntriesByType: (type) => (type === 'resource' ? entries : []) };
  const factory = new Function(
    'document',
    'performance',
    'location',
    'URL',
    `${extractFunction(popupSource, 'function scanPageMedia()')}; return scanPageMedia;`,
  );
  return factory(document, performance, { href: DOUYIN_PAGE }, URL)();
}

function runStreams(entries) {
  const factory = new Function(
    'document',
    'performance',
    'location',
    'URL',
    `${extractFunction(backgroundSource, 'function findPageStreamsInPage()')}; return findPageStreamsInPage;`,
  );
  return factory(
    { querySelectorAll: () => [] },
    { getEntriesByType: (type) => (type === 'resource' ? entries : []) },
    { href: DOUYIN_PAGE },
    URL,
  )();
}

let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`✅ ${label}`);
    return;
  }
  failed += 1;
  console.error(`❌ ${label}${detail ? ` → ${detail}` : ''}`);
}

// ① 抖音主页：`<video src="blob:">` + 两条签名不同的同一视频
const douyin = runScan(
  [
    { name: DOUYIN_VIDEO, initiatorType: 'xmlhttprequest', transferSize: 12_000_000 },
    { name: DOUYIN_VIDEO_RESIGNED, initiatorType: 'fetch', transferSize: 12_000_000 },
    { name: DOUYIN_PAGE, initiatorType: 'navigation', transferSize: 90_000 },
    { name: 'https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy:q75.webp', initiatorType: 'img', transferSize: 300_000 },
  ],
  [fakeVideo('blob:https://www.douyin.com/1234-abcd', 'https://p3-sign.douyinpic.com/poster.webp')],
);
const douyinVideos = douyin.filter((item) => item.mediaType === 'video');
check('抖音视频能被识别', douyinVideos.length === 1, `实际 ${douyinVideos.length} 条`);
check('不同签名参数的同一视频合并为一条', douyinVideos.length === 1);
check(
  '无后缀视频用页面标题当名字',
  Boolean(douyinVideos[0] && douyinVideos[0].name.includes('抖音')),
  douyinVideos[0] && douyinVideos[0].name,
);
check('页面地址没有被当成素材', !douyin.some((item) => item.url === DOUYIN_PAGE));
check('封面图仍然被识别', douyin.some((item) => item.mediaType === 'image' && item.url.includes('douyinpic')));

// ② 未知 CDN：页面确实在走 MSE，且这条 fetch 体积很大 → 兜底当视频
const unknownCdn = 'https://cdn.example-cdn.xyz/abc/def?sign=1';
const withMse = runScan(
  [{ name: unknownCdn, initiatorType: 'fetch', transferSize: 8 * 1024 * 1024 }],
  [fakeVideo('blob:https://example.com/x')],
);
check('MSE 页面里的大体积 fetch 兜底识别为视频', withMse.some((item) => item.mediaType === 'video'));

// ③ 没有 blob 播放器时不许猜，否则任何大接口都会被当成视频
const withoutMse = runScan(
  [{ name: unknownCdn, initiatorType: 'fetch', transferSize: 8 * 1024 * 1024 }],
  [],
);
check('没有 MSE 播放器时不误判大 XHR', withoutMse.length === 0, JSON.stringify(withoutMse.map((item) => item.url)));

// ④ 移动端 / 嵌入页的开放播放接口
const amemv = runScan(
  [{ name: 'https://api.amemv.com/aweme/v1/play/?video_id=v0200&ratio=720p', initiatorType: 'xmlhttprequest', transferSize: 6 * 1024 * 1024 }],
  [fakeVideo('blob:https://www.douyin.com/y')],
);
check('aweme/v1/play 被识别为视频', amemv.some((item) => item.mediaType === 'video'));

// ⑤ 右键落在 blob: 上时的回溯
const streams = runStreams([
  { name: DOUYIN_VIDEO, initiatorType: 'xmlhttprequest' },
  { name: 'https://example.com/audio/song.mp3', initiatorType: 'audio' },
]);
check('blob 回溯能找到抖音视频直链', streams.videos.length === 1, JSON.stringify(streams.videos).slice(0, 80));
check('blob 回溯不影响音频识别', streams.audios.length === 1);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
