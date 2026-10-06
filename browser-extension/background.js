/**
 * LenTalk 素材捕手 —— 后台服务（MV3 service worker）。
 *
 * 职责有三：找到 LenTalk 的本地接收端口、把媒体字节取回来、转发过去。
 *
 * 取字节有两条路，优先走第一条：
 *
 *   1. **页面上下文**（`chrome.scripting.executeScript` 注入）——
 *      请求由页面发出，所以自带页面的 Referer，同源资源还带 cookie。
 *      很多站点「把链接复制到别处打开就 403」的资源，只有这条路能拿到。
 *      代价是字节要经 base64 穿过注入边界，所以只用于小文件。
 *   2. **后台直取 + 流式转发** —— 由 service worker 发起，没有页面身份，
 *      但可以把响应体直接当作上传的请求体转出去（`duplex: 'half'`），
 *      全程不把文件读进内存。大文件走这条。
 *
 * 为什么取字节必须在浏览器里做、而不是把地址直接交给 LenTalk：
 * 很多图片和视频依赖站点登录态、Referer 或时效签名，离开浏览器上下文就是 403。
 * 这正是这个扩展相比「把链接贴进应用下载」唯一的价值所在。
 */

const PORT_SCAN_START = 17890;
const PORT_SCAN_END = 17899;

/**
 * 走「页面上下文」通道的体积上限。
 * 这条路的字节要经 base64 穿过注入边界（体积会涨三分之一），超了改走流式。
 */
const INLINE_LIMIT_BYTES = 16 * 1024 * 1024;

/** 单个素材上限。超过就跳过：再大就不适合由浏览器中转。 */
const MAX_ASSET_BYTES = 300 * 1024 * 1024;

/** 探测成功过的端口缓存。service worker 被回收后会自动重置，不影响正确性。 */
let cachedPort = 0;

function bridgeUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

/** 探测单个端口是不是 LenTalk。任何异常都当成"不是"。 */
async function probe(port) {
  try {
    const response = await fetch(bridgeUrl(port, '/ping'), { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.ok !== true || payload?.app !== 'LenTalk') return null;
    return { port, version: typeof payload.version === 'string' ? payload.version : '' };
  } catch {
    return null;
  }
}

/**
 * 找到可用的 LenTalk 端口。
 * 先验缓存（应用重启换了端口时会失败，失败后自动全量重扫），再从 17890 起逐个试。
 */
async function resolveBridge(forceDiscover = false) {
  if (!forceDiscover && cachedPort) {
    const alive = await probe(cachedPort);
    if (alive) return alive;
    cachedPort = 0;
  }
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port += 1) {
    const found = await probe(port);
    if (found) {
      cachedPort = found.port;
      return found;
    }
  }
  return null;
}

async function loadLibrary(bridge) {
  const response = await fetch(bridgeUrl(bridge.port, '/library'), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`读取素材库失败（HTTP ${response.status}）`);
  }
  return await response.json();
}

function fileNameFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

function extensionFromUrl(url) {
  const name = fileNameFromUrl(url);
  const index = name.lastIndexOf('.');
  if (index < 0) return '';
  const extension = name.slice(index + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : '';
}

function dropExtension(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name;
}

/**
 * 注入到页面里执行的取字节函数。
 *
 * 必须完全自包含 —— 它会被序列化后单独在页面里运行，引用任何外部变量都会失效。
 *
 * 关键点是这个 fetch 由**页面**发出而不是扩展后台：Referer 是页面地址，
 * 同源的请求还带着页面的 cookie。所以防盗链与登录可见的资源都能拿到。
 * credentials 保持默认（same-origin）：跨域请求本来也带不上别站的 cookie，
 * 反而会因 CORS 要求更严格而更容易失败。
 */
async function grabInPage(url, limit, range) {
  // ⚠️ 所有依赖都必须写在这个函数体**内部**：executeScript 只序列化函数本身，
  // 引用外面任何标识符都会在页面里变成 ReferenceError（真实踩过：encodeBase64）。
  const toBase64 = (bytes) => {
    let binary = '';
    const STEP = 0x8000;
    for (let index = 0; index < bytes.length; index += STEP) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + STEP));
    }
    return btoa(binary);
  };

  // BYTERANGE 型 HLS（整支视频编成一个文件、再按字节区间切成几十段写进清单，
  // Pinterest 就是这种）必须**按区间取**。不带 Range 会把整份文件拉下来 ——
  // 实测 28 MB，当场撞上体积上限，表现成「预览一直转圈」。
  const options =
    range && Number.isFinite(range.start) && Number.isFinite(range.end)
      ? { headers: { Range: `bytes=${range.start}-${range.end}` } }
      : undefined;

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      return { ok: false, error: `抓取被拒绝（HTTP ${response.status}）` };
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > limit) {
      return { ok: false, tooLarge: true };
    }
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > limit) return { ok: false, tooLarge: true };
      return {
        ok: true,
        base64: toBase64(new Uint8Array(buffer)),
        size: buffer.byteLength,
        contentType: response.headers.get('content-type') || '',
      };
    }

    // 边读边累计，超限立刻断开，不把大文件整个读进来。
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      base64: toBase64(merged),
      size: total,
      contentType: response.headers.get('content-type') || '',
    };
  } catch (error) {
    const message = error && error.message ? error.message : error;
    return { ok: false, error: `页面内取字节失败（${message}）` };
  }
}

