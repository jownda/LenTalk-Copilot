/**
 * 右键菜单自检。
 *
 * 菜单逻辑没法靠"点一下看看"来验证：service worker 的运行环境、chrome.contextMenus
 * 的回调时序、还有分类树到菜单项的映射，都只能靠一个假的 chrome 跑一遍才看得准。
 *
 * 这里用 vm 把背景脚本原样加载进一个带 mock chrome/fetch 的沙箱，然后：
 *   1. 检查菜单树（分类过滤、层级缩进、上次分类是否反映到标题上）
 *   2. 模拟点击「保存」，检查真正发出的入库请求有没有带对分类
 *   3. 检查 data:/blob: 这类取不到的地址会被拦在发请求之前
 *
 * 用法：node verify-context-menu.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));

const LIBRARY = {
  ok: true,
  activeLibraryId: 'lib-main',
  categories: [
    { id: 'cat-scene', name: '场景', parentId: null, libraryId: 'lib-main' },
    { id: 'cat-street', name: '街道', parentId: 'cat-scene', libraryId: 'lib-main' },
    { id: 'cat-other-library', name: '别的素材库', parentId: null, libraryId: 'lib-other' },
  ],
};

const PASS = [];
const FAIL = [];

function check(label, condition, detail = '') {
  if (condition) PASS.push(label);
  else FAIL.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  };
}

/**
 * 造一个「远端媒体」响应，供 `importStreamed` 的后台直取使用。
 * 不带 `body`（浏览器不支持流式请求体时会走整块上传的兜底），但要能给 blob。
 */
function mediaResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(bytes) : null) },
    body: null,
    blob: async () => new Blob([new Uint8Array(bytes)]),
  };
}

/**
 * 造一个假的扩展环境。只实现被测代码真正用到的那几个 API。
 *
 * 两个刻意的设定，都来自真实踩过的坑：
 *   - `withOnShown` 默认 **false**：实测真实 Chrome 里 `chrome.contextMenus.onShown`
 *     就是 undefined，原来的 mock 给它造了一个，于是完全没测出"这行抛错会拖垮整个后台"。
 *   - `failOn`：把指定监听器的注册变成抛错，验证一个失败不会连累其它监听器。
 */
