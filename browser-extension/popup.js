/**
 * LenTalk 素材捕手 —— popup 界面。
 *
 * popup 只负责三件事：扫描当前页面、让用户勾选与选分类、把任务交给后台。
 * 取字节和入库都在 background.js 里做（popup 关掉后上传仍应继续）。
 */

const CATEGORY_STORAGE_KEY = 'lentalk-category';

/** 筛选档位。数量在渲染时实时填进去。 */
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'audio', label: '音频' },
];

const MEDIA_LABEL = { image: '图片', video: '视频', audio: '音频' };

const state = {
  items: [],
  /**
   * 已勾选项，存**地址**而不是下标。
   * 下标在筛选/重扫之后会全部错位，地址不会。
   */
  selected: new Set(),
  /** 当前筛选档位（all / image / video / audio）。 */
  filter: 'all',
  busy: false,
  /** 页脚要显示的说明性文字（扫描结果、入库结果）。用户一操作勾选就清掉。 */
  notice: '',
  /** 当前标签页 id。后台要在**页面上下文**里取字节，必须知道往哪个标签页注入。 */
  tabId: 0,
};

const elements = {
  dot: document.getElementById('status-dot'),
  status: document.getElementById('status-text'),
  rescan: document.getElementById('rescan'),
  category: document.getElementById('category'),
  filters: document.getElementById('filters'),
  selectAll: document.getElementById('select-all'),
  selectNone: document.getElementById('select-none'),
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  failures: document.getElementById('failures'),
  summary: document.getElementById('summary'),
  import: document.getElementById('import'),
};

/**
 * 扫到的素材都能入库 —— HLS 虽然是一张清单加一堆分片，但交给应用侧的 ffmpeg
 * 就能拉流合并成 mp4（见 background.js 的 importHls），所以不再把它排除在外。
 */
function isImportable() {
  return true;
}

function selectableItems() {
  return state.items.filter(isImportable);
}

function visibleItems() {
  return state.items.filter((item) => state.filter === 'all' || item.mediaType === state.filter);
}

function countByType() {
  const counts = { all: state.items.length, image: 0, video: 0, audio: 0 };
  state.items.forEach((item) => {
    if (counts[item.mediaType] !== undefined) counts[item.mediaType] += 1;
  });
  return counts;
}