/**
 * 把 HLS 地址交给应用侧的 ffmpeg 去拉流、合并成 mp4 再入库。
 *
 * 为什么不在扩展里拼分片：一是分片要逐个经 `executeScript` 以 base64 回传，
 * 长视频会在 popup 里堆出几百兆内存；二是拼出来的 mpegts 浏览器根本播不了，
 * 还得再做一次转封装。应用那边有 ffmpeg，能流式下载并直接产出可播的 mp4。
 */
async function importHls(bridge, item, categoryId) {
  // 应用侧产出的是 mp4 —— 文件名照实给，别让素材库里挂着一个 .m3u8 的文件名。
  const base = dropExtension(item.fileName || fileNameFromUrl(item.url)) || 'hls';
  const name = item.name || base;
  // 从 blob 找回地址时名字来自页面标题，比 index/master 这种清单名有信息量，文件名跟着它走。
  const fileBase = GENERIC_PLAYLIST_NAMES.includes(base.toLowerCase()) && name !== base ? name : base;
  const response = await fetch(bridgeUrl(bridge.port, '/hls'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: item.url,
      // 页面地址会被当成 Referer 与 Origin 一起发出去 —— 站点挡 HLS 分片主要就靠这两个头。
      pageUrl: item.pageUrl || '',
      categoryId: categoryId || '',
      name,
      fileName: `${fileBase}.mp4`,
    }),
  });
  // 老版本应用没有这个接口 —— 明确说出来，否则会被当成网络问题。
  if (response.status === 404) {
    throw new Error('当前 LenTalk 版本还没有 HLS 接口，请更新应用（重新构建）后再试');
  }
  return await readOutcome(response);
}

/** 在页面上下文取字节；拿不到时返回失败原因，由调用方决定是否回落。 */
async function captureInTab(tabId, url, range) {
  if (!tabId) {
    return { ok: false, error: '没有可用的标签页' };
  }
  try {
    const injections = await chrome.scripting.executeScript({
      target: { tabId },
      func: grabInPage,
      args: [url, INLINE_LIMIT_BYTES, range || null],
    });
    const result = injections && injections[0] ? injections[0].result : null;
    if (!result) {
      return { ok: false, error: '页面内没有返回结果' };
    }
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : error;
    return { ok: false, error: `无法在页面内取字节（${message}）` };
  }
}

/** base64 → Blob。页面通道回传的就是 base64 字符串。 */
function base64ToBlob(base64, contentType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType || 'application/octet-stream' });
}

function uploadParams(item, categoryId) {
  const fileName = item.fileName || fileNameFromUrl(item.url) || 'asset';
  const params = new URLSearchParams();
  if (categoryId) params.set('categoryId', categoryId);
  params.set('name', item.name || dropExtension(fileName));
  params.set('fileName', fileName);
  params.set('mediaType', item.mediaType || 'image');
  const extension = item.extension || extensionFromUrl(item.url);
  if (extension) params.set('extension', extension);
  return params;
}

/** 把上传响应翻译成结果或可直接展示的异常。 */
async function readOutcome(response, fallbackBytes) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error || `入库失败（HTTP ${response.status}）`);
  }
  return {
    bytes: typeof payload.bytes === 'number' ? payload.bytes : fallbackBytes,
    assetId: payload.assetId,
    name: payload.name,
  };
}

async function uploadBlob(uploadUrl, blob) {
  if (blob.size === 0) {
    throw new Error('抓到的内容是空的');
  }
  if (blob.size > MAX_ASSET_BYTES) {
    throw new Error(`超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB 上限`);
  }
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  return await readOutcome(response, blob.size);
}

/**
 * 后台直取并**流式**转发：把下载响应的 body 直接当作上传请求体交给 LenTalk，
 * 服务端按 chunked 边收边落盘，中间不产生整份文件的内存副本。
 */
