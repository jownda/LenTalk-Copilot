/**
 * 筷子AI(aiopenapi.kuaizi.cn)参考素材落地。
 *
 * ## 为什么需要这一层
 *
 * 筷子视频接口对 `content[].image_url.url` / `audio_url.url` 有**格式白名单**
 * (《视频生成 兼容接口文档》v1.4 起): 只接受 `http://`、`https://`、`asset://<Id>`
 * 三种前缀, 单条上限 4000 字符, 其余一律**在创建任务时同步 400**
 * (`… must start with http://, https:// or asset://, got "data:image/jpeg;base64,…"`)。
 *
 * 而画布上的参考素材绝大多数是本地文件 / data URL / `asset://localhost/…` 预览地址。
 * 所以链路必须是:
 *
 *   本地文件 → 知鸟 AI 图床 `/v1/files` 换公网直链 → 可选 CreateAsset 登记成
 *   `asset://<Id>` → 提交
 *
 * ## 为什么还要 CreateAsset
 *
 * 图床直链(知鸟)是**临时签名地址**。直接把它交给筷子也能跑, 但素材是「用时才下载」,
 * 一旦链接过期 / 限流就是 `DownloadFailed`, 而且错误发生在异步任务里, 界面只能看到
 * 「平台未给出原因」。CreateAsset 是让筷子**立刻把文件复制进自己的素材库**, 之后
 * 用永久有效的 `asset://<Id>` 引用, 与图床的时效解耦。
 *
 * 因此本模块的策略是「**登记成功就用 asset://, 登记不了就用直链**」——
 * 登记失败(接口未开通 / 素材审核中 / 轮询超时)绝不阻断生成, 只降级。
 *
 * ## 图床为什么是知鸟
 *
 * 筷子**没有上传接口** —— `CreateAsset` 的入参也是 `URL`(它去下载), 不是文件字节。
 * 所以本地素材绕不开一个第三方图床。这里直接复用已经接好的知鸟 AI(`/v1/files`),
 * 零新增配置; 换腾讯云 COS 只需替换 `uploadViaImageHost` 一个函数。
 */
import { requestProviderJson } from '@/commands/ai';
import {
  isPublicHttpUrl,
  resolveImageHostConfig,
  toSiteRootBaseUrl,
  uploadReferenceViaImageHost,
} from './imageHostReferences';

const KZ_ASSET_PATH = '/ai-open-platform-api/api/support/v1/asset';
/** 素材组名: 复用同名组, 避免每台机器每次会话都新建一个空组。 */
const KZ_ASSET_GROUP_NAME = 'LenTalk';
/** 单条素材的登记等待上限: 筷子侧是异步落库(Processing → Active), 一般 1~3 秒。 */
const KZ_ASSET_POLL_ATTEMPTS = 10;
const KZ_ASSET_POLL_INTERVAL_MS = 1500;

export type KuaiziReferenceKind = 'Image' | 'Audio' | 'Video';

export interface KuaiziImageHost {
  baseUrl: string;
  apiKey: string;
}

/**
 * 图床配置(知鸟 AI)—— 与 likeai520 共用同一份解析, 见 `imageHostReferences.ts`。
 *
 * 缺配置时**必须显式报错**, 不能把本地文件原样发下去 —— 上游只会回一句
 * `must start with http://…`, 用户完全看不出是「没配图床」。
 */
export function resolveKuaiziImageHost(): KuaiziImageHost {
  return resolveImageHostConfig();
}

interface KuaiziAssetActionOptions {
  baseUrl: string;
  apiKey: string;
}

interface KuaiziAssetResponse {
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  Result?: Record<string, unknown>;
}