function setStatus(text, kind = '') {
  elements.status.textContent = text;
  elements.dot.className = `dot${kind ? ` ${kind}` : ''}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 注入到页面执行的扫描函数。
 *
 * 必须完全自包含 —— 它会被序列化后单独在页面里运行，引用任何外部变量都会失效。
 * 只读 DOM 与页面自己的 performance 记录，不发任何网络请求。
 *
 * 四路来源，互补：
 *   1. DOM 元素（img/picture/video/audio/source/a/meta/link）
 *   2. **页面实际请求过的资源**（performance 时间线）—— 这一路是补齐
 *      「别家扩展看得到、我们看不到」的关键：播放器用 fetch/XHR 取回视频再喂给
 *      MSE 播放时，`<video>` 上的 src 是 blob:，DOM 里什么都读不出来，
 *      只有网络记录里有真实地址。扩展没有 webRequest 权限，
 *      但页面自己的 performance 里就记着，且不需要任何额外权限。
 *   3. 懒加载站点惯用的 data-* 属性
 *   4. og/twitter/preload 这类元信息
 */
function scanPageMedia() {
  const MIN_EDGE = 48;
  /** DOM 之外的资源拿不到尺寸，只能用传输体积粗略挡掉小图标。 */
  const MIN_TRANSFER_BYTES = 2048;
  const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'];
  const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'm3u8'];
  const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'm3u'];
  /** 分片清单：不是单个能存下来的文件，标出来让用户看得见，但不可入库。 */
  const PLAYLIST_EXTENSIONS = ['m3u8', 'm3u'];

  const results = [];
  const seen = new Set();

  const normalize = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null;
    try {
      const url = new URL(trimmed, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.href;
    } catch {
      return null;
    }
  };

  const extensionOf = (url) => {
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      return '';
    }
    const index = pathname.lastIndexOf('.');
    return index < 0 ? '' : pathname.slice(index + 1).toLowerCase();
  };

  const kindFromUrl = (url) => {
    const extension = extensionOf(url);
    if (!extension) return null;
    if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
    if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
    if (AUDIO_EXTENSIONS.includes(extension)) return 'audio';
    return null;
  };

  const add = (rawUrl, mediaType, extra) => {
    const url = normalize(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    let fileName = '';
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      fileName = decodeURIComponent(segments[segments.length - 1] || '');
    } catch {
      fileName = '';
    }
    results.push({
      url,
      mediaType,
      width: extra && extra.width ? extra.width : 0,
      height: extra && extra.height ? extra.height : 0,
      name: fileName.replace(/\.[^.]+$/, ''),
      fileName,
      extension: '',
      poster: (extra && extra.poster) || '',
      // 分片清单（m3u8/m3u）：能识别，但不是单个文件，界面上会标出来且不允许入库。
      hls: PLAYLIST_EXTENSIONS.includes(extensionOf(url)),
      pageUrl: location.href,
      pageTitle: document.title,
    });
  };

  const largestFromSrcset = (srcset) => {
    if (!srcset) return null;
    let best = null;
    let bestScore = -1;
    srcset.split(',').forEach((entry) => {
      const parts = entry.trim().split(/\s+/);
      const candidate = parts[0];
      if (!candidate) return;
      const descriptor = parts[1] || '';
      let score = 0;
      if (descriptor.endsWith('w')) score = parseInt(descriptor, 10) || 0;
      else if (descriptor.endsWith('x')) score = (parseFloat(descriptor) || 0) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    });
    return best;
  };

  document.querySelectorAll('img').forEach((image) => {
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    if (width > 0 && height > 0 && Math.max(width, height) < MIN_EDGE) return;
    // 懒加载站点的真实地址常在 data-* 上，而 src 还是占位图，所以按可靠性排序取第一个可用的。
    const candidates = [
      image.getAttribute('data-src'),
      image.getAttribute('data-original'),
      image.getAttribute('data-lazy-src'),
      image.getAttribute('data-actualsrc'),
      largestFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset')),
      image.currentSrc,
      image.getAttribute('src'),
    ];
    for (const candidate of candidates) {
      if (normalize(candidate)) {
        add(candidate, 'image', { width, height });
        break;
      }
    }
  });

  document.querySelectorAll('picture source[srcset]').forEach((source) => {
    const candidate = largestFromSrcset(source.getAttribute('srcset'));
    if (candidate) add(candidate, 'image', {});
  });

  /**
   * MSE 站点的 `<video>` 是 `blob:`，地址本身取不到，但它的 poster 与尺寸正是
   * 清单卡片最缺的缩略图。先收在这里，等下面 performance 那一路扫出 m3u8 时挂上去
   * —— 否则 HLS 卡片只会显示一个「HLS」字样，用户根本认不出是哪个视频。
   * 正在走 MSE 的那个播放器（src 是 blob:）与 m3u8 的对应关系最可靠，优先用它。
   */
  let mseVideoShot = null;
  let anyVideoShot = null;

  document.querySelectorAll('video').forEach((video) => {
    if (video.poster && normalize(video.poster)) {
      const shot = { poster: video.poster, width: video.videoWidth, height: video.videoHeight };
      if ((video.currentSrc || video.getAttribute('src') || '').startsWith('blob:')) {
        mseVideoShot = mseVideoShot || shot;
      }
      anyVideoShot = anyVideoShot || shot;
    }

    const candidates = [
      video.currentSrc,
      video.getAttribute('src'),
      video.getAttribute('data-src'),
      video.getAttribute('data-video-src'),
      video.getAttribute('data-url'),
      ...Array.from(video.querySelectorAll('source')).flatMap((node) => [
        node.getAttribute('src'),
        node.getAttribute('data-src'),
      ]),
    ];
    for (const candidate of candidates) {
      if (normalize(candidate)) {
        add(candidate, 'video', {
          width: video.videoWidth,
          height: video.videoHeight,
          poster: video.poster,
        });
        break;
      }
    }
  });

  document.querySelectorAll('audio').forEach((audio) => {
    const candidates = [
      audio.currentSrc,
      audio.getAttribute('src'),
      audio.getAttribute('data-src'),
      ...Array.from(audio.querySelectorAll('source')).map((node) => node.getAttribute('src')),
    ];
    for (const candidate of candidates) {
      if (normalize(candidate)) {
        add(candidate, 'audio', {});
        break;
      }
    }
  });

  document.querySelectorAll('a[href]').forEach((anchor) => {
    const url = normalize(anchor.getAttribute('href'));
    if (!url) return;
    const kind = kindFromUrl(url);
    if (kind) add(url, kind, {});
  });

  document
    .querySelectorAll(
      'meta[property="og:image"], meta[property="og:video"], meta[property="og:video:url"], ' +
        'meta[property="og:video:secure_url"], meta[property="twitter:player:stream"], ' +
        'meta[property="twitter:image"], meta[itemprop="contentUrl"], meta[name="twitter:player:stream"]'
    )
    .forEach((meta) => {
      const url = normalize(meta.getAttribute('content'));
      if (!url) return;
      const property = (meta.getAttribute('property') || meta.getAttribute('itemprop') || '').toLowerCase();
      const hint = property.indexOf('video') >= 0 ? 'video' : 'image';
      add(url, kindFromUrl(url) || hint, {});
    });

  document.querySelectorAll('link[rel="preload"], link[rel="prefetch"]').forEach((link) => {
    const as = (link.getAttribute('as') || '').toLowerCase();
    const kind = as === 'video' ? 'video' : as === 'audio' ? 'audio' : as === 'image' ? 'image' : null;
    if (kind) add(link.getAttribute('href'), kind, {});
  });

  /**
   * 页面**实际请求过**的资源（performance 时间线）。
   *
   * 这一路存在的理由：越来越多的站点不在 HTML 里写 `<video src>`，而是用播放器
   * fetch/XHR 把视频取回来再喂给 MSE —— 此时 `<video>` 上的 src 是 `blob:`，
   * DOM 里一点线索都没有，只有网络记录里有真实地址。
   * 扩展没有（也不想申请）webRequest 权限，但页面自己的 performance 里就记着。
   *
   * 没有扩展名的地址就靠 initiatorType 判类型（img 加载的必然是图片），
   * 不认识的（fetch 出来的 /api/xxx）一律不猜 —— 宁可少收，不要把接口地址塞进素材库。
   */
  const kindByInitiator = { img: 'image', imageset: 'image', video: 'video', audio: 'audio' };
  try {
    const entries = performance.getEntriesByType('resource') || [];
    entries.forEach((entry) => {
      const url = normalize(entry && entry.name);
      if (!url || seen.has(url)) return;
      const kind = kindFromUrl(url) || kindByInitiator[entry.initiatorType];
      if (!kind) return;
      // DOM 之外的图片没有尺寸可比，只能用传输体积粗略挡掉小图标和埋点像素。
      const bytes = entry.transferSize || entry.decodedBodySize || 0;
      if (kind === 'image' && bytes > 0 && bytes < MIN_TRANSFER_BYTES) return;
      // 清单自己不可能有封面，借页面上播放器那张 —— 卡片才有图可看。
      const shot =
        kind === 'video' && PLAYLIST_EXTENSIONS.includes(extensionOf(url))
          ? mseVideoShot || anyVideoShot || {}
          : {};
      add(url, kind, shot);
    });
  } catch {
    // 拿不到时间线（老内核、隐私模式）只是少一路来源，不影响其它通道。
  }

  // 大图优先：用户要找的通常是内容图，不是图标。
  results.sort((left, right) => right.width * right.height - left.width * left.height);
  return results.slice(0, 300);
}

/** 扫描当前标签页；失败（如 chrome:// 页面）时返回空数组并给出提示。 */
async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('拿不到当前标签页');
  }
  state.tabId = tab.id;
  const injections = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scanPageMedia,
  });
  const result = injections && injections[0] ? injections[0].result : null;
  return Array.isArray(result) ? result : [];
}

function renderCategoryOptions(library) {
  const activeLibraryId = library ? library.activeLibraryId : '';
  const categories = (library && library.categories ? library.categories : []).filter(
    (category) => !activeLibraryId || category.libraryId === activeLibraryId
  );

  const byParent = new Map();
  categories.forEach((category) => {
    const key = category.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(category);
  });

  elements.category.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '不分类（放在素材库根目录）';
  elements.category.appendChild(none);

  const walk = (parentId, depth) => {
    const children = byParent.get(parentId) || [];
    children.forEach((category) => {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = `${'　'.repeat(depth)}${category.name}`;
      elements.category.appendChild(option);
      walk(category.id, depth + 1);
    });
  };
  walk('', 0);
}

/** 筛选按钮只建一次，之后只改文案与选中态 —— 每次重建会把键盘焦点弄丢。 */
function ensureFilterChips() {
  if (elements.filters.childElementCount === FILTERS.length) return;
  elements.filters.innerHTML = '';
  FILTERS.forEach((filter) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.filter = filter.id;
    button.addEventListener('click', () => {
      state.filter = filter.id;
      state.notice = '';
      renderGrid();
      updateSummary();
    });
    elements.filters.appendChild(button);
  });
}

function renderFilters() {
  ensureFilterChips();
  const counts = countByType();
  FILTERS.forEach((filter) => {
    const button = elements.filters.querySelector(`.chip[data-filter="${filter.id}"]`);
    if (!button) return;
    const count = counts[filter.id] || 0;
    button.textContent = `${filter.label} ${count}`;
    button.classList.toggle('active', state.filter === filter.id);
    // 「全部」即使为 0 也留着，好让用户看到"这个页面确实什么都没扫到"。
    button.disabled = filter.id !== 'all' && count === 0;
  });
}

function renderGrid() {
  elements.grid.innerHTML = '';
  const visible = visibleItems();
  elements.empty.hidden = visible.length > 0;
  elements.empty.textContent =
    state.items.length > 0 && state.filter !== 'all'
      ? `这个页面上没有扫到${MEDIA_LABEL[state.filter]}。`
      : '这个页面上没有找到图片或直链视频。';

  visible.forEach((item) => {
    const card = document.createElement('label');
    const selected = state.selected.has(item.url);
    const usable = isImportable(item);
    card.className = `card${selected ? ' selected' : ''}${usable ? '' : ' locked'}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected;
    checkbox.disabled = !usable;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.url);
      else state.selected.delete(item.url);
      card.classList.toggle('selected', checkbox.checked);
      state.notice = '';
      updateSummary();
    });
    card.appendChild(checkbox);

    // 视频/音频的缩略图整块就是「播放」按钮，点一下弹出预览播放器。
    // 图片不在此列 —— 点图片缩略图仍然是勾选，不改既有手感。
    const playable = item.mediaType === 'video' || item.mediaType === 'audio';
    const thumb = document.createElement(playable ? 'button' : 'div');
    thumb.className = playable ? 'thumb playable' : 'thumb';

    // 缩略图缺失时的占位文字。单独做成一个元素而不是写 thumb.textContent，
    // 否则 poster 加载失败时会把叠在上面的播放标记一起抹掉。
    const placeholder = document.createElement('span');
    placeholder.className = 'thumb-text';
    placeholder.textContent = item.hls
      ? 'HLS'
      : item.mediaType === 'video'
        ? '视频'
        : item.mediaType === 'audio'
          ? '音频'
          : '图片';
    placeholder.hidden = true;

    const previewSource = item.mediaType === 'image' ? item.url : item.poster;
    if (previewSource) {
      const image = document.createElement('img');
      image.src = previewSource;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        image.remove();
        placeholder.hidden = false;
      });
      thumb.appendChild(image);
    } else {
      placeholder.hidden = false;
    }
    thumb.appendChild(placeholder);

    if (playable) {
      thumb.type = 'button';
      thumb.title = '点击预览播放';
      const glyph = document.createElement('span');
      glyph.className = 'thumb-play';
      thumb.appendChild(glyph);

      // 卡片本身是 <label>：不拦住这两层，浏览器会把点击转给复选框，
      // 变成「点一下既打开预览、又把勾选反了」。
      const swallow = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      thumb.addEventListener('mousedown', swallow);
      thumb.addEventListener('click', (event) => {
        swallow(event);
        openPeek(item);
      });
    }
    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = item.hls ? 'HLS 流' : MEDIA_LABEL[item.mediaType] || '图片';
    const size = document.createElement('span');
    size.textContent = item.width && item.height ? `${item.width}×${item.height}` : '';
    meta.appendChild(type);
    meta.appendChild(size);
    card.appendChild(meta);

    card.title = item.hls
      ? `${item.url}\n\nHLS 分片清单（m3u8）。点缩略图可直接播放；入库时由 LenTalk 用 ffmpeg 拉流合并成 mp4，会比普通视频慢一些。`
      : item.url;
    elements.grid.appendChild(card);
  });

  renderFilters();
}