async function importStreamed(uploadUrl, item) {
  const response = await fetch(item.url);
  if (!response.ok) {
    throw new Error(`抓取被拒绝（HTTP ${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_ASSET_BYTES) {
    throw new Error(`超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB 上限`);
  }
  if (!response.body) {
    return await uploadBlob(uploadUrl, await response.blob());
  }

  let upload;
  try {
    upload = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: response.body,
      duplex: 'half',
    });
  } catch {
    // 环境不支持流式请求体（或中转途中断了）：重新取一次，整块上传兜底。
    const retry = await fetch(item.url);
    if (!retry.ok) {
      throw new Error(`抓取被拒绝（HTTP ${retry.status}）`);
    }
    return await uploadBlob(uploadUrl, await retry.blob());
  }
  return await readOutcome(upload, declared);
}

/**
 * 后台直取的错误翻译。
 *
 * 后台 fetch 抛 TypeError 基本都是跨域被 CORS 拦下（扩展没申请该站点的访问权限），
 * 而原始信息只有一句 "Failed to fetch"，看不出是被防盗链、被登录墙还是被 CORS 拦的，
 * 所以补一句说明，免得用户以为功能坏了。
 */
function describeBackgroundFailure(error) {
  const message = error && error.message ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return `${message}（跨域且该站点未授权扩展访问）`;
  }
  return message;
}

/**
 * 抓取并入库单个素材。
 *
 * 顺序固定：先在页面上下文试（能带 Referer 与 cookie，成功率高得多），
 * 体积超限或注入失败再退回后台直取。失败信息会把两次的原因都带上，
 * 免得只显示"失败"却看不出是被防的还是被 CORS 拦的。
 */
async function importOne(bridge, item, categoryId, tabId) {
  // HLS(m3u8) 是「一张清单 + 一堆分片」，字节没法像普通素材那样整块递过去 ——
  // 而且分片动辄几百兆，也不该经浏览器中转。把地址交给应用，由随包 ffmpeg 拉流合并。
  if (isPlaylistUrl(item.url)) {
    return await importHls(bridge, item, categoryId);
  }

  const uploadUrl = bridgeUrl(bridge.port, `/assets?${uploadParams(item, categoryId).toString()}`);

  const inPage = await captureInTab(tabId, item.url);
  if (inPage.ok) {
    return await uploadBlob(uploadUrl, base64ToBlob(inPage.base64, inPage.contentType));
  }
  if (inPage.tooLarge) {
    return await importStreamed(uploadUrl, item);
  }

  try {
    return await importStreamed(uploadUrl, item);
  } catch (error) {
    const message = describeBackgroundFailure(error);
    throw new Error(`${inPage.error || '页面内取字节失败'}；后台直取也失败（${message}）`);
  }
}

/**
 * 注册一个扩展监听器；任何一个注册失败都不影响其它监听器。
 *
 * ⚠️ 真实踩过：`chrome.contextMenus.onShown` 在部分 Chrome 版本里**不存在**，
 * 直接 `.addListener` 会抛 TypeError。这类语句只要有一行抛错，它**后面**的顶层代码
 * 就全部不执行 —— 包括文件末尾的 `chrome.runtime.onMessage`。症状是：
 * popup 永远卡在「正在扫描页面…」（消息没人应答）、右键菜单也建不出来。
 * 所以每个监听器各自隔离，且通信通道必须最先注册。
 */
function safeRegister(label, action) {
  try {
    action();
  } catch (error) {
    console.warn(`[LenTalk 素材捕手] ${label} 注册失败，已跳过：`, error);
  }
}

/** popup 可能已经关掉了，广播失败属于正常情况。 */
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

// 通信通道最先注册：后面无论哪段初始化出问题，popup 都还能拿到明确回应，
// 而不是像之前那样一直等一个永远不会来的答复。
safeRegister('消息通道', () => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'lentalk:status') {
      resolveBridge(Boolean(message.force))
        .then((bridge) => sendResponse({ ok: true, bridge }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === 'lentalk:library') {
      (async () => {
        const bridge = await resolveBridge();
        if (!bridge) {
          sendResponse({ ok: false, error: '未检测到 LenTalk，请先启动应用' });
          return;
        }
        try {
          sendResponse({ ok: true, library: await loadLibrary(bridge) });
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message ?? error) });
        }
      })();
      return true;
    }

    /**
     * 预览取字节：popup 里的 <video>/<audio> 直链放不出来时，改由这里去要原文件。
     * HLS（m3u8）的清单与每一个分片也走这条 —— popup 直连会被 CORS 拦，
     * 而站点挡分片靠的正是 Referer，只有页面自己发出的请求才过得去。
     *
     * 只走「页面上下文」这一条，**不回落后台直取**。看着像少了一层保险，
     * 其实是这两条路的强弱关系在这里正好反过来：后台拿不到页面的 Referer 与 cookie，
     * 能取到的东西严格少于页面上下文；而 popup 里 <video src> 直链播放本身就带不了
     * Referer（正是百度、知乎那类防盗链站点 403 的原因）。所以页面上下文取不到时，
     * 后台直取几乎必然也取不到，再试一次只是让用户白等一轮。
     */
    if (message?.type === 'lentalk:preview') {
      (async () => {
        const url = typeof message.url === 'string' ? message.url : '';
        const tabId = typeof message.tabId === 'number' ? message.tabId : 0;
        if (!url) {
          sendResponse({ ok: false, error: '没有可预览的地址' });
          return;
        }
        // 分片可以只要一段：hls.js 解析出 BYTERANGE 后会把区间一起递过来。
        const range = message.range && typeof message.range === 'object' ? message.range : null;
        const result = await captureInTab(tabId, url, range);
        if (result && result.ok) {
          sendResponse({
            ok: true,
            base64: result.base64,
            size: result.size,
            contentType: result.contentType || '',
          });
          return;
        }
        if (result && result.tooLarge) {
          sendResponse({ ok: false, tooLarge: true, error: '文件超过预览体积上限' });
          return;
        }
        sendResponse({ ok: false, error: (result && result.error) || '取字节失败' });
      })();
      return true;
    }

    if (message?.type === 'lentalk:upload') {
      (async () => {
        const items = Array.isArray(message.items) ? message.items : [];
        const categoryId = typeof message.categoryId === 'string' ? message.categoryId : '';
        const tabId = typeof message.tabId === 'number' ? message.tabId : 0;
        const bridge = await resolveBridge();
        if (!bridge) {
          sendResponse({ ok: false, error: '未检测到 LenTalk，请先启动应用' });
          return;
        }

        const failures = [];
        let imported = 0;
        let bytes = 0;

        // 串行处理：并发会让多个大文件同时在途，得不偿失。
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          broadcast({ type: 'lentalk:progress', done: index, total: items.length, label: item.name || item.url });
          try {
            const result = await importOne(bridge, item, categoryId, tabId);
            imported += 1;
            bytes += result.bytes;
          } catch (error) {
            failures.push({ url: item.url, reason: String(error?.message ?? error) });
          }
        }

        broadcast({ type: 'lentalk:progress', done: items.length, total: items.length, label: '' });
        sendResponse({ ok: true, imported, bytes, failures, total: items.length });
      })();
      return true;
    }

    return undefined;
  });
});

/* ------------------------------------------------------------------ *
 * 右键菜单：不打开 popup 也能存
 *
 * 目的很单纯 —— 用户在图片上点右键就想存下来，不该先点扩展图标、等扫描、
 * 再从一堆图里找到它。所以右键路径直接拿 `info.srcUrl` 去走同一条
 * `importOne` 通道（页面上下文取字节 → 流式回落），分类则给两个入口：
 * 一下子点掉的「用上次的分类」和展开选的「指定分类」。
 * ------------------------------------------------------------------ */

/** 与 popup 共用同一个「上次用的分类」，两边的选择互相同步。 */
const CATEGORY_STORAGE_KEY = 'lentalk-category';

/** 哪些右键场景出现菜单项。link 覆盖「右键链接直接存」。 */
const MENU_CONTEXTS = ['image', 'video', 'audio', 'link'];

/** 点了立刻用上次的分类存下，不做二次选择。 */
const MENU_QUICK_ID = 'lentalk-save-quick';
/** 展开选分类的父项。 */
const MENU_PICK_ID = 'lentalk-save-pick';
/** 子项 id 前缀，后面接 categoryId；空尾表示「不分类」。 */
const MENU_PICK_PREFIX = 'lentalk-save-pick:';
/** 手动重读分类列表（应用里新建了分类时用得上）。 */
const MENU_RELOAD_ID = 'lentalk-save-reload';

/** 分类列表的缓存时长。右键菜单每次弹出都可能来问一次，别每次都打本地端口。 */
const LIBRARY_TTL_MS = 60 * 1000;

const MEDIA_KIND_BY_EXTENSION = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  avif: 'image', bmp: 'image', svg: 'image', ico: 'image', heic: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', avi: 'video',
  m3u8: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio', opus: 'audio',
  m3u: 'audio',
};

/**
 * HLS / m3u 分片清单。
 *
 * 右键拿到的往往就是一串 .m3u8，而 m3u8 本身只是几 KB 的**文本清单**，
 * 里面列着一堆分片地址 —— 按普通文件下载只会往素材库里塞一个没用的 txt。
 * 所以这里明确拦下并说清原因，而不是让用户存进去以后才发现打不开。
 * （真正的分片下载需要逐段取回再合并，属于另一条链路，尚未实现。）
 */
function isPlaylistUrl(url) {
  return /\.m3u8?(\?|#|$)/i.test(String(url || ''));
}

let libraryCache = null;
let libraryInflight = null;
/** 菜单内容签名，一样就不重建，免得 service worker 每次冷启动都闪一下菜单。 */
let menuSignature = '';
/** 菜单构建串行化：并发 removeAll/create 会撞出 duplicate id。 */
let menuQueue = Promise.resolve();
/** 上次尝试读取分类的时间。onShown 靠它做冷却，免得每次弹菜单都去打一遍本地端口。 */
let menuAttemptAt = 0;
let badgeTimer = 0;

function kindFromUrl(url) {
  return MEDIA_KIND_BY_EXTENSION[extensionFromUrl(url)] || '';
}

/** 扩展 API 的返回值在不同 Chrome 版本上未必是 Promise，包一层免得抛出去。 */
function call(action) {
  try {
    const result = action();
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    /* 角标只是反馈，失败不该影响入库本身 */
  }
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatBytesShort(bytes) {
  if (typeof bytes !== 'number' || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 角标反馈。
 *
 * 没有申请 notifications 权限 —— 每次保存都弹一条系统通知太吵，而角标
 * （图标右上角那个小字）既能给出成败，详情又能挂在 title 里，悬停即可看到原因。
 */
function flashBadge(text, color, title) {
  if (badgeTimer) {
    clearTimeout(badgeTimer);
    badgeTimer = 0;
  }
  call(() => chrome.action.setBadgeBackgroundColor({ color }));
  call(() => chrome.action.setBadgeText({ text }));
  call(() => chrome.action.setTitle({ title: title ? `LenTalk 素材捕手 — ${title}` : 'LenTalk 素材捕手' }));
  if (!text) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = 0;
    call(() => chrome.action.setBadgeText({ text: '' }));
    // 失败原因要**留住**：气泡只闪 7 秒，用户回头想看清楚就没了，于是只能报一句
    // 「存不了」。标题留着，悬停随时能读到上次到底为什么失败。
    if (text !== '!') call(() => chrome.action.setTitle({ title: 'LenTalk 素材捕手' }));
  }, text === '✓' ? 3000 : 7000);
}

/** 带缓存的素材库读取。应用没开时回落上一次的结果，菜单至少还可用。 */
async function cachedLibrary() {
  if (libraryCache && Date.now() - libraryCache.at < LIBRARY_TTL_MS) {
    return libraryCache.library;
  }
  if (libraryInflight) return await libraryInflight;
  libraryInflight = (async () => {
    try {
      const bridge = await resolveBridge();
      if (!bridge) return libraryCache ? libraryCache.library : null;
      const library = await loadLibrary(bridge);
      libraryCache = { at: Date.now(), library };
      return library;
    } catch {
      return libraryCache ? libraryCache.library : null;
    } finally {
      libraryInflight = null;
    }
  })();
  return await libraryInflight;
}

/** 把分类树摊平成菜单项要的顺序，顺带带上层级好做缩进。 */
function flattenCategories(library) {
  const categories = library && Array.isArray(library.categories) ? library.categories : [];
  const activeLibraryId = library ? library.activeLibraryId : '';
  const scoped = categories.filter(
    (category) => category && category.id && (!activeLibraryId || category.libraryId === activeLibraryId)
  );

  const byParent = new Map();
  scoped.forEach((category) => {
    const key = category.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(category);
  });

  const flat = [];
  const walk = (parentId, depth) => {
    (byParent.get(parentId) || []).forEach((category) => {
      flat.push({
        id: category.id,
        name: typeof category.name === 'string' && category.name ? category.name : '未命名分类',
        depth,
      });
      walk(category.id, depth + 1);
    });
  };
  walk('', 0);
  return flat;
}

function createMenu(props) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(props, () => {
      // 读一次 lastError，免得在控制台留下未处理的报错。
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function removeAllMenus() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });
}

async function doBuildContextMenus(force) {
  menuAttemptAt = Date.now();
  const library = await cachedLibrary();
  const categories = flattenCategories(library);

  const stored = await chrome.storage.local.get(CATEGORY_STORAGE_KEY).catch(() => null);
  const preferred =
    stored && typeof stored[CATEGORY_STORAGE_KEY] === 'string' ? stored[CATEGORY_STORAGE_KEY] : '';
  const preferredName = (categories.find((category) => category.id === preferred) || {}).name || '';

  const signature = [
    preferred,
    preferredName,
    ...categories.map((category) => `${category.depth}:${category.id}:${category.name}`),
  ].join('|');
  if (!force && signature === menuSignature) return;
  menuSignature = signature;

  await removeAllMenus();

  // 日常那一下：点完就存，分类沿用上次。
  await createMenu({
    id: MENU_QUICK_ID,
    title: preferredName ? `保存到 LenTalk 素材库（${clip(preferredName, 12)}）` : '保存到 LenTalk 素材库',
    contexts: MENU_CONTEXTS,
  });

  await createMenu({ id: MENU_PICK_ID, title: '保存到 LenTalk 的指定分类', contexts: MENU_CONTEXTS });
  await createMenu({
    id: MENU_PICK_PREFIX,
    parentId: MENU_PICK_ID,
    title: '不分类（素材库根目录）',
    contexts: MENU_CONTEXTS,
  });

  // 分类特别多的账号不做无谓的长菜单，超出的走扩展面板。
  categories.slice(0, 60).forEach((category) => {
    void createMenu({
      id: MENU_PICK_PREFIX + category.id,
      parentId: MENU_PICK_ID,
      // 缩进拼在 clip 外面：clip 会归一化空白，全角空格也属于空白，放里面就被吃掉了。
      title: `${'　'.repeat(category.depth)}${clip(category.name, 40 - category.depth)}`,
      contexts: MENU_CONTEXTS,
    });
  });

  await createMenu({
    id: MENU_RELOAD_ID,
    parentId: MENU_PICK_ID,
    type: 'separator',
    contexts: MENU_CONTEXTS,
  });
  await createMenu({
    id: `${MENU_RELOAD_ID}-item`,
    parentId: MENU_PICK_ID,
    title: '重新读取分类列表',
    contexts: MENU_CONTEXTS,
  });
}

/** 串行构建，避免并发 removeAll/create 撞车。 */
function buildContextMenus(options = {}) {
  menuQueue = menuQueue
    .then(() => doBuildContextMenus(Boolean(options.force)))
    .catch(() => undefined);
  return menuQueue;
}

/** 从右键上下文里取出用户点中的那个地址。 */
function contextUrl(info) {
  if (typeof info.srcUrl === 'string' && info.srcUrl) return info.srcUrl;
  if (typeof info.linkUrl === 'string' && info.linkUrl) return info.linkUrl;
  return '';
}

/** `index.m3u8`、`master.m3u8` 这种名字对用户毫无意义，不适合拿来当素材名。 */
const GENERIC_PLAYLIST_NAMES = ['index', 'master', 'playlist', 'media', 'manifest', 'stream', 'video', 'hls', 'out'];

/**
 * 注入到页面执行：给一个 `blob:` 找出真正的来源。
 *
 * 现在大量站点的播放器把视频 fetch 回来喂给 MSE，`<video>` 的 src 就是个 `blob:`，
 * DOM 上一点线索都没有 —— 右键拿到 blob 时，之前只能回一句"存不了"。
 * 但页面**实际请求过**的地址都记在 performance 时间线里，读它不需要任何额外权限。
 *
 * ⚠️ 必须完全自包含：它会被序列化后单独在页面里运行，引用外部变量会变成页面里的
 * ReferenceError（真实踩过：`encodeBase64 is not defined`）。
 */
function findPageStreamsInPage() {
  const PLAYLISTS = ['m3u8', 'm3u'];
  const VIDEOS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'flv'];
  const AUDIOS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'];

  const found = { playlists: [], videos: [], audios: [] };
  const seen = new Set();

  const classify = (raw) => {
    if (typeof raw !== 'string' || !raw) return;
    let url = null;
    try {
      url = new URL(raw, location.href);
    } catch {
      return;
    }
    // blob:/data: 正是要绕开的东西；其它协议也不是网页资源。
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const index = url.pathname.lastIndexOf('.');
    if (index < 0) return;
    const extension = url.pathname.slice(index + 1).toLowerCase();
    let bucket = '';
    if (PLAYLISTS.includes(extension)) bucket = 'playlists';
    else if (VIDEOS.includes(extension)) bucket = 'videos';
    else if (AUDIOS.includes(extension)) bucket = 'audios';
    else return;
    if (seen.has(url.href)) return;
    seen.add(url.href);
    found[bucket].push(url.href);
  };

  // ① 页面实际请求过的资源。按请求先后排列，master 清单一般在变体清单之前。
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      classify(entry.name);
    }
  } catch {
    /* 时间线拿不到就靠下面 DOM 那一路 */
  }

  // ② 还在 DOM 上的元素（blob: 会被 classify 直接丢掉）。
  document.querySelectorAll('video[src], video source[src], audio[src], audio source[src], link[href]').forEach((node) => {
    classify(node.getAttribute('src') || node.getAttribute('href'));
  });

  return found;
}

/** 在页面里找回 blob 背后的真实地址。拿不到返回 null。 */
async function findPageStreams(tabId, frameId) {
  if (!tabId) return null;
  const target = { tabId };
  // 播放器常常在 iframe 里，此时 performance 时间线也在那个 frame 上，得注到它里面去。
  if (typeof frameId === 'number' && frameId >= 0) target.frameIds = [frameId];
  else target.allFrames = true;
  try {
    const injections = await chrome.scripting.executeScript({
      target,
      func: findPageStreamsInPage,
    });
    const merged = { playlists: [], videos: [], audios: [] };
    for (const injection of injections || []) {
      const result = injection ? injection.result : null;
      if (!result || typeof result !== 'object') continue;
      for (const key of ['playlists', 'videos', 'audios']) {
        if (Array.isArray(result[key])) merged[key] = merged[key].concat(result[key]);
      }
    }
    return merged;
  } catch {
    return null;
  }
}

/** 页面标题 → 能当文件名用的名字。 */
function nameFromTitle(title) {
  return String(title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * 右键落在了 `blob:` 上：回头去页面里找真正的来源。
 *
 * 优先清单（HLS）—— src 变成 blob 基本都是 MSE 播放，而 MSE 的原料就是 m3u8；
 * 找不到清单再退一步，用页面请求过的视频直链。
 */
async function recoverBlobItem(tabId, frameId, mediaType, pageTitle) {
  const streams = await findPageStreams(tabId, frameId);
  if (!streams) return null;

  const pick = (list) => (Array.isArray(list) && list.length ? list[0] : '');
  const playlist = pick(streams.playlists);
  if (playlist) {
    const fileName = fileNameFromUrl(playlist);
    const base = dropExtension(fileName);
    const title = nameFromTitle(pageTitle);
    const name = GENERIC_PLAYLIST_NAMES.includes(base.toLowerCase()) && title ? title : base || title;
    return {
      item: { url: playlist, mediaType: 'video', hls: true, fileName, name },
      from: 'hls',
    };
  }

  const direct =
    mediaType === 'audio'
      ? pick(streams.audios) || pick(streams.videos)
      : pick(streams.videos) || pick(streams.audios);
  if (direct) {
    const fileName = fileNameFromUrl(direct);
    return {
      item: { url: direct, mediaType: kindFromUrl(direct) || 'video', fileName, name: dropExtension(fileName) },
      from: 'direct',
    };
  }
  return null;
}

/**
 * 从右键上下文里取出可用的素材地址。取不到就给出能看懂的原因。
 *
 * `blob:` 不是死路：那多半是 MSE 播放器，真地址还能从页面里找回来（见 recoverBlobItem）。
 */
async function resolveContextItem(info, tabId, pageTitle) {
  const url = contextUrl(info);
  if (!url) return { error: '没拿到可保存的地址' };
  if (/^data:/i.test(url)) return { error: '这是内嵌在页面里的图片，请「图片另存为」后再导入素材库' };
  if (/^blob:/i.test(url)) {
    const mediaType =
      info.mediaType === 'image' || info.mediaType === 'video' || info.mediaType === 'audio'
        ? info.mediaType
        : 'video';
    const recovered = await recoverBlobItem(
      tabId,
      typeof info.frameId === 'number' ? info.frameId : undefined,
      mediaType,
      pageTitle
    );
    if (recovered) return recovered;
    return {
      error: '页面里没留下可下载的原地址（播放器把流喂给了 MSE）—— 可以打开扩展面板扫一遍，从列表里挑一个入库',
    };
  }
  if (!/^https?:/i.test(url)) return { error: '这个地址不是网页资源，存不了' };
  // HLS 清单不拦 —— 它由应用侧的 ffmpeg 拉流合并，右键同样能存（见 importHls）。

  const mediaType =
    info.mediaType === 'image' || info.mediaType === 'video' || info.mediaType === 'audio'
      ? info.mediaType
      : kindFromUrl(url) || 'image';
  const fileName = fileNameFromUrl(url);
  // 右键直接点在 m3u8 上也要标出来：入库走的是应用侧 ffmpeg 那条路（见 importOne），
  // 不标的话成功提示里就少一句「HLS 流」，用户会以为存下来的只是个清单文件。
  return {
    item: { url, mediaType, fileName, name: dropExtension(fileName), hls: isPlaylistUrl(url) },
  };
}

/** 右键保存的完整流程：解析地址 → 入库 → 角标反馈。 */
async function saveFromContext(info, tab, explicitCategory) {
  const tabId = tab && typeof tab.id === 'number' ? tab.id : 0;
  const pageTitle = tab && typeof tab.title === 'string' ? tab.title : '';
  const rawUrl = contextUrl(info);
  // blob: 不是马上失败 —— 先去页面里把真地址找回来，让用户知道这一步在干什么。
  if (/^blob:/i.test(rawUrl)) {
    flashBadge('…', '#6b7280', '这是播放器临时流，正在从页面里找回真实地址…');
  }

  const resolved = await resolveContextItem(info, tabId, pageTitle);
  if (!resolved.item) {
    flashBadge('!', '#dc2626', `没存成：${resolved.error}`);
    return;
  }
  const item = resolved.item;
  // HLS 是交给应用去拉的，那边拿不到浏览器的登录态，只能靠 Referer 与 Origin，
  // 所以必须把页面地址一起递过去。
  // 页面里有 iframe 时，分片请求真正的 Referer 是那个 frame 的地址，优先用它。
  item.pageUrl =
    (info && typeof info.frameUrl === 'string' && info.frameUrl) ||
    (tab && typeof tab.url === 'string' ? tab.url : '');

  let categoryId = explicitCategory;
  if (categoryId === null) {
    const stored = await chrome.storage.local.get(CATEGORY_STORAGE_KEY).catch(() => null);
    categoryId = stored && typeof stored[CATEGORY_STORAGE_KEY] === 'string' ? stored[CATEGORY_STORAGE_KEY] : '';
  }

  flashBadge(
    '…',
    '#6b7280',
    resolved.from === 'hls'
      ? `正在让应用拉取 HLS 流：${clip(item.name || item.url, 30)}`
      : `正在抓取 ${clip(item.name || item.url, 40)}`
  );

  try {
    const bridge = await resolveBridge();
    if (!bridge) throw new Error('未检测到 LenTalk，请先启动应用');
    const result = await importOne(bridge, item, categoryId, tabId);
    const size = formatBytesShort(result.bytes);
    const parts = [`已入库：${clip(result.name || item.name || '素材', 30)}`];
    if (item.hls) parts.push('HLS 流');
    // 从 blob 里找回地址时要说一声 —— 存下来的不是用户右键的那个地址，免得下次生疑。
    if (resolved.from === 'direct') parts.push('页面里找回的地址');
    if (size) parts.push(size);
    flashBadge('✓', '#16a34a', parts.join(' · '));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    flashBadge('!', '#dc2626', `入库失败：${clip(message, 120)}`);
  }
}

safeRegister('右键菜单 · 点击', () => {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const menuItemId = typeof info.menuItemId === 'string' ? info.menuItemId : '';

    if (menuItemId === MENU_RELOAD_ID || menuItemId === `${MENU_RELOAD_ID}-item`) {
      libraryCache = null;
      void buildContextMenus({ force: true }).then(() => {
        flashBadge('↻', '#6b7280', '分类列表已重新读取');
      });
      return;
    }
    if (menuItemId === MENU_QUICK_ID) {
      // null 表示「用上次的分类」，由 saveFromContext 去读。
      void saveFromContext(info, tab, null);
      return;
    }
    if (menuItemId.startsWith(MENU_PICK_PREFIX)) {
      void saveFromContext(info, tab, menuItemId.slice(MENU_PICK_PREFIX.length));
    }
  });
});

/**
 * 菜单每次弹出前确认一次分类是最新的。
 * 应用里刚建的分类不必等缓存过期，也不必让用户手动刷新。
 *
 * `onShown` 不是所有版本都有（实测某些 Chrome 就是 undefined），
 * 没有它只是退化成「菜单不会自动刷新」，不影响保存功能。
 */
if (chrome.contextMenus?.onShown) {
  safeRegister('右键菜单 · 弹出前刷新', () => {
    chrome.contextMenus.onShown.addListener(() => {
      // 刚读过一次就先用着（成功与否都算），别每次弹菜单都去打一遍本地端口。
      if (Date.now() - menuAttemptAt < LIBRARY_TTL_MS) return;
      void buildContextMenus({ force: true }).then(() => {
        call(() => chrome.contextMenus.refresh());
      });
    });
  });
}

safeRegister('安装/更新钩子', () => {
  chrome.runtime.onInstalled.addListener(() => {
    void buildContextMenus({ force: true });
  });
});

// service worker 每次冷启动都补一次菜单：浏览器重启后菜单不会自己回来。
void buildContextMenus();