/** 调一次素材资产管理 Action(`?Action=Xxx&Version=2024-01-01`), 返回 Result。 */
async function callAssetAction(
  options: KuaiziAssetActionOptions,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${toSiteRootBaseUrl(options.baseUrl)}${KZ_ASSET_PATH}?Action=${action}&Version=2024-01-01`;
  // 素材接口用 `ApiKey` 头(不是 Bearer), 与视频接口不同 —— 见文档「鉴权方式」。
  const response = await requestProviderJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ApiKey: options.apiKey },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: KuaiziAssetResponse | null = null;
  try {
    payload = raw ? (JSON.parse(raw) as KuaiziAssetResponse) : null;
  } catch {
    throw new Error(`筷子AI 素材接口返回了非 JSON 响应 (${action})`);
  }
  if (!response.ok) {
    throw new Error(`筷子AI 素材接口 ${action} 失败: HTTP ${response.status} ${raw.slice(0, 300)}`);
  }
  const remoteError = payload?.ResponseMetadata?.Error;
  if (remoteError?.Code) {
    throw new Error(`筷子AI 素材接口 ${action} 失败: ${remoteError.Code} ${remoteError.Message ?? ''}`.trim());
  }
  return payload?.Result ?? {};
}

/**
 * 素材登记在本次会话里是否已经确定不可用。
 *
 * 有些 ApiKey 没开素材管理权限(或组已满), 那种失败是**确定性**的: 每张图都多打两次
 * 请求只会拖慢生成。第一次硬失败后就整体降级成「直链直传」, 直到重启应用。
 */
let assetRegistrationDisabledReason: string | null = null;
/** 已建好的素材组 id, 按 baseUrl 记 —— 素材组是平台侧资源, 跨请求复用。 */
const assetGroupIdCache = new Map<string, string>();

async function ensureAssetGroup(options: KuaiziAssetActionOptions): Promise<string> {
  const cacheKey = toSiteRootBaseUrl(options.baseUrl);
  const cached = assetGroupIdCache.get(cacheKey);
  if (cached) return cached;
  // 先按名字找, 找到就复用 —— 否则每个新会话都会在平台上堆一个空组。
  const listed = await callAssetAction(options, 'ListAssetGroups', {
    Filter: { Name: KZ_ASSET_GROUP_NAME, GroupType: 'AIGC' },
    PageNumber: 1,
    PageSize: 10,
  });
  const items = Array.isArray(listed.Items) ? (listed.Items as Array<Record<string, unknown>>) : [];
  const existing = items.find((item) => String(item.Name ?? '') === KZ_ASSET_GROUP_NAME);
  const existingId = existing?.Id;
  if (typeof existingId === 'string' && existingId) {
    assetGroupIdCache.set(cacheKey, existingId);
    return existingId;
  }
  const created = await callAssetAction(options, 'CreateAssetGroup', {
    Name: KZ_ASSET_GROUP_NAME,
    Description: 'LenTalk 画布参考素材(自动创建)',
    GroupType: 'AIGC',
  });
  const createdId = created.Id;
  if (typeof createdId !== 'string' || !createdId) {
    throw new Error('筷子AI 创建素材组没有返回 Id');
  }
  assetGroupIdCache.set(cacheKey, createdId);
  return createdId;
}

/**
 * 把一条公网 URL 登记成平台素材, 返回 `asset://<Id>`。
 *
 * 失败一律抛出 —— 由调用方决定是「降级用直链」还是「中断」。
 */
async function registerAsset(
  options: KuaiziAssetActionOptions,
  publicUrl: string,
  kind: KuaiziReferenceKind,
  index: number,
): Promise<string> {
  const groupId = await ensureAssetGroup(options);
  const created = await callAssetAction(options, 'CreateAsset', {
    GroupId: groupId,
    URL: publicUrl,
    AssetType: kind,
    Name: `lentalk-${kind.toLowerCase()}-${Date.now()}-${index + 1}`,
  });
  const assetId = created.Id;
  if (typeof assetId !== 'string' || !assetId) {
    throw new Error('筷子AI 创建素材没有返回 Id');
  }
  // 落库即返回 Id, 素材随后异步处理: 必须等到 Active 才能被视频接口引用。
  for (let attempt = 0; attempt < KZ_ASSET_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, KZ_ASSET_POLL_INTERVAL_MS));
    }
    const asset = await callAssetAction(options, 'GetAsset', { Id: assetId });
    const status = String(asset.Status ?? '').toLowerCase();
    if (status === 'active') return `asset://${assetId}`;
    if (status === 'failed') {
      const error = asset.Error as { Code?: string; Message?: string } | undefined;
      throw new Error(`素材处理失败: ${error?.Code ?? '未知'} ${error?.Message ?? ''}`.trim());
    }
  }
  throw new Error('素材登记超时(仍未变成 Active)');
}