function updateSummary() {
  const count = state.selected.size;
  if (!state.busy) {
    // notice 优先：它是「扫到 24 项」这类一次性说明，比「已选 0 项」有用得多。
    elements.summary.textContent = state.notice || `已选 ${count} 项`;
  }
  elements.import.disabled = state.busy || count === 0;
  elements.import.textContent = state.busy ? '入库中…' : `入库${count > 0 ? `（${count}）` : ''}`;
}

/** 扫描按钮在扫的时候必须有可见变化，否则用户以为点了没反应。 */
function setScanning(scanning) {
  elements.rescan.disabled = scanning;
  elements.rescan.textContent = scanning ? '扫描中…' : '重新扫描';
  if (scanning) {
    elements.grid.innerHTML = '';
    elements.empty.hidden = false;
    elements.empty.textContent = '正在扫描这个页面…';
  }
}

/** 扫完给一句看得见的结果，顺带说清各类各有多少。 */
function scanNotice() {
  const counts = countByType();
  const parts = [];
  ['image', 'video', 'audio'].forEach((kind) => {
    if (counts[kind] > 0) parts.push(`${MEDIA_LABEL[kind]} ${counts[kind]}`);
  });
  if (state.items.length === 0) return '没有找到可入库的素材';
  return `扫到 ${state.items.length} 项（${parts.join(' · ')}）`;
}

