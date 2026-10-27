/**
 * 参考素材图床(知鸟 AI)—— 多个平台的共用前置步骤。
 *
 * ## 哪些平台需要它
 *
 * | 平台 | 上传接口 | 参考素材可接受的写法 |
 * |---|---|---|
 * | 筷子AI(aiopenapi.kuaizi.cn) | **没有** | `http(s)://` 或本平台 `asset://<Id>`, 拒 base64 |
 * | likeai520(api.likeai520.cc) | **没有** | 公网 HTTPS |
 *
 * 两家都只收公网 URL, 而画布上的参考素材绝大多数是本地文件 / data URL /
 * `asset://localhost/…` 预览地址。所以链路统一成:
 *
 *   本地文件 → 知鸟 `/v1/files`(multipart) → 公网直链
 *
 * 筷子额外还要把直链登记成 `asset://<Id>`(见 `kuaiziReferences.ts`) —— 那是平台自己的
 * 素材库, 与本模块无关。
 *
 * ## 为什么是知鸟
 *
 * 它已经在平台列表里、已经有 Key(`/v1/files` 是现成的 multipart 上传), 零新增配置。
 * 换成腾讯云 COS / 阿里 OSS 只需要替换 `uploadReferenceViaImageHost` 一个函数。
 */
import { uploadZhiniaoReferenceAsset } from '@/commands/ai';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ImageHostConfig {
  baseUrl: string;
  apiKey: string;
}

/** 站点根地址: 去掉结尾斜杠与 /v1 后缀, 避免拼出 /v1/v1/… */
export function toSiteRootBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

/**
 * 解析图床(知鸟 AI)配置。
 *
 * 缺配置时**必须显式报错**: 把本地素材原样发下去, 上游只会回一句
 * `must start with http://…` 或干脆异步 failed, 用户完全看不出是「没配图床」。
 */
export function resolveImageHostConfig(): ImageHostConfig {
  const store = useSettingsStore.getState();
  const zhiniao = store.customApis.find((api) =>
    /(?:cuai\.token6688\.com|api\.tokengo\.love)/i.test(api.baseUrl ?? ''),
  );
  if (!zhiniao) {
    throw new Error(
      '该平台的参考素材只收公网 URL(不支持 base64), 本地素材需要先上传到图床。请在「设置 → 密钥 → 推荐平台」里添加并填写「知鸟 AI」——它在这里充当共用图床。',
    );
  }
  const apiKey = (store.apiKeys[`custom:${zhiniao.id}`] ?? '').trim();
  if (!apiKey) {
    throw new Error(
      `该平台的参考素材需要先上传图床, 但「知鸟 AI」(${zhiniao.name}) 的 API Key 是空的。请在「设置 → 密钥」里补上知鸟 AI 的 Key。`,
    );
  }
  const baseUrl = toSiteRootBaseUrl(zhiniao.baseUrl ?? '');
  if (!baseUrl) {
    throw new Error('「知鸟 AI」平台缺少 Base URL, 无法作为图床使用。');
  }
  return { baseUrl, apiKey };
}

/**
 * 已经是公网地址 —— 直接透传。
 *
 * ⚠ `http://asset.localhost/…` 与 `asset://localhost/…` 是 **Tauri 的本地预览协议**,
 * 看着像 URL 其实上游读不到, 必须先还原本地路径再上传。这里刻意不把它们算进来。
 */
export function isPublicHttpUrl(source: string): boolean {
  const trimmed = source.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return !lower.includes('asset.localhost') && !lower.startsWith('asset://');
}

/** 单条本地素材 → 公网直链。失败错误里带序号, 便于定位是哪一张。 */
export async function uploadReferenceViaImageHost(
  source: string,
  index: number,
  host: ImageHostConfig = resolveImageHostConfig(),
): Promise<string> {
  if (isPublicHttpUrl(source)) return source.trim();
  return await uploadZhiniaoReferenceAsset(
    source,
    host.baseUrl,
    { Authorization: `Bearer ${host.apiKey}` },
    index,
  );
}

export interface PublicUrlReferenceInput {
  images?: string[];
  audios?: string[];
  /** 平台按模型限定的条数上限(超出先裁掉, 避免白上传)。 */
  maxImages?: number;
  maxAudios?: number;
}

/**
 * 批量把参考素材换成公网直链。
 *
 * 只做「本地 → 公网 URL」, 不做平台侧登记 —— likeai520 这类只要 URL 的平台直接用它;
 * 需要 `asset://` 的(筷子AI)在拿到 URL 之后再走自己的登记逻辑。
 */
export async function uploadReferencesViaImageHost(
  input: PublicUrlReferenceInput,
): Promise<{ images: string[]; audios: string[] }> {
  const images = (input.images ?? []).filter((item) => item?.trim()).slice(0, input.maxImages ?? 30);
  const audios = (input.audios ?? []).filter((item) => item?.trim()).slice(0, input.maxAudios ?? 10);
  if (images.length === 0 && audios.length === 0) return { images: [], audios: [] };
  const host = resolveImageHostConfig();
  const resolveAll = async (sources: string[], label: string) =>
    await Promise.all(
      sources.map(async (source, index) => {
        try {
          return await uploadReferenceViaImageHost(source, index, host);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`参考${label}第 ${index + 1} 条上传图床失败: ${reason}`);
        }
      }),
    );
  return {
    images: await resolveAll(images, '图'),
    audios: await resolveAll(audios, '音频'),
  };
}