function makeHarness({
  stored = {},
  inPageResult = null,
  withOnShown = false,
  failOn = '',
  /** 页面里找回来的流（`findPageStreamsInPage` 的结果）；null 表示页面里什么都没有。 */
  streamsResult = null,
  /** 让"去页面里找流"这一步直接注入失败，验证会优雅退化而不是崩掉。 */
  streamsThrows = false,
  /** 让 /hls 返回 404，模拟"应用还是老版本、没这个接口"。 */
  hlsStatus = 200,
  /** 远端媒体（`fetch(item.url)`）的响应 `{ url, response }`；不给就走不到「后台直取」。 */
  remoteMedia = null,
  /** 远端媒体地址；设成某个 URL 则该地址的 fetch 直接抛 `TypeError('Failed to fetch')`。 */
  remoteThrows = '',
  /** `chrome.permissions.contains` 的返回值：主机权限（全站远端访问）是否真的授予。 */
  remoteAccessGranted = true,
  /** 让上传到本机桥（`/assets?`）的那次 fetch 抛 `Failed to fetch`，用来测「下载成了但入库失败」。 */
  uploadThrows = false,
} = {}) {
  const menus = new Map();
  const store = { ...stored };
  const fetches = [];
  /** 每次 fetch 的完整入参，用来断言 referrer 之类的选项有没有真的传下去。 */
  const fetchInits = [];
  /** HLS 走的是 `/hls`（JSON 请求体），单独记下来方便断言递了哪些字段。 */
  const hlsRequests = [];
  const badge = { text: '', title: '' };
  const listeners = { clicked: [], shown: [], message: [], installed: [] };

  const subscribe = (name) => (listener) => {
    if (failOn === name) throw new TypeError(`注入的故障：${name} 注册失败`);
    listeners[name].push(listener);
  };

  const contextMenus = {
    create(props, callback) {
      menus.set(props.id, props);
      if (callback) callback();
    },
    removeAll(callback) {
      menus.clear();
      if (callback) callback();
    },
    refresh() {},
    onClicked: { addListener: subscribe('clicked') },
  };
  if (withOnShown) {
    contextMenus.onShown = { addListener: subscribe('shown') };
  }

  const chrome = {
    contextMenus,
    permissions: {
      // 后台 fetch 被拦成 Failed to fetch 的两种成因（防盗链 vs 主机权限没给）现象一模一样，
      // 所以失败信息里要把这一项的真实状态带出来。这里按用例可切换。
      contains: async () => remoteAccessGranted,
    },
    runtime: {
      lastError: undefined,
      onInstalled: { addListener: subscribe('installed') },
      onMessage: { addListener: subscribe('message') },
      sendMessage: async () => ({}),
    },
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === 'string') return { [key]: store[key] };
          return { ...store };
        },
        set: async (items) => {
          Object.assign(store, items);
        },
      },
    },
    action: {
      setBadgeText: ({ text }) => {
        badge.text = text;
      },
      setBadgeBackgroundColor: () => {},
      setTitle: ({ title }) => {
        badge.title = title;
      },
    },
    scripting: {
      // 两条注入走的是同一个 API，靠注入的函数名区分（和真实调用完全一致）。
      executeScript: async (options) => {
        const name = options && options.func ? options.func.name : '';
        if (name === 'findPageStreamsInPage') {
          if (streamsThrows) throw new Error('无法注入到该页面');
          return [{ result: streamsResult }];
        }
        return [{ result: inPageResult }];
      },
    },
  };

  const fetchMock = async (url, init) => {
    const target = String(url);
    fetches.push(target);
    fetchInits.push({ url: target, init });
    if (target.endsWith('/ping')) return jsonResponse({ ok: true, app: 'LenTalk', version: '1.2.0' });
    if (target.endsWith('/library')) return jsonResponse(LIBRARY);
    if (target.includes('/assets?')) {
      if (uploadThrows) throw new TypeError('Failed to fetch');
      return jsonResponse({ ok: true, bytes: 2, assetId: 'asset-1', name: '火车头' });
    }
    if (target.endsWith('/hls')) {
      hlsRequests.push(JSON.parse(String((init && init.body) || '{}')));
      if (hlsStatus !== 200) return jsonResponse({ ok: false, error: '未知接口' }, hlsStatus);
      return jsonResponse({ ok: true, bytes: 4096, assetId: 'asset-hls', name: 'HLS 片子' });
    }
    // 「后台直取」那条路：由 service worker 去下载远端媒体。
    // 跨域被 CORS 拦下时浏览器抛出的就是一句 `TypeError('Failed to fetch')` ——
    // 正是用户看到的那条裸错误，这里按需复现。
    if (remoteThrows && target === remoteThrows) {
      throw new TypeError('Failed to fetch');
    }
    if (remoteMedia && target === remoteMedia.url) return remoteMedia.response;
    throw new Error(`自检里没预料到的请求：${target}`);
  };

  const sandbox = {
    chrome,
    fetch: fetchMock,
    console,
    setTimeout,
    clearTimeout,
    // service worker 里这些都是平台自带的，沙箱得手动补上。
    URL,
    URLSearchParams,
    Blob,
    atob,
    btoa,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(here, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });

  // clicked 保留一个别名，下面的用例直接用它。
  return { sandbox, menus, listeners, clicked: listeners.clicked, store, fetches, fetchInits, hlsRequests, badge };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - started > timeout) return false;
    await sleep(10);
  }
}

/** 取最后一次入库请求的查询参数。 */
function lastUploadQuery(fetches) {
  const target = [...fetches].reverse().find((url) => url.includes('/assets?'));
  return target ? new URL(target).searchParams : null;
}