function showFailures(failures) {
  elements.failures.innerHTML = '';
  if (!failures || failures.length === 0) {
    elements.failures.hidden = true;
    return;
  }
  const title = document.createElement('p');
  // 不在这里猜原因：以前写死「跨域资源、站点不允许读取或需要登录」，实测把「网络不通」
  // 也归到那一类，反而误导排查。具体原因每条都跟着，比一句想当然的概括有用。
  title.textContent = `${failures.length} 项没能入库：`;
  elements.failures.appendChild(title);
  failures.forEach((failure) => {
    const line = document.createElement('p');
    line.textContent = `· ${failure.reason} — ${failure.url}`;
    elements.failures.appendChild(line);
  });
  elements.failures.hidden = false;
}

/* ------------------------------------------------------------------ *
 * 预览：视频/音频点缩略图直接播放
 *
 * 为什么不能只写一句 <video src={url}>：
 * 这个扩展存在的意义就是「站点靠 Referer 或登录态挡住的资源也得能拿到」，
 * 而 popup 里的 <video> 直链播放**恰恰带不了页面的 Referer** ——
 * 那正是防盗链站点放不出来的原因。所以顺序是：
 *   1. 先直链播：能边下边播，体验最好，公网资源多半直接就放出来了；
 *   2. 放不出来（触发 error）再走和入库完全同一条「页面上下文」通道，
 *      让**页面**去取字节（自带 Referer 与 cookie），转成 blob 播。
 * ------------------------------------------------------------------ */