/** 已经可以直接交给平台的写法: 公网 URL, 或用户自己贴的本平台 asset:// 引用。 */
function isDirectlyUsableReference(source: string): boolean {
  const trimmed = source.trim();
  if (isPublicHttpUrl(trimmed)) return true;
  // ⚠ 只认 `asset://<十进制 Id>`。画布本地的预览地址是 `asset://localhost/…` /
  // `http://asset.localhost/…`, 那是**我们自己的**协议, 交给筷子会被当成它那边的
  // 素材 Id 而报「素材不存在」—— 必须继续走上传。
  return /^asset:\/\/\d+$/.test(trimmed);
}

async function resolveOne(
  source: string,
  kind: KuaiziReferenceKind,
  index: number,
  imageHost: KuaiziImageHost,
  kuaizi: KuaiziAssetActionOptions | null,
): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed) return trimmed;
  if (isDirectlyUsableReference(trimmed)) return trimmed;
  // 本地素材(绝对路径 / file:// / asset://localhost / data URL / 裸 base64)
  // 统一走图床上传换公网直链。
  const publicUrl = await uploadReferenceViaImageHost(trimmed, index, imageHost);
  if (!kuaizi || assetRegistrationDisabledReason) return publicUrl;
  try {
    return await registerAsset(kuaizi, publicUrl, kind, index);
  } catch (error) {
    // 登记失败不阻断生成: 直链本来就在白名单里, 只是会随图床时效失效。
    assetRegistrationDisabledReason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[kuaizi] 素材登记失败, 本次及后续请求改用图床直链: ${assetRegistrationDisabledReason}`,
    );
    return publicUrl;
  }
}

export interface KuaiziReferenceInput {
  images?: string[];
  audios?: string[];
  /** 筷子平台自己的 Base URL 与 ApiKey(素材接口鉴权用)。 */
  kuaiziBaseUrl?: string;
  kuaiziApiKey?: string;
  /** 该模型的素材条数上限(见 `kuaiziModels.ts` 的分档表)。 */
  maxImages?: number;
  maxAudios?: number;
}

/**
 * 把画布上的参考素材解析成筷子能接受的写法(公网 URL 或 `asset://<Id>`)。
 *
 * ⚠ 提交侧(ark.rs)还有一份条数裁剪 —— 这里先裁是为了**不白上传**超限的素材。
 */
export async function resolveKuaiziVideoReferences(
  input: KuaiziReferenceInput,
): Promise<{ images: string[]; audios: string[] }> {
  const images = (input.images ?? []).filter((item) => item?.trim()).slice(0, input.maxImages ?? 30);
  const audios = (input.audios ?? []).filter((item) => item?.trim()).slice(0, input.maxAudios ?? 3);
  if (images.length === 0 && audios.length === 0) return { images: [], audios: [] };
  const imageHost = resolveKuaiziImageHost();
  const kuaiziOptions: KuaiziAssetActionOptions | null =
    input.kuaiziBaseUrl && input.kuaiziApiKey
      ? { baseUrl: input.kuaiziBaseUrl, apiKey: input.kuaiziApiKey }
      : null;
  const resolveAll = async (sources: string[], kind: KuaiziReferenceKind) =>
    await Promise.all(
      sources.map(async (source, index) => {
        try {
          return await resolveOne(source, kind, index, imageHost, kuaiziOptions);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `筷子AI 参考${kind === 'Image' ? '图' : '素材'}第 ${index + 1} 条上传失败: ${reason}`,
          );
        }
      }),
    );
  return {
    images: await resolveAll(images, 'Image'),
    audios: await resolveAll(audios, 'Audio'),
  };
}

/** 仅测试用: 清掉会话级缓存。 */
export function resetKuaiziAssetRegistrationState(): void {
  assetRegistrationDisabledReason = null;
  assetGroupIdCache.clear();
}