async function main() {
  // ── 1. 菜单树 ─────────────────────────────────────────────────────
  {
    const { sandbox, menus } = makeHarness({ stored: { 'lentalk-category': 'cat-scene' } });
    await sandbox.buildContextMenus({ force: true });

    check('建出「一键保存」项', menus.has('lentalk-save-quick'));
    check(
      '「一键保存」标题带上次用的分类',
      menus.get('lentalk-save-quick')?.title === '保存到 LenTalk 素材库（场景）',
      menus.get('lentalk-save-quick')?.title
    );
    check('建出「指定分类」父项', menus.has('lentalk-save-pick'));
    check('有「不分类」项', menus.get('lentalk-save-pick:')?.title === '不分类（素材库根目录）');
    check('顶层分类原样呈现', menus.get('lentalk-save-pick:cat-scene')?.title === '场景');
    check(
      '子分类带缩进',
      menus.get('lentalk-save-pick:cat-street')?.title === '　街道',
      JSON.stringify(menus.get('lentalk-save-pick:cat-street')?.title)
    );
    check('别的素材库的分类不进菜单', !menus.has('lentalk-save-pick:cat-other-library'));
    check('分类项挂在父菜单下', menus.get('lentalk-save-pick:cat-scene')?.parentId === 'lentalk-save-pick');

    // 没设过分类时不该出现空括号。
    const blank = makeHarness({});
    await blank.sandbox.buildContextMenus({ force: true });
    check(
      '没选过分类时不带括号',
      blank.menus.get('lentalk-save-quick')?.title === '保存到 LenTalk 素材库',
      blank.menus.get('lentalk-save-quick')?.title
    );
  }

  // ── 2. 一键保存走上次的分类 ────────────────────────────────────────
  {
    const harness = makeHarness({
      stored: { 'lentalk-category': 'cat-street' },
      inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'image/jpeg' },
    });
    await harness.sandbox.buildContextMenus({ force: true });

    harness.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'image', srcUrl: 'https://cdn.test/a.jpg' },
      { id: 7 }
    );
    const done = await waitFor(() => harness.badge.text === '✓');
    const query = lastUploadQuery(harness.fetches);

    check('一键保存确实发起了入库', Boolean(query));
    check('沿用了上次的分类', query?.get('categoryId') === 'cat-street', query?.get('categoryId'));
    check('文件名与名称按地址推出', query?.get('fileName') === 'a.jpg' && query?.get('name') === 'a');
    check('素材类型是图片', query?.get('mediaType') === 'image');
    check('完成后角标是成功', done && harness.badge.text === '✓', harness.badge.text);
    check('成功提示带上了素材名', (harness.badge.title || '').includes('火车头'), harness.badge.title);
  }

  // ── 3. 指定分类（含「不分类」）─────────────────────────────────────
  {
    const harness = makeHarness({
      inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'video/mp4' },
    });
    await harness.sandbox.buildContextMenus({ force: true });

    harness.clicked[0](
      { menuItemId: 'lentalk-save-pick:cat-scene', mediaType: 'video', srcUrl: 'https://cdn.test/clip.mp4' },
      { id: 9 }
    );
    await waitFor(() => harness.badge.text === '✓');
    check('指定分类生效', lastUploadQuery(harness.fetches)?.get('categoryId') === 'cat-scene');

    const none = makeHarness({
      inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'image/png' },
    });
    await none.sandbox.buildContextMenus({ force: true });
    none.clicked[0](
      { menuItemId: 'lentalk-save-pick:', mediaType: 'image', srcUrl: 'https://cdn.test/b.png' },
      { id: 9 }
    );
    await waitFor(() => none.badge.text === '✓');
    const query = lastUploadQuery(none.fetches);
    check('「不分类」不带 categoryId', Boolean(query) && query.get('categoryId') === null);
  }

  // ── 4. 取不到的地址应该被拦下，不发请求 ────────────────────────────
  {
    const harness = makeHarness({ inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: '' } });
    await harness.sandbox.buildContextMenus({ force: true });

    harness.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'image', srcUrl: 'data:image/png;base64,AAAA' },
      { id: 3 }
    );
    await waitFor(() => harness.badge.text === '!');
    check('内嵌图被拦下', harness.badge.text === '!');
    check('拦下时没有发出任何入库请求', !harness.fetches.some((url) => url.includes('/assets?')));

    const blob = makeHarness({ inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: '' } });
    await blob.sandbox.buildContextMenus({ force: true });
    blob.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'blob:https://site.test/xyz' },
      { id: 3 }
    );
    await waitFor(() => blob.badge.text === '!');
    check('页面里确实没有原地址时，blob 流被明确拒掉', blob.badge.text === '!', blob.badge.title);
    check(
      '拒掉 blob 时说的是人话（指出是 MSE 并给出下一步）',
      /MSE/.test(blob.badge.title || '') && /扩展面板/.test(blob.badge.title || ''),
      blob.badge.title
    );
    check('拒掉 blob 时不发任何入库请求', !blob.fetches.some((url) => url.includes('/assets?')));
  }

  // ── 4b. 右键落在 blob: 上 —— 去页面里把真正的 HLS 地址找回来 ────────
  // 这是用户实际报的那个问题：MSE 播放器的 <video> 的 src 就是 blob:，
  // 直接回一句"取不到完整文件"等于功能废掉；真地址其实在 performance 时间线里。
  {
    const harness = makeHarness({
      streamsResult: {
        playlists: ['https://cdn.test/hls/master.m3u8', 'https://cdn.test/hls/media.m3u8'],
        videos: [],
        audios: [],
      },
    });
    await harness.sandbox.buildContextMenus({ force: true });
    harness.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'blob:https://site.test/xyz', frameId: 0 },
      { id: 3, url: 'https://site.test/watch/1', title: '测试页' }
    );
    await waitFor(() => harness.badge.text === '✓' || harness.badge.text === '!');

    check('★ blob 上右键能把 HLS 地址找回来并入库', harness.badge.text === '✓', `${harness.badge.text} ${harness.badge.title}`);
    check('找回后走的是 HLS 通道', harness.hlsRequests.length === 1, JSON.stringify(harness.hlsRequests));
    check('没有误发普通上传请求', !harness.fetches.some((url) => url.includes('/assets?')));
    const sent = harness.hlsRequests[0] || {};
    check('用的是页面里最早请求的那张清单（master）', sent.url === 'https://cdn.test/hls/master.m3u8', JSON.stringify(sent));
    check('找回的地址同样带上页面地址当 Referer', sent.pageUrl === 'https://site.test/watch/1', JSON.stringify(sent));
    check('成功提示里说明了这是 HLS 流', /HLS/.test(harness.badge.title || ''), harness.badge.title);

    // 清单名是 index/master 这类没有信息量的名字时，用页面标题当素材名。
    const titled = makeHarness({
      streamsResult: { playlists: ['https://cdn.test/hls/index.m3u8'], videos: [], audios: [] },
    });
    await titled.sandbox.buildContextMenus({ force: true });
    titled.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'blob:https://site.test/abc' },
      { id: 3, url: 'https://site.test/watch/9', title: '某剧 第 1 集' }
    );
    await waitFor(() => titled.hlsRequests.length > 0 || titled.badge.text === '!');
    const titledSent = titled.hlsRequests[0] || {};
    check('清单名没信息量时用页面标题当素材名', titledSent.name === '某剧 第 1 集', JSON.stringify(titledSent));
    check('HLS 产出的文件名是 .mp4（应用侧合并出来的就是 mp4）', titledSent.fileName === '某剧 第 1 集.mp4', JSON.stringify(titledSent));

    // 页面里没有清单，但有视频直链 —— 退一步用它。
    const direct = makeHarness({
      inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'video/mp4' },
      streamsResult: { playlists: [], videos: ['https://cdn.test/movie.mp4'], audios: [] },
    });
    await direct.sandbox.buildContextMenus({ force: true });
    direct.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'blob:https://site.test/def' },
      { id: 3, url: 'https://site.test/watch/2', title: '测试页' }
    );
    await waitFor(() => direct.badge.text === '✓' || direct.badge.text === '!');
    check('没有清单时退回页面里请求过的视频直链', lastUploadQuery(direct.fetches)?.get('fileName') === 'movie.mp4', direct.badge.title);
    check('成功提示说明地址是找回的', /找回/.test(direct.badge.title || ''), direct.badge.title);

    // 注入失败（比如受限页面）必须优雅退化，不能把整条链路带崩。
    const broken = makeHarness({ streamsThrows: true });
    await broken.sandbox.buildContextMenus({ force: true });
    broken.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'blob:https://site.test/ghi' },
      { id: 3, url: 'https://site.test/watch/3', title: '测试页' }
    );
    await waitFor(() => broken.badge.text === '!');
    check('找回地址时注入失败也只是拒掉这一项', broken.badge.text === '!', broken.badge.title);
    check('注入失败后后台仍然可用', broken.listeners.message.length === 1 && broken.menus.has('lentalk-save-quick'));
  }

  // ── 5. link 上下文按扩展名判类型 ───────────────────────────────────
  {
    const harness = makeHarness({
      inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'video/mp4' },
    });
    await harness.sandbox.buildContextMenus({ force: true });
    harness.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'link', linkUrl: 'https://cdn.test/movie.mp4' },
      { id: 5 }
    );
    await waitFor(() => harness.badge.text === '✓');
    check('右键链接按扩展名认出视频', lastUploadQuery(harness.fetches)?.get('mediaType') === 'video');
  }

  // ── 6. onShown 不存在时，整个后台必须仍然完好 ────────────────────
  // 实测真实 Chrome 里 chrome.contextMenus.onShown 就是 undefined。原来直接
  // .addListener 会抛 TypeError，把它后面的顶层代码（含消息通道、菜单创建）全带走。
  {
    const harness = makeHarness({
      withOnShown: false,
      inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'image/jpeg' },
    });
    await harness.sandbox.buildContextMenus({ force: true });

    check('onShown 缺失时消息通道照常注册', harness.listeners.message.length === 1);
    check('onShown 缺失时右键点击照常注册', harness.listeners.clicked.length === 1);
    check('onShown 缺失时安装钩子照常注册', harness.listeners.installed.length === 1);
    check('onShown 缺失时菜单照常建出来', harness.menus.has('lentalk-save-quick'));

    harness.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'image', srcUrl: 'https://cdn.test/c.jpg' },
      { id: 2 }
    );
    await waitFor(() => harness.badge.text === '✓');
    check('onShown 缺失时一键保存仍可用', harness.badge.text === '✓', harness.badge.text);
  }

  // ── 7. onShown 存在时要挂上（可选能力，有就用）────────────────────
  {
    const harness = makeHarness({ withOnShown: true });
    await harness.sandbox.buildContextMenus({ force: true });
    check('onShown 存在时已注册', harness.listeners.shown.length === 1);
    check('onShown 存在时消息通道不受影响', harness.listeners.message.length === 1);
  }

  // ── 8. 任何一个监听器注册失败，都不能连累其它 ─────────────────────
  for (const failing of ['clicked', 'shown', 'installed', 'message']) {
    const harness = makeHarness({ withOnShown: true, failOn: failing });
    await harness.sandbox.buildContextMenus({ force: true });

    const survivor = Object.entries(harness.listeners)
      .filter(([name]) => name !== failing)
      .every(([, list]) => list.length === 1);
    check(
      `「${failing}」注册失败时其它监听器仍注册`,
      survivor,
      Object.entries(harness.listeners).map(([name, list]) => `${name}=${list.length}`).join(' ')
    );
    check(`「${failing}」注册失败时菜单仍建出来`, harness.menus.has('lentalk-save-quick'));
  }

  // ── 9. 预览取字节（popup 里直链放不出来时走这条）──────────────────
  {
    const call = (harness, message) =>
      new Promise((resolve) => {
        harness.listeners.message[0](message, {}, resolve);
      });

    const ok = makeHarness({
      inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'video/mp4' },
    });
    const reply = await call(ok, { type: 'lentalk:preview', url: 'https://cdn.test/clip.mp4', tabId: 4 });
    check('预览把字节回给 popup', reply.ok === true && reply.base64 === 'aGk=', JSON.stringify(reply));
    check('预览带回体积与类型', reply.size === 2 && reply.contentType === 'video/mp4');

    const large = makeHarness({ inPageResult: { ok: false, tooLarge: true } });
    const largeReply = await call(large, { type: 'lentalk:preview', url: 'https://cdn.test/big.mp4', tabId: 4 });
    check(
      '超过体积上限时明确回 tooLarge（好让 popup 提示改走原链）',
      largeReply.ok === false && largeReply.tooLarge === true,
      JSON.stringify(largeReply)
    );

    const blank = makeHarness({});
    const blankReply = await call(blank, { type: 'lentalk:preview', url: '', tabId: 4 });
    check('空地址被挡下，不会去注入页面', blankReply.ok === false, JSON.stringify(blankReply));

    const noTab = makeHarness({ inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: '' } });
    const noTabReply = await call(noTab, { type: 'lentalk:preview', url: 'https://cdn.test/a.mp4', tabId: 0 });
    check(
      '没有可取字节的标签页时给出可读原因',
      noTabReply.ok === false && /标签页/.test(noTabReply.error || ''),
      JSON.stringify(noTabReply)
    );

    // 预览绝不能顺手往素材库里写东西 —— 看一眼就入库是灾难。
    check('预览不产生任何入库请求', !ok.fetches.some((url) => url.includes('/assets?')));
  }

  // ── 10. HLS 分片清单交给应用侧的 ffmpeg ────────────────────────────
  // m3u8 只是一张清单，扩展拼不了分片；它把地址递过去，由应用拉流合并成 mp4。
  {
    const harness = makeHarness({ inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'text/plain' } });
    await harness.sandbox.buildContextMenus({ force: true });
    harness.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'https://cdn.test/hls/master.m3u8' },
      { id: 4, url: 'https://site.test/watch/1' }
    );
    await waitFor(() => harness.hlsRequests.length > 0 || harness.badge.text === '!');

    check('右键 m3u8 走的是 HLS 下载通道', harness.hlsRequests.length === 1, JSON.stringify(harness.hlsRequests));
    check('没有把 m3u8 当普通素材上传', !harness.fetches.some((url) => url.includes('/assets?')));
    const sent = harness.hlsRequests[0] || {};
    check('HLS 请求带上了清单地址', sent.url === 'https://cdn.test/hls/master.m3u8', JSON.stringify(sent));
    // 页面地址会被应用当成 Referer/Origin —— 站点挡 HLS 分片主要靠它。
    check('HLS 请求带上了页面地址', sent.pageUrl === 'https://site.test/watch/1', JSON.stringify(sent));
    check('HLS 请求带上了文件名与类型', sent.fileName === 'master.mp4' && sent.name === 'master', JSON.stringify(sent));
    await waitFor(() => harness.badge.text === '✓' || harness.badge.text === '!');
    check('HLS 入库成功后给出成功反馈', harness.badge.text === '✓', `${harness.badge.text} ${harness.badge.title}`);

    // HLS 入库要重新构建过的应用；老版本没有 /hls，得把话说清楚，
    // 否则用户只会看到一句"未知接口"然后以为功能坏了。
    const oldApp = makeHarness({ hlsStatus: 404 });
    await oldApp.sandbox.buildContextMenus({ force: true });
    oldApp.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'https://cdn.test/hls/master.m3u8' },
      { id: 4, url: 'https://site.test/watch/1' }
    );
    await waitFor(() => oldApp.badge.text === '!');
    check('应用没更新时明确提示要更新应用', /更新应用/.test(oldApp.badge.title || ''), oldApp.badge.title);

    // 普通 mp4 不能被这条规则误伤。
    const fine = makeHarness({ inPageResult: { ok: true, base64: 'aGk=', size: 2, contentType: 'video/mp4' } });
    await fine.sandbox.buildContextMenus({ force: true });
    fine.listeners.clicked[0](
      { menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: 'https://cdn.test/movie.mp4?token=abc' },
      { id: 4 }
    );
    await waitFor(() => fine.badge.text === '✓');
    check('普通 mp4（带查询串）照常入库', fine.badge.text === '✓', fine.badge.title);
  }

  // ── 11. 大文件（超过页面通道上限）必须回落后台直取 ────────────────────
  // 用户实际报的就是这一条：视频超过 16 MB 时页面通道超限（base64 穿过注入边界太贵），
  // 只能由 service worker 去下载。以前这个分支的异常是**裸抛**的 —— popup 里就只剩
  // 「1 项没能入库：Failed to fetch」，既看不出是体积问题、也看不出下一步做什么。
  //
  // ⚠️ 2026-10-13 的关键修正：后台直取**不能**再走「边下边传」。
  // 流式转发（`duplex: 'half'` + chunked）会让本机桥卡在等第一个分块上，直到 60 秒读超时
  // （`media_bridge.rs` 的 `IO_TIMEOUT`）掐断连接；浏览器侧只看到 `Failed to fetch`，
  // 桥侧同时留下 `[media-bridge] request failed: 读取请求失败: … (os error 10060)`。
  // 成因是冷 CDN 回源慢、而分块必须等源站首字节 —— 「源站慢」被转嫁成了「桥读超时」。
  // 所以下面既有「能入库」的正例，也有**钉死不许改回流式**的负例。
  {
    const bigUrl = 'https://cdn.test/big.mp4';
    const pageTab = { id: 6, url: 'https://www.kuaishou.com/short-video/abc123' };
    /** 「响应头拿到了、body 行为可控」的远端响应，用来复现下载阶段的各种失败。 */
    const remoteResponse = (blob) => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? '2048' : null) },
      body: null,
      blob,
    });

    // (a) 正常情况：页面通道超限 → 整块下载 → 整块上传，成功入库。
    const fallback = makeHarness({
      inPageResult: { ok: false, tooLarge: true },
      remoteMedia: { url: bigUrl, response: mediaResponse(2048) },
    });
    await fallback.sandbox.buildContextMenus({ force: true });
    fallback.listeners.clicked[0]({ menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: bigUrl }, pageTab);
    await waitFor(() => fallback.badge.text === '✓' || fallback.badge.text === '!');
    check(
      '超过 16MB 的视频回落后台直取后能入库',
      fallback.badge.text === '✓',
      `${fallback.badge.text} ${fallback.badge.title}`
    );
    check(
      '确实走了「先下载后上传」而不是页面通道',
      fallback.fetches.includes(bigUrl) && fallback.fetches.some((url) => url.includes('/assets?')),
      JSON.stringify(fallback.fetches)
    );
    // 核心钉子 ①：源站**只请求一次**。旧实现失败时会在流式失败后再整块重取一次，
    // 那既慢、又容易踩第二次被 CDN 拒 / 限流；换成一次下载后必须保持只请求一次。
    check(
      '只向源站请求一次（不再有「流式失败后整块重取」的第二跳）',
      fallback.fetches.filter((url) => url === bigUrl).length === 1,
      JSON.stringify(fallback.fetches)
    );
    // 核心钉子 ②：上传体必须是整块 Blob（有确定长度），且请求**不带 duplex**。
    // 这条直接锁死「不要再改回边下边传」—— 那是 2026-10-13 那个 bug 的根源。
    const uploadInit = fallback.fetchInits.find((call) => call.url.includes('/assets?'));
    const uploadBody = uploadInit && uploadInit.init && uploadInit.init.body;
    check(
      '上传用的是整块 Blob（不是流式 body）',
      Boolean(uploadBody) &&
        typeof uploadBody.getReader !== 'function' &&
        typeof uploadBody.size === 'number',
      uploadBody ? `size=${uploadBody.size}` : '(没有上传体)'
    );
    check(
      '上传请求不带 duplex（改回流式就会在这里挂）',
      Boolean(uploadInit) && uploadInit.init.duplex === undefined,
      JSON.stringify(uploadInit && uploadInit.init)
    );
    // 钉子：**不要**再试着在这里伪造 Referer。实测（Chrome 155）跨源 referrer 会被浏览器
    // 直接丢弃，`{ referrer, referrerPolicy }` 写了等于没写，只会造成「已修复」的错觉。
    // 真要改写 Referer 得上 declarativeNetRequest 的 modifyHeaders，且同样依赖主机权限。
    const downloadInit = fallback.fetchInits.find((call) => call.url === bigUrl);
    check(
      '下载保持裸 fetch（跨源 referrer 会被丢弃，不是修复点）',
      Boolean(downloadInit) && downloadInit.init === undefined,
      JSON.stringify(downloadInit && downloadInit.init)
    );

    // (b) 后台直取被拦（防盗链 / 网络不通）→ 提示必须说清「哪一步」「体积」「下一步」。
    const blocked = makeHarness({
      inPageResult: { ok: false, tooLarge: true },
      remoteThrows: bigUrl,
    });
    await blocked.sandbox.buildContextMenus({ force: true });
    blocked.listeners.clicked[0]({ menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: bigUrl }, pageTab);
    await waitFor(() => blocked.badge.text === '!');
    const blockedTitle = blocked.badge.title || '';
    check('后台直取被拦时反馈是失败', blocked.badge.text === '!', blockedTitle);
    check('失败提示说明了体积原因（不再没头没尾）', blockedTitle.includes('16 MB'), blockedTitle);
    check(
      '失败提示带上了后台那一步的真实原因',
      blockedTitle.includes('后台直取也失败') && blockedTitle.includes('Failed to fetch'),
      blockedTitle
    );
    check('失败提示指明了具体是哪一步挂的', blockedTitle.includes('拉取源文件失败'), blockedTitle);
    check('失败提示带上了主机权限的真实状态', blockedTitle.includes('远端访问权限：已授予'), blockedTitle);
    // 回归钉子：以前这条路是裸抛的，标题里就只剩一句 Failed to fetch。
    check(
      '不再出现「只有一句 Failed to fetch」的裸提示',
      !/^LenTalk 素材捕手 — 入库失败：Failed to fetch$/.test(blockedTitle),
      blockedTitle
    );
    check('失败时不会留下半截入库请求', !blocked.fetches.some((url) => url.includes('/assets?')));

    // (c) 主机权限没真的授予 —— 现象与防盗链完全一样，所以必须能在提示里区分出来。
    const noPerm = makeHarness({
      inPageResult: { ok: false, tooLarge: true },
      remoteThrows: bigUrl,
      remoteAccessGranted: false,
    });
    await noPerm.sandbox.buildContextMenus({ force: true });
    noPerm.listeners.clicked[0]({ menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: bigUrl }, pageTab);
    await waitFor(() => noPerm.badge.text === '!');
    check(
      '主机权限未授予时提示会直接点出来（含修复指引）',
      (noPerm.badge.title || '').includes('远端访问权限：未授予') &&
        (noPerm.badge.title || '').includes('在所有网站上'),
      noPerm.badge.title
    );

    // (d) 页面地址缺失（老版本 popup 传来的条目 / 拿不到 tab）时也不能崩，照常入库。
    const noPage = makeHarness({
      inPageResult: { ok: false, tooLarge: true },
      remoteMedia: { url: bigUrl, response: mediaResponse(2048) },
    });
    await noPage.sandbox.buildContextMenus({ force: true });
    noPage.listeners.clicked[0]({ menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: bigUrl }, { id: 6 });
    await waitFor(() => noPage.badge.text === '✓' || noPage.badge.text === '!');
    check('拿不到页面地址时大文件照常入库（不依赖 pageUrl）', noPage.badge.text === '✓', noPage.badge.title);

    // (e) 响应头拿到了、但读 body 时断了 —— 这正是「冷 CDN 回源太慢」的真实形态：
    //     旧实现会让本机桥干等 60 秒读超时（os error 10060），而浏览器只看到一句
    //     `Failed to fetch`，两边都定位不到这一层。新实现把等待留在浏览器侧，
    //     并且**说得出等了多少秒**。
    const bodyBroken = makeHarness({
      inPageResult: { ok: false, tooLarge: true },
      remoteMedia: {
        url: bigUrl,
        response: remoteResponse(async () => {
          throw new TypeError('Failed to fetch');
        }),
      },
    });
    await bodyBroken.sandbox.buildContextMenus({ force: true });
    bodyBroken.listeners.clicked[0]({ menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: bigUrl }, pageTab);
    await waitFor(() => bodyBroken.badge.text === '!');
    check(
      '下载中途断了能指明是「读内容」这一步、并报出已等待时长',
      (bodyBroken.badge.title || '').includes('下载源文件内容失败') &&
        (bodyBroken.badge.title || '').includes('已等待'),
      bodyBroken.badge.title
    );

    // (f) 下载成了、但入库那一步被拦 → 必须报出「已下载多少 MB」，好与「根本没下到」区分开。
    //     以前这两种情况的提示完全一样（都是一句 Failed to fetch），只能靠猜。
    const uploadFailed = makeHarness({
      inPageResult: { ok: false, tooLarge: true },
      remoteMedia: { url: bigUrl, response: mediaResponse(2048) },
      uploadThrows: true,
    });
    await uploadFailed.sandbox.buildContextMenus({ force: true });
    uploadFailed.listeners.clicked[0]({ menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: bigUrl }, pageTab);
    await waitFor(() => uploadFailed.badge.text === '!');
    check(
      '下载成了但入库失败时，提示会报出已下载的体积',
      (uploadFailed.badge.title || '').includes('已下载') &&
        (uploadFailed.badge.title || '').includes('但入库失败'),
      uploadFailed.badge.title
    );

    // (g) 拿到 200 但一个字节都没有（签名 URL 失效的典型形态）→ 单列一条，别让它伪装成别的失败。
    const emptyBody = makeHarness({
      inPageResult: { ok: false, tooLarge: true },
      remoteMedia: { url: bigUrl, response: remoteResponse(async () => new Blob([])) },
    });
    await emptyBody.sandbox.buildContextMenus({ force: true });
    emptyBody.listeners.clicked[0]({ menuItemId: 'lentalk-save-quick', mediaType: 'video', srcUrl: bigUrl }, pageTab);
    await waitFor(() => emptyBody.badge.text === '!');
    check(
      '下载到 0 字节时会单独说明（不混进网络失败）',
      (emptyBody.badge.title || '').includes('0 字节'),
      emptyBody.badge.title
    );
  }

  console.log(`\n通过 ${PASS.length} 项，失败 ${FAIL.length} 项`);
  PASS.forEach((label) => console.log(`  ✓ ${label}`));
  FAIL.forEach((label) => console.log(`  ✗ ${label}`));
  process.exit(FAIL.length === 0 ? 0 : 1);
}

void main();