const MIME_BY_EXTENSION = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

const peek = {
  /** 当前预览的条目。异步结果回来时用它判断用户是否已经换了别的。 */
  item: null,
  /** 页面通道取回的字节生成的对象地址，关闭时必须回收。 */
  blobUrl: '',
  /** 是否已经回落过一次 —— 直链失败会触发 error，别让它打转。 */
  fellBack: false,
  /** HLS 播放实例。关闭预览时必须 destroy，否则它的定时器会一直跑。 */
  hls: null,
};

const peekElements = {
  root: document.getElementById('peek'),
  title: document.getElementById('peek-title'),
  raw: document.getElementById('peek-raw'),
  close: document.getElementById('peek-close'),
  stage: document.getElementById('peek-stage'),
  note: document.getElementById('peek-note'),
};

function peekExtension(url) {
  try {
    const path = new URL(url).pathname;
    const index = path.lastIndexOf('.');
    return index < 0 ? '' : path.slice(index + 1).toLowerCase();
  } catch {
    return '';
  }
}

/** base64 → 字节。页面通道回传的就是 base64 字符串。 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 字节 → Blob。 */
function base64ToBlob(base64, contentType) {
  return new Blob([base64ToBytes(base64)], { type: contentType || 'application/octet-stream' });
}

/**
 * blob 的 MIME 决定了 <video> 认不认这个容器，而服务器给的常常不可信 ——
 * 不少 CDN 一律回 `application/octet-stream`，照它建 blob 会直接播不出来，
 * 所以这种情况按扩展名兜底。
 */
function peekContentType(item, fromServer) {
  const server = String(fromServer || '').split(';')[0].trim().toLowerCase();
  const generic = !server || server === 'application/octet-stream' || server === 'binary/octet-stream';
  if (!generic) return server;
  return MIME_BY_EXTENSION[peekExtension(item.url)] || (item.mediaType === 'audio' ? 'audio/mpeg' : 'video/mp4');
}

function setPeekNote(text) {
  peekElements.note.textContent = text || '';
  peekElements.note.hidden = !text;
}

function releasePeekUrl() {
  if (peek.blobUrl) {
    URL.revokeObjectURL(peek.blobUrl);
    peek.blobUrl = '';
  }
}

function closePeek() {
  // HLS 实例持有分片加载的定时器与请求，必须显式销毁；光把元素移出文档它不会停。
  if (peek.hls) {
    try {
      peek.hls.destroy();
    } catch {
      // 销毁失败无所谓，下面的引用一样会丢掉。
    }
    peek.hls = null;
  }
  // 先把 stage 清空：元素一离开文档，正在播的媒体自己就停了。
  peekElements.stage.innerHTML = '';
  releasePeekUrl();
  peek.item = null;
  peek.fellBack = false;
  peekElements.root.hidden = true;
  setPeekNote('');
}

function openPeek(item) {
  closePeek();
  peek.item = item;
  peekElements.root.hidden = false;
  peekElements.title.textContent = item.name || item.fileName || peekExtension(item.url) || '预览';
  peekElements.title.title = item.url;
  peekElements.raw.title = `在新标签页打开：${item.url}`;

  const media = document.createElement(item.mediaType === 'audio' ? 'audio' : 'video');
  media.controls = true;
  media.autoplay = true;
  media.referrerPolicy = 'no-referrer';
  if (item.poster && media.tagName === 'VIDEO') media.poster = item.poster;

  peekElements.stage.appendChild(media);

  // HLS 得另一条路：<video src="x.m3u8"> 在 Chrome 里必然播不了（原生不支持 HLS），
  // 直链失败的回落也救不了 —— 那时候取回来的是几 KB 的文本清单，不是视频。
  if (item.hls) {
    void openHlsPeek(item, media);
    return;
  }

  media.addEventListener('error', () => {
    void fallbackPeek(item, media);
  });
  media.src = item.url;
  // 自动播放被拦下也不影响使用：controls 还在，用户自己点一样能播。
  void media.play().catch(() => undefined);
}

/**
 * hls.js 的网络层：清单与分片的取字节都改走 **页面身份**通道。
 *
 * 为什么不能用手册里的默认 fetch：
 *   1. popup 的源是 `chrome-extension://`，直连站点的 m3u8/ts 是跨域请求，会被 CORS 拦；
 *   2. 而站点挡 HLS 分片最常用的手段就是校验 Referer —— 只有**页面自己**发出的请求
 *      才带着正确的 Referer 和登录态。
 * 这两点正好就是现有的「页面上下文取字节」通道，直接复用，不需要任何新权限。
 *
 * 页面通道拿不到时（比如资源在别的域且不允许带页面来源）再退回 popup 直取 ——
 * 公开的、开了 CORS 的流仍然能播。
 */
/**
 * hls.js 期望 loader 的 stats 是它内部那个**完整结构** —— 它会直接往
 * `stats.parsing.start`、`stats.loading.first`、`stats.buffering.*` 上赋值。
 * 少一个子对象，它当场抛 TypeError；而那个异常会被 loader 的 catch 兜成 onError，
 * 最终显示成「清单加载失败（status 0）」—— 看着像网络问题，其实是这里缺字段。
 */
function createLoaderStats() {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

class PageChannelLoader {
  constructor(config) {
    this.config = config || {};
    this.cancelled = false;
    this.stats = createLoaderStats();
  }

  /**
   * 清单（m3u8）要文本，分片/密钥要二进制 —— hls.js 对两者的期望不一样。
   *
   * ⚠️ 必须看 `responseType`，**不能**看 `context.type`：分片的 type 是 `'main'`
   * （PlaylistLevelType），不是 `'fragment'`。照 type 判断会把二进制分片当文本解码，
   * 喂进去的字节直接废掉，表现成 hls.js 报 "Failed to find demuxer by probing fragment data"
   * —— 看着像流格式有问题，其实是这里解码错了。
   */
  static wantsText(context) {
    if (context && context.responseType) {
      return context.responseType === 'text';
    }
    // 兜底：拿不到 responseType 时按扩展名认清单。
    return /\.m3u8?(\?|#|$)/i.test(String((context && context.url) || ''));
  }

  load(context, _config, callbacks) {
    const url = context.url;
    const wantsText = PageChannelLoader.wantsText(context);
    // 清单按字节区间切分的流（整支视频编成一个文件、每段只靠 Offset 区分），
    // 必须把 hls.js 给出的区间一路带到 fetch。丢掉它就会去拉整份文件 ——
    // 实测那个是 28 MB，当场撞上取字节的体积上限，表现成「预览一直转圈」。
    //
    // ⚠️ `rangeEnd` 是**开区间**（`start + length`），而 HTTP Range 的 end 是闭区间 ——
    // hls.js 自带的 XhrLoader / FetchLoader 都做了 `rangeEnd - 1` 这一步。漏掉它，每个
    // 分片就会多取 1 个字节，末尾挂着下一个 box 的首字节：init 段解析到 moov 就收手，
    // 忍得过去；媒体分片则会让 MSE 当场报 SourceBuffer error（TS 分片有 transmux 兜着，
    // 只有 fMP4 必崩）。单文件切片型清单正是「分片同地址 + BYTERANGE」，
    // 所以这条路上只要差一个字节就一定失败。
    const range =
      Number.isFinite(context.rangeStart) && Number.isFinite(context.rangeEnd)
        ? { start: context.rangeStart, end: context.rangeEnd - 1 }
        : null;
    // 用 performance.now()：hls.js 内部也用它算耗时，别把两套时钟混在一起。
    const started = performance.now();
    const stats = createLoaderStats();
    this.cancelled = false;
    this.stats = stats;

    hlsFetchBytes(url, state.tabId, range)
      .then((result) => {
        if (this.cancelled) return;
        const finished = performance.now();
        const size = result.bytes.byteLength;
        stats.chunkCount = 1;
        stats.loaded = size;
        stats.total = size;
        stats.loading.start = started;
        stats.loading.first = finished;
        stats.loading.end = finished;
        stats.parsing.start = finished;
        stats.parsing.end = finished;
        stats.buffering.start = finished;
        stats.buffering.end = finished;
        // 带宽估计（bit/s）：hls.js 拿它决定拉多快，保守点没坏处。
        stats.bwEstimate = (size * 8 * 1000) / Math.max(1, finished - started);

        callbacks.onSuccess(
          {
            url,
            // 分片必须是 ArrayBuffer：hls.js 的 transmuxer 直接按二进制解，给字符串会崩。
            data: wantsText ? new TextDecoder().decode(result.bytes) : result.bytes.buffer,
            code: 200,
          },
          stats,
          context
        );
      })
      .catch((error) => {
        if (this.cancelled) return;
        callbacks.onError({ code: 0, text: describeLoadFailure(error) }, context);
      });
  }

  abort() {
    this.cancelled = true;
    this.stats.aborted = true;
  }

  destroy() {
    this.cancelled = true;
  }
}

/**
 * HLS 取字节。带 `range` 时按字节区间取 —— 分片常常只是一个大文件里的一小段，
 * 丢掉区间就会把整个文件拖下来，既慢又必然超限。
 *
 * 优先走页面通道：Referer 与登录态都在，跨域也由站点自己放行。失败才回落到 popup
 * 直取 —— 但 popup 的源是 `chrome-extension://`，只对开了 `*` 的公开 CDN 有效；
 * 像 Pinterest 那种只放行自己站点的 CDN（`allow-origin: https://www.pinterest.com`），
 * 回落这条路必被 CORS 拦，真正干活的是页面通道。
 */
async function hlsFetchBytes(url, tabId, range) {
  let inPageError = '';
  try {
    const message = { type: 'lentalk:preview', url, tabId };
    if (range) message.range = range;
    const response = await chrome.runtime.sendMessage(message);
    if (response && response.ok) {
      return { bytes: base64ToBytes(response.base64) };
    }
    inPageError = (response && response.error) || '页面通道取不到';
  } catch (error) {
    inPageError = String((error && error.message) || error);
  }

  // 回落：popup 直取。公开资源、开了 CORS 的 CDN 在这里能过。
  try {
    const direct = await fetch(
      url,
      range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : undefined
    );
    if (!direct.ok) throw new Error(`HTTP ${direct.status}`);
    return { bytes: new Uint8Array(await direct.arrayBuffer()) };
  } catch (error) {
    const directMessage = String((error && error.message) || error);
    throw new Error(`${inPageError}；直取也失败（${directMessage}）`);
  }
}

function describeLoadFailure(error) {
  const message = String((error && error.message) || error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return `${message}（分片被 CORS 或防盗链拦下）`;
  }
  return message;
}

/**
 * HLS 预览：交给 hls.js 逐段取回、转封装后喂给 MSE。
 *
 * 注意 `enableWorker: false` —— 扩展页面的默认 CSP 不允许 blob: worker，
 * hls.js 会创建失败并退回主线程（它自己能兜住，但先关掉少一次无谓的报错）。
 */
async function openHlsPeek(item, media) {
  const Hls = window.Hls;
  if (!Hls || typeof Hls.isSupported !== 'function' || !Hls.isSupported()) {
    setPeekNote('这个浏览器不支持 HLS 播放（缺少 MediaSource），点「原链」可在新标签页打开。');
    return;
  }

  setPeekNote('正在读取 HLS 清单…');

  const hls = new Hls({ loader: PageChannelLoader, enableWorker: false });
  peek.hls = hls;

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (peek.item !== item) return;
    setPeekNote('');
    void media.play().catch(() => undefined);
  });

  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (peek.item !== item || peek.hls !== hls) return;
    // 非致命错误 hls.js 自己会重试或跳段（某个分片 404 很常见），不必打扰用户。
    if (!data || !data.fatal) return;

    const parts = [data.details || '', data.reason || ''];
    // hls.js 会把底层异常塞在 data.error 里，不带上就只剩一句 "manifestLoadError" 看不出所以然。
    if (data.error) parts.push(String(data.error.message || data.error));
    const detail = describeLoadFailure({ message: parts.filter(Boolean).join(' ') });
    const hint =
      data.type === Hls.ErrorTypes.NETWORK_ERROR
        ? '取不到分片 —— 常见原因是站点对分片做了防盗链或登录校验。'
        : '这个流的编码封装解不开。';
    setPeekNote(`${hint}\n${detail}\n可以点右上角「原链」在新标签页打开。`);

    try {
      hls.destroy();
    } catch {
      // 无所谓，下面的引用一样会丢掉。
    }
    if (peek.hls === hls) peek.hls = null;
  });

  hls.attachMedia(media);
  hls.loadSource(item.url);
}

/**
 * 直链放不出来时的回落：让页面去取字节（带 Referer 与登录态），转成 blob 播。
 * 只回落一次；结果回来时用户可能已经关掉预览或点了别的条目，所以每步都要重新核对。
 */
async function fallbackPeek(item, media) {
  if (peek.fellBack || peek.item !== item) return;
  peek.fellBack = true;
  setPeekNote('直链放不出来，正在以页面身份读取原文件…');

  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: 'lentalk:preview', url: item.url, tabId: state.tabId });
  } catch (error) {
    response = { ok: false, error: String(error && error.message ? error.message : error) };
  }

  if (peek.item !== item) return;

  if (!response || !response.ok) {
    setPeekNote(
      response && response.tooLarge
        ? '这个文件超过预览上限（16 MB），预览只读取小文件。可以点「原链」在新标签页打开，或直接入库后在应用里看。'
        : `读不到原文件：${(response && response.error) || '未知原因'}`
    );
    return;
  }

  releasePeekUrl();
  peek.blobUrl = URL.createObjectURL(base64ToBlob(response.base64, peekContentType(item, response.contentType)));
  media.src = peek.blobUrl;
  media.load();
  void media.play().catch(() => undefined);
  setPeekNote(`直链播不了（站点校验来源），已改用页面身份读取原文件：${formatBytes(response.size)}`);
}

peekElements.close.addEventListener('click', () => {
  closePeek();
});

peekElements.raw.addEventListener('click', () => {
  if (peek.item) void chrome.tabs.create({ url: peek.item.url });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !peekElements.root.hidden) closePeek();
});

async function loadLibrary() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'lentalk:library' });
    if (response && response.ok) {
      renderCategoryOptions(response.library);
      const stored = await chrome.storage.local.get(CATEGORY_STORAGE_KEY);
      const preferred = stored ? stored[CATEGORY_STORAGE_KEY] : '';
      if (preferred && elements.category.querySelector(`option[value="${preferred}"]`)) {
        elements.category.value = preferred;
      }
      return true;
    }
    renderCategoryOptions(null);
    return false;
  } catch {
    renderCategoryOptions(null);
    return false;
  }
}

async function init() {
  // 重新扫描后条目会全部换新，还挂着的预览（以及它引用的对象地址）必须一起收掉。
  closePeek();
  showFailures([]);
  setScanning(true);
  setStatus('正在扫描页面…');

  try {
    // 先连通道，再扫页面：连不上时用户第一眼就该知道，而不是扫完了才发现存不进去。
    const connected = await loadLibrary();
    const status = connected ? await chrome.runtime.sendMessage({ type: 'lentalk:status' }) : null;
    if (connected && status && status.ok && status.bridge) {
      setStatus(`已连接 LenTalk${status.bridge.version ? ` v${status.bridge.version}` : ''}`, 'ok');
    } else {
      setStatus('未检测到 LenTalk，请先启动应用', 'error');
    }

    try {
      state.items = await scanActiveTab();
    } catch (error) {
      state.items = [];
      setStatus(`无法扫描此页面：${error && error.message ? error.message : error}`, 'error');
    }

    // 默认一个都不选：扫描只是把可选项摆出来，入库得由用户自己挑。
    state.selected = new Set();
    // 上次筛选的那一类这次可能一个都没有，别让用户对着空网格发愣。
    if (state.filter !== 'all' && (countByType()[state.filter] || 0) === 0) {
      state.filter = 'all';
    }
    state.notice = scanNotice();
    renderGrid();
    updateSummary();
  } finally {
    setScanning(false);
  }
}

async function runImport() {
  if (state.busy) return;
  // 按 state.items 的顺序取，保证入库顺序和网格里看到的顺序一致。
  const items = state.items.filter((item) => state.selected.has(item.url) && isImportable(item));
  if (items.length === 0) return;

  const categoryId = elements.category.value;
  await chrome.storage.local.set({ [CATEGORY_STORAGE_KEY]: categoryId });

  state.busy = true;
  state.notice = '';
  showFailures([]);
  elements.summary.textContent = `正在入库 0/${items.length}…`;
  updateSummary();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'lentalk:upload',
      items,
      categoryId,
      tabId: state.tabId,
    });
    if (!response || !response.ok) {
      state.notice = '';
      setStatus((response && response.error) || '入库失败', 'error');
      return;
    }
    const failures = response.failures || [];
    const parts = [`已入库 ${response.imported}/${response.total} 项`];
    if (response.bytes) parts.push(formatBytes(response.bytes));
    if (failures.length) parts.push(`${failures.length} 项失败`);
    // 成功的那些取消勾选，失败的留着——用户想重试就不用再挑一遍。
    const failed = new Set(failures.map((failure) => failure.url));
    items.forEach((item) => {
      if (!failed.has(item.url)) state.selected.delete(item.url);
    });
    state.notice = parts.join(' · ');
    showFailures(failures);
    if (failures.length) setStatus('部分素材没能入库，原因见下方', 'error');
  } catch (error) {
    state.notice = '';
    setStatus(`入库失败：${error && error.message ? error.message : error}`, 'error');
  } finally {
    state.busy = false;
    renderGrid();
    updateSummary();
  }
}

elements.import.addEventListener('click', () => {
  void runImport();
});

elements.rescan.addEventListener('click', () => {
  void init();
});

elements.selectAll.addEventListener('click', () => {
  // 只选**当前看得见**的那些 —— 筛选到「视频」时按全选却勾走了图片，那才叫意外。
  visibleItems().forEach((item) => {
    if (isImportable(item)) state.selected.add(item.url);
  });
  state.notice = '';
  renderGrid();
  updateSummary();
});

elements.selectNone.addEventListener('click', () => {
  visibleItems().forEach((item) => state.selected.delete(item.url));
  state.notice = '';
  renderGrid();
  updateSummary();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'lentalk:progress' && state.busy) {
    elements.summary.textContent = `正在入库 ${message.done}/${message.total}…`;
  }
});

void init();
