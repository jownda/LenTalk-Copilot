import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { X, Eye, EyeOff, Pencil, Plus, Trash2, ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buildCustomModelId, isAudioModelName, isChatCompletionModelName, isVideoGenerationModelName, useSettingsStore } from '@/stores/settingsStore';
import type { CustomApiCapabilities, CustomApiProvider } from '@/stores/settingsStore';
import { detectProviderCapabilities, fetchProviderModels, verifyProviderUrl, jimengCliLoginStart, jimengCliLoginCheck, jimengCliLogout, jimengCliDetect, jimengCliInstall } from '@/commands/ai';
import {
  formatProviderBalance,
  queryJimengCliCredit,
  queryProviderBalance,
  type JimengCliCredit,
  type ProviderBalance,
} from '@/commands/balance';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  findRecommendedApiByBaseUrl,
  listVisibleRecommendedApis,
  visibleRecommendedApiIds,
  type RecommendedApi,
} from '@/features/settings/recommendedApis';
import { UiCheckbox, UiModal, UiSelect } from '@/components/ui';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { listModelProviders } from '@/features/canvas/models';
import type { SettingsCategory } from '@/features/settings/settingsEvents';
import { WanCliSettings } from '@/features/settings/WanCliSettings';
import { isZhenjianProvider } from '@/commands/zhenjianApi';

const JIMENG_LOGIN_POLL_INTERVAL_MS = 3000;
const JIMENG_LOGIN_MAX_ATTEMPTS = 200;

const JIMENG_LOGIN_NO_PERMISSION_MESSAGE = 'OAuth 授权成功，但当前账号没有 dreamina_cli 使用权限（仅限高级或高级以上的会员等级）。请升级会员后重试。';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
  onCheckUpdate?: () => Promise<'has-update' | 'up-to-date' | 'failed'>;
}

interface SettingsCheckboxCardProps {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const PROVIDER_REGISTER_URLS: Record<string, string> = {
  ppio: 'https://ppio.com/user/register?invited_by=WGY0DZ',
  grsai: 'https://grsai.com',
  kie: 'https://kie.ai?ref=eef20ef0b0595cad227d45b29c635f6c',
  fal: 'https://fal.ai',
};

const PROVIDER_GET_KEY_URLS: Record<string, string> = {
  ppio: 'https://ppio.com/settings/key-management',
  grsai: 'https://grsai.com/zh/dashboard/api-keys',
  kie: 'https://kie.ai/api-key',
  fal: 'https://fal.ai/dashboard/keys',
};

// 内置平台简介(原 provider-guide.md 引导面板的内容,直接写在对应模型卡片底下)
const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  kie: '价格和稳定性都还不错,国内用户可以去账单页面申请一些优惠',
  ppio: '价格没啥优惠,但是比较稳定,该供应商仅支持 Nano Banana 2',
  fal: '比较适合国外用户,价格没啥优惠,但胜在稳定正规',
  grsai: '虽然价格便宜,但是不太稳定,如果一直报错,建议使用别的供应商。注意接入点的区别,不是所有接入点都便宜',
};

function SettingsCheckboxCard({
  title,
  description,
  checked,
  onCheckedChange,
}: SettingsCheckboxCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onCheckedChange(!checked)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onCheckedChange(!checked);
        }
      }}
      className="w-full rounded-lg border border-border-dark bg-bg-dark p-4 text-left transition-colors hover:border-[rgba(255,255,255,0.2)]"
    >
      <div className="flex items-start gap-3">
        <UiCheckbox
          checked={checked}
          onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
          onClick={(event) => event.stopPropagation()}
          className="mt-0.5 shrink-0"
        />
        <div>
          <h3 className="text-sm font-medium text-text-dark">{title}</h3>
          <p className="mt-1 text-xs text-text-muted">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog({
  isOpen,
  onClose,
  initialCategory = 'general',
  onCheckUpdate,
}: SettingsDialogProps) {
  const { t, i18n } = useTranslation();
  const {
    apiKeys,
    customApis,
    jimengCli,
    jimengCliAutoInstallStatus,
    useUploadFilenameAsNodeTitle,
    storyboardGenKeepStyleConsistent,
    storyboardGenDisableTextInImage,
    storyboardGenAutoInferEmptyFrame,
    ignoreAtTagWhenCopyingAndGenerating,
    enableStoryboardGenGridPreviewShortcut,
    showStoryboardGenAdvancedRatioControls,
    showNodePrice,
    priceDisplayCurrencyMode,
    usdToCnyRate,
    uiRadiusPreset,
    themeTonePreset,
    accentColor,
    canvasEdgeRoutingMode,
    autoCheckAppUpdateOnLaunch,
    enableUpdateDialog,
    setProviderApiKey,
    setJimengCliExecutable,
    setJimengCliAutoInstallStatus,
    addCustomApi,
    updateCustomApi,
    removeCustomApi,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setShowNodePrice,
    setPriceDisplayCurrencyMode,
    setUsdToCnyRate,
    setUiRadiusPreset,
    setThemeTonePreset,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    setAutoCheckAppUpdateOnLaunch,
    setEnableUpdateDialog,
  } = useSettingsStore();
  const providers = useMemo(() => {
    const providerOrder = ['zhiniao', 'zhenjian', 'runninghub', 'runninghub-cn', 'modelscope'];
    const providerIndex = new Map(providerOrder.map((id, index) => [id, index]));
    // 密钥页展示内置推荐平台，帧间 API 也在这里提供专有链路配置。
    // 隐藏 ≠ 删除: 平台定义与链路仍完整保留在 registry / recommendedApis 中,
    // 自定义平台按 Base URL 依旧会命中对应链路(isZhiniao / isZzdh / isSub2Api 等)。
    const visibleProviderIds = new Set(visibleRecommendedApiIds);
    return (
      listModelProviders()
        .filter((provider) => !provider.id.startsWith('custom:'))
        .filter((provider) => visibleProviderIds.has(provider.id))
        .slice()
        .sort((left, right) => {
          const leftIndex = providerIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
          const rightIndex = providerIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
          return leftIndex - rightIndex;
        })
    );
  }, []);
  /** 「推荐平台」网格实际渲染的卡片(隐藏条目仍保留配置, 只是不展示)。 */
  const visibleRecommendedApis = useMemo(() => listVisibleRecommendedApis(), []);

  /** 推荐平台 id → 已连接的配置记录（按 Base URL 匹配）。 */
  const connectedRecommendedApis = useMemo(() => {
    const map = new Map<string, CustomApiProvider>();
    for (const customApi of customApis) {
      const matched = findRecommendedApiByBaseUrl(customApi.baseUrl);
      if (matched && !map.has(matched.id)) {
        map.set(matched.id, customApi);
      }
    }
    return map;
  }, [customApis]);
  /**
   * 推荐平台的配置记录仍复用统一的运行时模型注册，但不应在「自定义平台」重复展示。
   * 仅隐藏当前「推荐平台」实际展示的四个预设；其他推荐预设或手工配置保持可见。
   */
  const visibleCustomApis = useMemo(
    () => customApis.filter((api) => {
      const recommendedApi = findRecommendedApiByBaseUrl(api.baseUrl);
      return !recommendedApi || !visibleRecommendedApiIds.includes(recommendedApi.id);
    }),
    [customApis],
  );
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const [localApiKeys, setLocalApiKeys] = useState<Record<string, string>>(apiKeys);
  const [localUseUploadFilenameAsNodeTitle, setLocalUseUploadFilenameAsNodeTitle] = useState(
    useUploadFilenameAsNodeTitle
  );
  const [localStoryboardGenKeepStyleConsistent, setLocalStoryboardGenKeepStyleConsistent] =
    useState(storyboardGenKeepStyleConsistent);
  const [localStoryboardGenDisableTextInImage, setLocalStoryboardGenDisableTextInImage] = useState(
    storyboardGenDisableTextInImage
  );
  const [localStoryboardGenAutoInferEmptyFrame, setLocalStoryboardGenAutoInferEmptyFrame] = useState(
    storyboardGenAutoInferEmptyFrame
  );
  const [localIgnoreAtTagWhenCopyingAndGenerating, setLocalIgnoreAtTagWhenCopyingAndGenerating] =
    useState(ignoreAtTagWhenCopyingAndGenerating);
  const [localEnableStoryboardGenGridPreviewShortcut, setLocalEnableStoryboardGenGridPreviewShortcut] =
    useState(enableStoryboardGenGridPreviewShortcut);
  const [localShowStoryboardGenAdvancedRatioControls, setLocalShowStoryboardGenAdvancedRatioControls] =
    useState(showStoryboardGenAdvancedRatioControls);
  const [localShowNodePrice, setLocalShowNodePrice] = useState(showNodePrice);
  const [localPriceDisplayCurrencyMode, setLocalPriceDisplayCurrencyMode] = useState(
    priceDisplayCurrencyMode
  );
  const [localUsdToCnyRate, setLocalUsdToCnyRate] = useState(String(usdToCnyRate));
  const [localUiRadiusPreset, setLocalUiRadiusPreset] = useState(uiRadiusPreset);
  const [localThemeTonePreset, setLocalThemeTonePreset] = useState(themeTonePreset);
  const [localAccentColor, setLocalAccentColor] = useState(accentColor);
  const [localCanvasEdgeRoutingMode, setLocalCanvasEdgeRoutingMode] = useState(canvasEdgeRoutingMode);
  const [localAutoCheckAppUpdateOnLaunch, setLocalAutoCheckAppUpdateOnLaunch] = useState(
    autoCheckAppUpdateOnLaunch
  );
  const [localEnableUpdateDialog, setLocalEnableUpdateDialog] = useState(enableUpdateDialog);
  const [checkUpdateStatus, setCheckUpdateStatus] = useState<'' | 'checking' | 'has-update' | 'up-to-date' | 'failed'>('');
  const [revealedApiKeys, setRevealedApiKeys] = useState<Record<string, boolean>>({});
  // 推荐平台卡片上直接填 Key 的状态(只有正在连接的卡片会用到)。
  const [connectingRecommendedApiId, setConnectingRecommendedApiId] = useState<string | null>(null);
  const [recommendedApiKeyDraft, setRecommendedApiKeyDraft] = useState('');
  const [revealedRecommendedApiKey, setRevealedRecommendedApiKey] = useState(false);
  const [recommendedApiError, setRecommendedApiError] = useState<string | null>(null);
  // 已连接推荐平台卡片的余额(按推荐平台 id 缓存; 查不到的平台不会出现在这里)。
  const [providerBalances, setProviderBalances] = useState<Record<string, ProviderBalance>>({});
  const [providerBalanceLoading, setProviderBalanceLoading] = useState<Record<string, boolean>>({});
  // 已经查过的「平台 + Key」组合, 避免 customApis 每次变化都重发请求。
  const fetchedBalanceKeysRef = useRef<Set<string>>(new Set());
  const [expandedProviderIds, setExpandedProviderIds] = useState<Record<string, boolean>>({});
  const [recommendedApisExpanded, setRecommendedApisExpanded] = useState(false);
  const [showJimengCliSettings, setShowJimengCliSettings] = useState(false);
  const [localJimengCliExecutable, setLocalJimengCliExecutable] = useState(jimengCli.executable);
  const [jimengLoginState, setJimengLoginState] = useState<'idle' | 'opening' | 'polling' | 'success' | 'error'>('idle');
  const [, setJimengLoginInfo] = useState<{ verificationUri: string; userCode: string; deviceCode: string } | null>(null);
  // 即梦 CLI 剩余积分(dreamina user_credit); 未登录或 CLI 不可用时保持 null。
  const [jimengCredit, setJimengCredit] = useState<JimengCliCredit | null>(null);
  const [jimengLoginMessage, setJimengLoginMessage] = useState('');
  const jimengLoginTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jimengLoginCheckingRef = useRef(false);
  const jimengLoginProbeRef = useRef(false);
  const customApiSectionRef = useRef<HTMLDivElement>(null);
  const [showAddCustomApi, setShowAddCustomApi] = useState(false);
  const [editingCustomApiId, setEditingCustomApiId] = useState<string | null>(null);
  const [customApiDraft, setCustomApiDraft] = useState({
    name: '',
    baseUrl: '',
    apiKey: '',
    modelsText: '',
    videoModelsText: '',
    audioModelsText: '',
    chatModelsText: '',
    requestMode: 'sync' as 'sync' | 'async',
    protocol: 'images' as 'images' | 'responses' | 'chat',
    referenceImageField: 'image' as 'image' | 'input_image' | 'images' | 'reference_images',
    referenceImageEncoding: 'data_url' as 'auto' | 'data_url' | 'raw_base64' | 'url',
    imageTransport: 'auto' as 'auto' | 'generations_json' | 'edits_multipart' | 'apimart_json',
    referenceAssetUploadUrl: '',
    referenceAssetUploadToken: '',
    modelPrices: {} as Record<string, number>,
    capabilities: undefined as CustomApiCapabilities | undefined,
  });
  const [customApiBusy, setCustomApiBusy] = useState<'idle' | 'testing' | 'fetching'>('idle');
  const [customApiStatus, setCustomApiStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [modelPickerMediaType, setModelPickerMediaType] = useState<'image' | 'video' | 'audio' | 'chat'>('image');
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [pickedModels, setPickedModels] = useState<string[]>([]);
  const [modelPickerSearch, setModelPickerSearch] = useState('');
  const usableModelIds = useSettingsStore((state) => state.usableModelIds);
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  /**
   * 把推荐平台的预设翻译成一条自定义平台记录。
   *
   * 抽成公共函数是因为两条路径共用它：卡片上直接「连接」落库，以及「手动配置」
   * 预填到下面的表单。两条路径必须产出同一套协议字段，否则同一个平台走两条路
   * 会得到不同的链路行为。
   */
  const buildCustomApiInputFromRecommended = useCallback(
    (api: RecommendedApi, apiKey: string): Omit<CustomApiProvider, 'id' | 'createdAt'> => ({
      name: api.name,
      baseUrl: api.baseUrl,
      apiKey: apiKey.trim(),
      models: api.models,
      videoModels: api.videoModels ?? [],
      audioModels: api.audioModels ?? [],
      chatModels: api.chatModels ?? [],
      requestMode: 'sync',
      protocol: api.imageConfig?.protocol ?? 'images',
      referenceImageField: api.imageConfig?.referenceImageField ?? 'image',
      referenceImageEncoding: api.imageConfig?.referenceImageEncoding ?? 'auto',
      imageTransport: api.imageConfig?.imageTransport ?? 'auto',
      modelPrices: {},
      capabilities: api.videoConfig ? {
        detectedAt: Date.now(),
        detectionSource: 'manual',
        confidence: 'high',
        imageProtocol: 'unknown',
        imageReferenceField: 'unknown',
        imageReferenceEncoding: 'unknown',
        imageTransport: 'unknown',
        videoSubmitPath: api.videoConfig.submitPath,
        videoQueryPath: api.videoConfig.queryPath,
        videoReferenceEncoding: api.videoConfig.referenceEncoding,
        taskProtocol: 'generic',
        videoTransport: api.videoConfig.transport,
      } : undefined,
    }),
    []
  );

  /**
   * 推荐卡片上点「保存」：将预设连接写入统一运行时配置。
   *
   * 推荐平台不会出现在下方「自定义平台」列表；该列表只保留用户手工添加的平台。
   * 已经存在的同 Base URL 条目走更新，避免重复配置。
   */
  const connectRecommendedApi = useCallback(
    (api: RecommendedApi, apiKey: string, existing?: CustomApiProvider) => {
      const payload = buildCustomApiInputFromRecommended(api, apiKey);
      if (existing) {
        updateCustomApi(existing.id, payload);
      } else {
        addCustomApi(payload);
      }
      setConnectingRecommendedApiId(null);
      setRecommendedApiKeyDraft('');
      setRevealedRecommendedApiKey(false);
      setRecommendedApiError(null);
    },
    [addCustomApi, buildCustomApiInputFromRecommended, updateCustomApi]
  );

  /** 断开推荐平台：移除其运行时配置，推荐预设本身不动。 */
  const disconnectRecommendedApi = useCallback(
    (existing: CustomApiProvider) => {
      removeCustomApi(existing.id);
      setConnectingRecommendedApiId(null);
      setRecommendedApiKeyDraft('');
      setRecommendedApiError(null);
    },
    [removeCustomApi]
  );

  /** 校验后连接：Key 为空只提示、不落库,避免在列表里留下一条没有密钥的空平台。 */
  const handleConfirmConnectRecommendedApi = useCallback(
    (api: RecommendedApi, existing?: CustomApiProvider) => {
      if (!recommendedApiKeyDraft.trim()) {
        setRecommendedApiError(t('settings.recommendedApisKeyRequired'));
        return;
      }
      connectRecommendedApi(api, recommendedApiKeyDraft, existing);
    },
    [connectRecommendedApi, recommendedApiKeyDraft, t]
  );

  /**
   * 查询推荐平台的余额（已连接的卡片上展示）。
   *
   * 查不到（平台没有额度接口 / Key 失效 / 网络不通）就把结果清掉、不渲染徽章 ——
   * 余额是顺带信息，显示一个猜出来的数字比不显示更糟。
   */
  const refreshRecommendedApiBalance = useCallback(
    async (api: RecommendedApi, credentials: { baseUrl: string; apiKey: string }) => {
      if (!api.balanceKind || !credentials.apiKey.trim()) {
        return;
      }
      setProviderBalanceLoading((previous) => ({ ...previous, [api.id]: true }));
      try {
        const balance = await queryProviderBalance(
          api.balanceKind,
          credentials.baseUrl,
          credentials.apiKey
        );
        setProviderBalances((previous) => ({ ...previous, [api.id]: balance }));
      } catch {
        setProviderBalances((previous) => {
          const next = { ...previous };
          delete next[api.id];
          return next;
        });
      } finally {
        setProviderBalanceLoading((previous) => ({ ...previous, [api.id]: false }));
      }
    },
    []
  );

  /** 查询即梦 CLI 剩余积分（`dreamina user_credit`）；查不到就清空、不显示。 */
  const refreshJimengCredit = useCallback(async (executable: string) => {
    try {
      const credit = await queryJimengCliCredit(executable.trim() || 'dreamina');
      setJimengCredit(credit);
    } catch {
      setJimengCredit(null);
    }
  }, []);

  /** 打开密钥页时，给已连接的推荐平台补一次余额，顺手取一次即梦 CLI 积分。 */
  useEffect(() => {
    if (!isOpen || activeCategory !== 'providers') {
      return;
    }
    for (const api of visibleRecommendedApis) {
      const connected = connectedRecommendedApis.get(api.id);
      if (!api.balanceKind || !connected?.apiKey.trim()) {
        continue;
      }
      // 同一平台换了 Key 要重查, 但只要 Key 没变就不重复请求。
      const cacheKey = `${api.id}:${connected.apiKey}`;
      if (fetchedBalanceKeysRef.current.has(cacheKey)) {
        continue;
      }
      fetchedBalanceKeysRef.current.add(cacheKey);
      void refreshRecommendedApiBalance(api, connected);
    }
    // 即梦 CLI 的积分也直接显示在密钥页的卡片上, 不必打开弹窗才看得到。
    const jimengCacheKey = `jimeng-cli:${jimengCli.executable}`;
    if (!fetchedBalanceKeysRef.current.has(jimengCacheKey)) {
      fetchedBalanceKeysRef.current.add(jimengCacheKey);
      void refreshJimengCredit(jimengCli.executable);
    }
  }, [
    activeCategory,
    connectedRecommendedApis,
    isOpen,
    jimengCli.executable,
    refreshJimengCredit,
    refreshRecommendedApiBalance,
    visibleRecommendedApis,
  ]);

  /**
   * 推荐卡片上「手动配置」：把平台送到下面的自定义平台表单,需要改协议 / 模型 / 价格时用。
   *
   * 已经连上的平台(传 existing)**直接进「编辑」状态并优先用记录里的字段** —— 尤其 apiKey。
   * 之前的实现固定 `apiKey: ''` 且总是新建,导致刚在卡片上填过 Key 的用户点一次手动配置
   * 又要重填一遍,保存下去还会多出一条重复平台。
   * 没连上时才按预设预填(此时本来就没有 Key 可带)。
   */
  const applyRecommendedApi = useCallback((api: RecommendedApi, existing?: CustomApiProvider) => {
    setEditingCustomApiId(existing?.id ?? null);
    setCustomApiDraft({
      name: existing?.name ?? api.name,
      baseUrl: existing?.baseUrl ?? api.baseUrl,
      apiKey: existing?.apiKey ?? '',
      modelsText: (existing?.models ?? api.models).join('\n'),
      videoModelsText: (existing?.videoModels ?? api.videoModels ?? []).join('\n'),
      audioModelsText: (existing?.audioModels ?? api.audioModels ?? []).join('\n'),
      chatModelsText: (existing?.chatModels ?? api.chatModels ?? []).join('\n'),
      requestMode: existing?.requestMode ?? 'sync',
      protocol: existing?.protocol ?? api.imageConfig?.protocol ?? 'images',
      referenceImageField: existing?.referenceImageField ?? api.imageConfig?.referenceImageField ?? 'image',
      referenceImageEncoding:
        existing?.referenceImageEncoding ?? api.imageConfig?.referenceImageEncoding ?? 'auto',
      imageTransport: existing?.imageTransport ?? api.imageConfig?.imageTransport ?? 'auto',
      referenceAssetUploadUrl: existing?.referenceAssetUploadUrl ?? '',
      referenceAssetUploadToken: existing?.referenceAssetUploadToken ?? '',
      modelPrices: existing?.modelPrices ?? {},
      capabilities: existing?.capabilities ?? (api.videoConfig ? {
        detectedAt: Date.now(),
        detectionSource: 'manual',
        confidence: 'high',
        imageProtocol: 'unknown',
        imageReferenceField: 'unknown',
        imageReferenceEncoding: 'unknown',
        imageTransport: 'unknown',
        videoSubmitPath: api.videoConfig.submitPath,
        videoQueryPath: api.videoConfig.queryPath,
        videoReferenceEncoding: api.videoConfig.referenceEncoding,
        taskProtocol: 'generic',
        videoTransport: api.videoConfig.transport,
      } : undefined),
    });
    setShowAddCustomApi(true);
    setCustomApiStatus(null);
    // 滚动到自定义平台表单,让用户看到已预填内容
    requestAnimationFrame(() => {
      customApiSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const openJimengCliSettings = useCallback(() => {
    setLocalJimengCliExecutable(jimengCli.executable);
    setShowJimengCliSettings(true);
  }, [jimengCli.executable]);

  // 打开设置时只探测本地登录态，不会发起新的授权或打开浏览器。
  const probeJimengLoginStatus = useCallback(async (executable: string) => {
    const value = executable.trim() || 'dreamina';
    if (jimengLoginProbeRef.current) {
      return;
    }
    jimengLoginProbeRef.current = true;
    try {
      const result = await jimengCliLoginStart(value);
      if (!result.needAuth) {
        setJimengLoginState('success');
        setJimengLoginMessage(result.message || '已登录即梦账号');
        // 已登录才有积分可查; 未登录时 CLI 会直接报错, 不浪费一次调用。
        void refreshJimengCredit(value);
      } else {
        setJimengLoginState('idle');
        setJimengLoginMessage('');
      }
    } catch {
      // CLI 未安装或当前不可用时不覆盖设置弹窗，用户点击登录后再显示具体错误。
      setJimengLoginState('idle');
      setJimengLoginMessage('');
    } finally {
      jimengLoginProbeRef.current = false;
    }
  }, [refreshJimengCredit]);

  useEffect(() => {
    if (!showJimengCliSettings) {
      return;
    }
    void probeJimengLoginStatus(localJimengCliExecutable);
  }, [showJimengCliSettings, probeJimengLoginStatus]);

  // 组件卸载/关闭时清理登录轮询
  useEffect(() => {
    return () => {
      if (jimengLoginTimerRef.current) {
        clearInterval(jimengLoginTimerRef.current);
        jimengLoginTimerRef.current = null;
      }
      jimengLoginCheckingRef.current = false;
    };
  }, []);

  /** 一键登录即梦: 获取设备码 → 自动打开浏览器 → 轮询登录结果 */
  const startJimengLogin = useCallback(async () => {
    let executable = localJimengCliExecutable.trim() || 'dreamina';
    setJimengLoginState('opening');
    setJimengLoginMessage('正在获取授权链接，稍后会自动打开浏览器，通常需要几秒钟，请稍候…');
    setJimengLoginInfo(null);
    if (jimengLoginTimerRef.current) {
      clearInterval(jimengLoginTimerRef.current);
      jimengLoginTimerRef.current = null;
    }
    // 前置：检测即梦 CLI，未安装时自动安装；安装失败不致命，仅中止登录并提示手动安装。
    try {
      const detect = await jimengCliDetect(executable);
      if (!detect.found) {
        setJimengLoginMessage('正在自动安装即梦 CLI，请稍候…（约 1-2 分钟）');
        const install = await jimengCliInstall();
        if (!install.success || !install.resolvedPath) {
          setJimengLoginState('error');
          setJimengLoginMessage(
            `未检测到即梦 CLI 且自动安装失败：${install.message || '请手动安装'}`
          );
          return;
        }
        setJimengCliExecutable(install.resolvedPath);
        setLocalJimengCliExecutable(install.resolvedPath);
        executable = install.resolvedPath;
      }
    } catch (error) {
      setJimengLoginState('error');
      setJimengLoginMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      const result = await jimengCliLoginStart(executable);
      if (!result.needAuth) {
        setJimengLoginState('success');
        setJimengLoginMessage(result.message || '已登录即梦账号');
        return;
      }
      if (!result.verificationUri || !result.userCode || !result.deviceCode) {
        throw new Error(result.message || '无法获取登录信息，请确认 CLI 已安装且可执行');
      }
      setJimengLoginInfo({
        verificationUri: result.verificationUri,
        userCode: result.userCode,
        deviceCode: result.deviceCode,
      });
      try {
        await openUrl(result.verificationUri);
      } catch {
        setJimengLoginMessage(`请在浏览器手动打开: ${result.verificationUri}`);
      }
      setJimengLoginState('polling');

      const deviceCode = result.deviceCode;
      let attempts = 0;
      jimengLoginTimerRef.current = setInterval(async () => {
        // A CLI keyring write can take longer than the polling interval. Do
        // not overlap checklogin processes, otherwise concurrent OAuth saves
        // can make the CLI report "store unavailable".
        if (jimengLoginCheckingRef.current) return;
        jimengLoginCheckingRef.current = true;
        attempts += 1;
        const stopPolling = () => {
          if (jimengLoginTimerRef.current) {
            clearInterval(jimengLoginTimerRef.current);
            jimengLoginTimerRef.current = null;
          }
        };
        try {
          const check = await jimengCliLoginCheck(executable, deviceCode);
          if (check.message.includes('使用权限') || check.message.includes('没有权限')) {
            stopPolling();
            setJimengLoginState('error');
            setJimengLoginMessage(JIMENG_LOGIN_NO_PERMISSION_MESSAGE);
            return;
          }
          if (check.success) {
            stopPolling();
            setJimengLoginState('success');
            setJimengLoginMessage(check.message || '登录成功');
            // 刚登录进来才拿得到积分, 顺手刷新一次。
            void refreshJimengCredit(executable);
            return;
          }
          const lower = check.message.toLowerCase();
          if (lower.includes('fail') || lower.includes('expired') || lower.includes('invalid') || check.message.includes('过期') || check.message.includes('失效')) {
            stopPolling();
            setJimengLoginState('error');
            setJimengLoginMessage(check.message || '登录失败，请重试');
            return;
          }
          if (attempts >= JIMENG_LOGIN_MAX_ATTEMPTS) {
            stopPolling();
            setJimengLoginState('error');
            setJimengLoginMessage('等待授权超时。若已在浏览器完成授权，可在终端手动执行: dreamina login checklogin --device_code=<设备码>');
            return;
          }
          setJimengLoginMessage(`等待浏览器授权完成…（已等待 ${attempts * (JIMENG_LOGIN_POLL_INTERVAL_MS / 1000)} 秒）`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorLower = errorMessage.toLowerCase();
          const pendingError = errorLower.includes('not logged in') || errorLower.includes('pending') || errorLower.includes('waiting') || errorMessage.includes('未登录') || errorMessage.includes('等待') || errorMessage.includes('尚未');
          const permissionDenied = errorMessage.includes('使用权限') || errorMessage.includes('没有权限');
          if (permissionDenied) {
            stopPolling();
            setJimengLoginState('error');
            setJimengLoginMessage(JIMENG_LOGIN_NO_PERMISSION_MESSAGE);
            return;
          }
          const terminalError = !pendingError && (errorLower.includes('expired') || errorLower.includes('invalid') || errorLower.includes('fail') || errorMessage.includes('过期') || errorMessage.includes('失效') || errorMessage.includes('失败') || errorMessage.includes('未找到') || errorMessage.includes('无法启动'));
          if (attempts >= JIMENG_LOGIN_MAX_ATTEMPTS) {
            stopPolling();
            setJimengLoginState('error');
            setJimengLoginMessage('等待授权超时。若已在浏览器完成授权，可在终端手动执行: dreamina login checklogin --device_code=<设备码>');
          } else if (terminalError) {
            stopPolling();
            setJimengLoginState('error');
            setJimengLoginMessage(errorMessage);
          } else {
            setJimengLoginMessage('等待浏览器授权完成…（已等待 ' + (attempts * (JIMENG_LOGIN_POLL_INTERVAL_MS / 1000)) + ' 秒）');
          }
        } finally {
          jimengLoginCheckingRef.current = false;
        }
      }, JIMENG_LOGIN_POLL_INTERVAL_MS);
    } catch (error) {
      setJimengLoginState('error');
      setJimengLoginMessage(error instanceof Error ? error.message : String(error));
    }
  }, [localJimengCliExecutable, refreshJimengCredit, setJimengCliExecutable, setLocalJimengCliExecutable]);

    const handleJimengLogout = useCallback(() => {
    setJimengLoginState('idle');
    setJimengLoginInfo(null);
    // 退出登录后积分不再代表当前账号, 直接清掉。
    setJimengCredit(null);
    setJimengLoginMessage('已退出登录');
    void jimengCliLogout(localJimengCliExecutable).catch((error) => {
      setJimengLoginState('error');
      setJimengLoginMessage(error instanceof Error ? error.message : String(error));
    });
  }, [localJimengCliExecutable]);

  const saveJimengCliSettings = useCallback(() => {
    setJimengCliExecutable(localJimengCliExecutable);
    setShowJimengCliSettings(false);
  }, [localJimengCliExecutable, setJimengCliExecutable]);

  /** 自动安装即梦 CLI：失败不致命，只写用户目录；安装成功后自动探测本地登录态。 */
  const handleAutoInstallJimengCli = useCallback(async () => {
    if (jimengCliAutoInstallStatus.state === 'installing') {
      return;
    }
    setJimengCliAutoInstallStatus({
      state: 'installing',
      message: t('settings.jimengCliAutoInstalling'),
      resolvedPath: null,
      detectedAt: Date.now(),
    });
    try {
      const result = await jimengCliInstall();
      setJimengCliAutoInstallStatus({
        state: result.success ? 'ready' : 'failed',
        message: result.message,
        resolvedPath: result.resolvedPath,
        detectedAt: Date.now(),
      });
      if (result.success) {
        // 安装成功后 CLI 才可用，重新探测本地登录态。
        void probeJimengLoginStatus(result.resolvedPath ?? localJimengCliExecutable);
      }
    } catch (error) {
      setJimengCliAutoInstallStatus({
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
        resolvedPath: null,
        detectedAt: Date.now(),
      });
    }
  }, [jimengCliAutoInstallStatus.state, setJimengCliAutoInstallStatus, t, probeJimengLoginStatus, localJimengCliExecutable]);

  /** 验证链接:仅检查 Base URL 是否可达(不需要 Key) */
  const handleVerifyCustomUrl = useCallback(async () => {
    const baseUrl = customApiDraft.baseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) {
      setCustomApiStatus({ type: 'err', text: t('settings.customApiTestNeedUrl') });
      return;
    }
    setCustomApiBusy('testing');
    setCustomApiStatus(null);
    try {
      const result = await verifyProviderUrl(baseUrl);
      setCustomApiStatus(
        result.ok
          ? { type: 'ok', text: t('settings.customApiUrlOk', { status: result.status }) }
          : { type: 'err', text: t('settings.customApiUrlFailed', { status: result.status }) }
      );
    } catch (error) {
      setCustomApiStatus({
        type: 'err',
        text: `${t('settings.customApiUrlFailed2')} ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setCustomApiBusy('idle');
    }
  }, [customApiDraft.baseUrl, t]);

  /** 验证协议:带 Key 调 /v1/models,检测 OpenAI 兼容 */
  /** 拉取平台模型列表并打开对应媒体类型的模型选择弹窗。 */
  const handleFetchModels = useCallback(async (mediaType: 'image' | 'video' | 'audio' | 'chat') => {
    const baseUrl = customApiDraft.baseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) {
      setCustomApiStatus({ type: 'err', text: t('settings.customApiTestNeedUrl') });
      return;
    }
    setCustomApiBusy('fetching');
    setCustomApiStatus(null);
    try {
      const { models, prices } = await fetchProviderModels(baseUrl, customApiDraft.apiKey.trim());
      if (prices && Object.keys(prices).length > 0) {
        setCustomApiDraft((previous) => ({
          ...previous,
          modelPrices: { ...previous.modelPrices, ...prices },
        }));
        // 编辑已保存的平台时立即落库，避免用户拉取模型后未再次点击“保存”
        // 导致节点注册表仍看不到官方价格。
        if (editingCustomApiId) {
          const currentApi = useSettingsStore.getState().customApis.find(
            (api) => api.id === editingCustomApiId,
          );
          updateCustomApi(editingCustomApiId, {
            modelPrices: { ...(currentApi?.modelPrices ?? {}), ...prices },
          });
        }
      }
      if (models.length === 0) {
        setCustomApiStatus({ type: 'err', text: t('settings.customApiNoModels', '未从平台拉取到模型') });
        return;
      }
      const videoModelIds = new Set(
        customApiDraft.videoModelsText
          .split(/[\n,]/)
          .map((model) => model.trim().toLowerCase())
          .filter(Boolean)
      );
      const audioModelIds = new Set(
        customApiDraft.audioModelsText
          .split(/[\n,]/)
          .map((model) => model.trim().toLowerCase())
          .filter(Boolean)
      );
      const isZhenjian = isZhenjianProvider('', baseUrl);
      const targetModels = models.filter(
        (model) => isZhenjian && (mediaType === 'image' || mediaType === 'video')
          ? true
          : mediaType === 'video'
          ? isVideoGenerationModelName(model)
          : mediaType === 'audio'
            ? isAudioModelName(model)
            : mediaType === 'chat'
              ? isChatCompletionModelName(model)
              : !videoModelIds.has(model.trim().toLowerCase())
                && !audioModelIds.has(model.trim().toLowerCase())
                && !isVideoGenerationModelName(model)
                && !isAudioModelName(model)
                && !isChatCompletionModelName(model)
      );
      setFetchedModels(targetModels);
      const existing = new Set(
        (mediaType === 'video'
          ? customApiDraft.videoModelsText
          : mediaType === 'audio'
            ? customApiDraft.audioModelsText
            : mediaType === 'chat'
              ? customApiDraft.chatModelsText
              : customApiDraft.modelsText)
          .split(/[\n,]/)
          .map((model) => model.trim())
          .filter(Boolean)
      );
      setPickedModels(targetModels.filter((model) => existing.has(model)));
      setModelPickerSearch('');
      setModelPickerMediaType(mediaType);
      setIsModelPickerOpen(true);
    } catch (error) {
      setCustomApiStatus({
        type: 'err',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCustomApiBusy('idle');
    }
  }, [
    customApiDraft.apiKey,
    customApiDraft.baseUrl,
    customApiDraft.modelsText,
    customApiDraft.videoModelsText,
    customApiDraft.audioModelsText,
    customApiDraft.chatModelsText,
    editingCustomApiId,
    updateCustomApi,
    t,
  ]);

  const togglePickedModel = useCallback((model: string) => {
    setPickedModels((previous) =>
      previous.includes(model)
        ? previous.filter((item) => item !== model)
        : [...previous, model]
    );
  }, []);

  const confirmPickedModels = useCallback(() => {
    setCustomApiDraft({
      ...customApiDraft,
      ...(modelPickerMediaType === 'video'
        ? { videoModelsText: pickedModels.join('\n') }
        : modelPickerMediaType === 'audio'
          ? { audioModelsText: pickedModels.join('\n') }
          : modelPickerMediaType === 'chat'
            ? { chatModelsText: pickedModels.join('\n') }
            : { modelsText: pickedModels.join('\n') }),
    });
    setIsModelPickerOpen(false);
    setCustomApiStatus({ type: 'ok', text: t('settings.customApiModelsApplied', '已应用所选模型') });
  }, [customApiDraft, modelPickerMediaType, pickedModels, t]);

  const filteredFetchedModels = useMemo(() => {
    const keyword = modelPickerSearch.trim().toLowerCase();
    if (!keyword) {
      return fetchedModels;
    }
    return fetchedModels.filter((model) => model.toLowerCase().includes(keyword));
  }, [fetchedModels, modelPickerSearch]);

  const handleSelectAllPickedModels = useCallback(() => {
    setPickedModels(filteredFetchedModels);
  }, [filteredFetchedModels]);

  const handleClearPickedModels = useCallback(() => {
    setPickedModels([]);
  }, []);

  const handleTestCustomApi = useCallback(async () => {
    const baseUrl = customApiDraft.baseUrl.trim().replace(/\/+$/, '');
    const apiKey = customApiDraft.apiKey.trim();
    if (!baseUrl) {
      setCustomApiStatus({ type: 'err', text: t('settings.customApiTestNeedUrl') });
      return;
    }
    setCustomApiBusy('testing');
    setCustomApiStatus(null);
    try {
      const result = await detectProviderCapabilities(baseUrl, apiKey);
      const models = result.models ?? [];
      const videoModelIds = new Set(
        customApiDraft.videoModelsText
          .split(/[\n,]/)
          .map((model) => model.trim().toLowerCase())
          .filter(Boolean)
      );
      const audioModelIds = new Set(
        customApiDraft.audioModelsText
          .split(/[\n,]/)
          .map((model) => model.trim().toLowerCase())
          .filter(Boolean)
      );
      const isZhenjian = isZhenjianProvider('', baseUrl);
      const imageModels = models.filter(
        (model) =>
          (isZhenjian || !videoModelIds.has(model.trim().toLowerCase()))
          && !audioModelIds.has(model.trim().toLowerCase())
          && (isZhenjian || !isVideoGenerationModelName(model))
          && !isAudioModelName(model)
          && !isChatCompletionModelName(model)
      );
      setCustomApiDraft((previous) => {
        // 探测结果优先; 但探测为低置信度 images 默认且用户已手动选择 chat/responses
        // 时保留用户选择(OPTIONS 探测常被网关中间件统一响应, 不足以推翻手动配置)。
        const detectedProtocol = result.capabilities.imageProtocol === 'responses'
          ? 'responses'
          : result.capabilities.imageProtocol === 'chat' ? 'chat' : 'images';
        const keepManualProtocol =
          result.capabilities.confidence !== 'high'
          && detectedProtocol === 'images'
          && (previous.protocol === 'chat' || previous.protocol === 'responses');
        return {
          ...previous,
          modelsText: imageModels.length > 0 ? imageModels.join('\n') : previous.modelsText,
          // 能力探测只确认协议和编码，不足以证明平台支持任务查询；保持同步默认。
          protocol: keepManualProtocol ? previous.protocol : detectedProtocol,
          referenceImageField: result.capabilities.imageReferenceField === 'input_image'
            ? 'input_image'
            : result.capabilities.imageReferenceField === 'images' ? 'images' : 'image',
          referenceImageEncoding: result.capabilities.imageReferenceEncoding === 'raw_base64'
            ? 'raw_base64'
            : result.capabilities.imageReferenceEncoding === 'url' ? 'url' : 'data_url',
          imageTransport: result.capabilities.imageTransport === 'generations_json'
            || result.capabilities.imageTransport === 'edits_multipart'
            || result.capabilities.imageTransport === 'apimart_json'
            ? result.capabilities.imageTransport
            : previous.imageTransport,
          capabilities: result.capabilities,
          modelPrices: result.modelPrices
            ? { ...previous.modelPrices, ...result.modelPrices }
            : previous.modelPrices,
        };
      });
      const encodingLabel = result.capabilities.imageReferenceEncoding === 'raw_base64'
        ? 'Base64'
        : result.capabilities.imageReferenceEncoding === 'url'
          ? 'URL'
          : result.capabilities.imageReferenceEncoding === 'multipart'
            ? 'Multipart'
            : 'Data URL';
      const protocolLabel = result.capabilities.imageProtocol === 'responses'
        ? '/v1/responses'
        : result.capabilities.imageProtocol === 'chat'
          ? '/v1/chat/completions'
          : result.capabilities.imageProtocol === 'images'
            ? '/v1/images/generations'
            : '未识别';
      const transportLabel = result.capabilities.imageTransport === 'generations_json'
        ? '/v1/images/generations JSON'
        : result.capabilities.imageTransport === 'edits_multipart'
          ? '/v1/images/edits Multipart'
          : result.capabilities.imageTransport === 'apimart_json'
            ? 'APIMart image_urls'
            : '未确定';
      const confidenceLabel = result.capabilities.confidence === 'high' ? '高' : '低（仅非计费探测）';
      setCustomApiStatus({
        type: 'ok',
        text: t('settings.customApiTestOk', {
          count: models.length,
          protocol: protocolLabel,
          field: result.capabilities.imageReferenceField,
          encoding: encodingLabel,
          transport: transportLabel,
          confidence: confidenceLabel,
        }),
      });
    } catch (error) {
      setCustomApiStatus({
        type: 'err',
        text: `${t('settings.customApiTestFailed')} ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setCustomApiBusy('idle');
    }
  }, [customApiDraft.apiKey, customApiDraft.baseUrl, customApiDraft.videoModelsText, customApiDraft.audioModelsText, t]);

  const startEditCustomApi = useCallback((id: string) => {
    const api = useSettingsStore.getState().customApis.find((item) => item.id === id);
    if (!api) {
      return;
    }
    setEditingCustomApiId(id);
    setCustomApiDraft({
      name: api.name,
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      modelsText: api.models.join('\n'),
      videoModelsText: api.videoModels.join('\n'),
      audioModelsText: (api.audioModels ?? []).join('\n'),
      chatModelsText: (api.chatModels ?? []).join('\n'),
      requestMode: api.requestMode,
      protocol: api.protocol,
      referenceImageField: api.referenceImageField ?? 'image',
      referenceImageEncoding: api.referenceImageEncoding ?? 'auto',
      imageTransport: api.imageTransport ?? 'auto',
      referenceAssetUploadUrl: api.referenceAssetUploadUrl ?? '',
      referenceAssetUploadToken: api.referenceAssetUploadToken ?? '',
      modelPrices: api.modelPrices ?? {},
      capabilities: api.capabilities,
    });
    setShowAddCustomApi(true);
  }, []);

  const resetCustomApiForm = useCallback(() => {
    setShowAddCustomApi(false);
    setEditingCustomApiId(null);
    setCustomApiDraft({
      name: '',
      baseUrl: '',
      apiKey: '',
      modelsText: '',
      videoModelsText: '',
      audioModelsText: '',
      chatModelsText: '',
      requestMode: 'sync',
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'data_url',
      imageTransport: 'auto',
      referenceAssetUploadUrl: '',
      referenceAssetUploadToken: '',
      modelPrices: {},
      capabilities: undefined,
    });
  }, []);

  const submitCustomApi = useCallback(() => {
    const name = customApiDraft.name.trim();
    const baseUrl = customApiDraft.baseUrl.trim().replace(/\/+$/, '');
    const models = customApiDraft.modelsText
      .split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean);
    const videoModels = customApiDraft.videoModelsText
      .split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean);
    // 音频模型：仍按名称启发式过滤，避免把手填的图片模型挪走。
    const audioModels = customApiDraft.audioModelsText
      .split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean)
      .filter((model) => isAudioModelName(model));
    const chatModels = customApiDraft.chatModelsText
      .split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean)
      .filter((model) => isChatCompletionModelName(model));
    const videoModelIds = new Set(videoModels.map((model) => model.toLowerCase()));
    const audioModelIds = new Set(audioModels.map((model) => model.toLowerCase()));
    const chatModelIds = new Set(chatModels.map((model) => model.toLowerCase()));
    const imageModels = models.filter(
      (model) =>
        !videoModelIds.has(model.toLowerCase()) &&
        !audioModelIds.has(model.toLowerCase()) &&
        !chatModelIds.has(model.toLowerCase()) &&
        !isVideoGenerationModelName(model) &&
        !isAudioModelName(model) &&
        !isChatCompletionModelName(model)
    );
    if (
      !name ||
      !baseUrl ||
      (models.length === 0 && videoModels.length === 0 && audioModels.length === 0 && chatModels.length === 0)
    ) {
      return;
    }
    if (editingCustomApiId) {
      updateCustomApi(editingCustomApiId, {
        name,
        baseUrl,
        apiKey: customApiDraft.apiKey.trim(),
        models: imageModels,
        videoModels,
        audioModels,
        chatModels,
        requestMode: customApiDraft.requestMode,
        protocol: customApiDraft.protocol,
        referenceImageField: customApiDraft.referenceImageField,
        referenceImageEncoding: customApiDraft.referenceImageEncoding,
        imageTransport: customApiDraft.imageTransport,
        referenceAssetUploadUrl: customApiDraft.referenceAssetUploadUrl.trim(),
        referenceAssetUploadToken: customApiDraft.referenceAssetUploadToken.trim(),
        modelPrices: customApiDraft.modelPrices,
        capabilities: customApiDraft.capabilities,
      });
    } else {
      addCustomApi({
        name,
        baseUrl,
        apiKey: customApiDraft.apiKey.trim(),
        models: imageModels,
        videoModels,
        audioModels,
        chatModels,
        requestMode: customApiDraft.requestMode,
        protocol: customApiDraft.protocol,
        referenceImageField: customApiDraft.referenceImageField,
        referenceImageEncoding: customApiDraft.referenceImageEncoding,
        imageTransport: customApiDraft.imageTransport,
        referenceAssetUploadUrl: customApiDraft.referenceAssetUploadUrl.trim(),
        referenceAssetUploadToken: customApiDraft.referenceAssetUploadToken.trim(),
        modelPrices: customApiDraft.modelPrices,
        capabilities: customApiDraft.capabilities,
      });
    }
    resetCustomApiForm();
  }, [addCustomApi, customApiDraft, editingCustomApiId, resetCustomApiForm, updateCustomApi]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setLocalApiKeys(apiKeys);
    // 每次打开设置都收起「推荐平台填 Key」的临时状态，避免上次填一半的内容残留。
    setConnectingRecommendedApiId(null);
    setRecommendedApiKeyDraft('');
    setRecommendedApiError(null);
    setLocalUseUploadFilenameAsNodeTitle(useUploadFilenameAsNodeTitle);
    setLocalStoryboardGenKeepStyleConsistent(storyboardGenKeepStyleConsistent);
    setLocalStoryboardGenDisableTextInImage(storyboardGenDisableTextInImage);
    setLocalStoryboardGenAutoInferEmptyFrame(storyboardGenAutoInferEmptyFrame);
    setLocalIgnoreAtTagWhenCopyingAndGenerating(ignoreAtTagWhenCopyingAndGenerating);
    setLocalEnableStoryboardGenGridPreviewShortcut(enableStoryboardGenGridPreviewShortcut);
    setLocalShowStoryboardGenAdvancedRatioControls(showStoryboardGenAdvancedRatioControls);
    setLocalShowNodePrice(showNodePrice);
    setLocalPriceDisplayCurrencyMode(priceDisplayCurrencyMode);
    setLocalUsdToCnyRate(String(usdToCnyRate));
    setLocalUiRadiusPreset(uiRadiusPreset);
    setLocalThemeTonePreset(themeTonePreset);
    setLocalAccentColor(accentColor);
    setLocalCanvasEdgeRoutingMode(canvasEdgeRoutingMode);
    setLocalAutoCheckAppUpdateOnLaunch(autoCheckAppUpdateOnLaunch);
    setLocalEnableUpdateDialog(enableUpdateDialog);
    setCheckUpdateStatus('');
    setRevealedApiKeys({});
  }, [
    isOpen,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveCategory(initialCategory);
  }, [initialCategory, isOpen]);

  const handleSave = useCallback(() => {
    providers.forEach((provider) => {
      setProviderApiKey(provider.id, localApiKeys[provider.id] ?? '');
    });
    setUseUploadFilenameAsNodeTitle(localUseUploadFilenameAsNodeTitle);
    setStoryboardGenKeepStyleConsistent(localStoryboardGenKeepStyleConsistent);
    setStoryboardGenDisableTextInImage(localStoryboardGenDisableTextInImage);
    setStoryboardGenAutoInferEmptyFrame(localStoryboardGenAutoInferEmptyFrame);
    setIgnoreAtTagWhenCopyingAndGenerating(localIgnoreAtTagWhenCopyingAndGenerating);
    setEnableStoryboardGenGridPreviewShortcut(localEnableStoryboardGenGridPreviewShortcut);
    setShowStoryboardGenAdvancedRatioControls(localShowStoryboardGenAdvancedRatioControls);
    setShowNodePrice(localShowNodePrice);
    setPriceDisplayCurrencyMode(localPriceDisplayCurrencyMode);
    setUsdToCnyRate(Number(localUsdToCnyRate));
    setUiRadiusPreset(localUiRadiusPreset);
    setThemeTonePreset(localThemeTonePreset);
    setAccentColor(localAccentColor);
    setCanvasEdgeRoutingMode(localCanvasEdgeRoutingMode);
    setAutoCheckAppUpdateOnLaunch(localAutoCheckAppUpdateOnLaunch);
    setEnableUpdateDialog(localEnableUpdateDialog);
    onClose();
  }, [
    localApiKeys,
    localUseUploadFilenameAsNodeTitle,
    localStoryboardGenKeepStyleConsistent,
    localStoryboardGenDisableTextInImage,
    localStoryboardGenAutoInferEmptyFrame,
    localIgnoreAtTagWhenCopyingAndGenerating,
    localEnableStoryboardGenGridPreviewShortcut,
    localShowStoryboardGenAdvancedRatioControls,
    localShowNodePrice,
    localPriceDisplayCurrencyMode,
    localUsdToCnyRate,
    localUiRadiusPreset,
    localThemeTonePreset,
    localAccentColor,
    localCanvasEdgeRoutingMode,
    localAutoCheckAppUpdateOnLaunch,
    localEnableUpdateDialog,
    providers,
    setProviderApiKey,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setShowNodePrice,
    setPriceDisplayCurrencyMode,
    setUsdToCnyRate,
    setUiRadiusPreset,
    setThemeTonePreset,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    setAutoCheckAppUpdateOnLaunch,
    setEnableUpdateDialog,
    onClose,
  ]);

  const handleCheckUpdate = useCallback(async () => {
    if (!onCheckUpdate) {
      return;
    }

    setCheckUpdateStatus('checking');
    const status = await onCheckUpdate();
    setCheckUpdateStatus(status);
  }, [onCheckUpdate]);

  if (!shouldRender) return null;

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[300] flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/90 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div className="relative w-[min(96vw,1120px)]">
        <div
          className={`relative mx-auto h-[500px] w-[700px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'} flex`}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1 hover:bg-bg-dark rounded transition-colors z-10"
          >
            <X className="w-5 h-5 text-text-muted" />
          </button>

          {/* Sidebar */}
          <div className="w-[180px] bg-bg-dark border-r border-border-dark flex flex-col">
            <div className="px-4 py-4">
              <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                {t('settings.title')}
              </span>
            </div>

            <nav className="flex-1">
              <button
                onClick={() => setActiveCategory('general')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'general'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.general')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('providers')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'providers'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.providers')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('appearance')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'appearance'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.appearance')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('pricing')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'pricing'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.pricing')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('experimental')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'experimental'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.experimental')}</span>
              </button>
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col">
            {activeCategory === 'providers' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.providers')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.providersDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  {/* 内置平台折叠卡片已并入下方「推荐平台」网格 */}

                  {/* 推荐平台(可折叠) */}
                  <div className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
                    <button
                      type="button"
                      onClick={() => setRecommendedApisExpanded((previous) => !previous)}
                      className="flex w-full items-center justify-between gap-3 text-left transition-colors hover:opacity-80"
                    >
                      <div>
                        <h3 className="text-sm font-medium text-text-dark">
                          {t('settings.recommendedApisTitle')}
                        </h3>
                        <p className="mt-0.5 text-xs text-text-muted">
                          {t('settings.recommendedApisDesc')}
                        </p>
                      </div>
                      {recommendedApisExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                      )}
                    </button>

                    {recommendedApisExpanded && (
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {/* 内置平台(折叠卡片,点击展开配置密钥) */}
                      {providers.map((provider) => {
                        const displayName = i18n.language.startsWith('zh') ? provider.label : provider.name;
                        const isRevealed = Boolean(revealedApiKeys[provider.id]);
                        const isExpanded = Boolean(expandedProviderIds[provider.id]);
                        const hasConfiguredKey = Boolean((localApiKeys[provider.id] ?? '').trim());
                        const hasRegisterLinks =
                          Boolean(PROVIDER_REGISTER_URLS[provider.id]) && Boolean(PROVIDER_GET_KEY_URLS[provider.id]);

                        return (
                          <div key={provider.id} className="overflow-hidden rounded-md border border-border-dark bg-bg-dark">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedProviderIds((previous) => ({
                                  ...previous,
                                  [provider.id]: !isExpanded,
                                }))
                              }
                              className="flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-bg-dark/70"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-xs font-medium text-text-dark">{displayName}</span>
                                  <span
                                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                                      hasConfiguredKey
                                        ? 'bg-emerald-500/15 text-emerald-400'
                                        : 'bg-bg-dark text-text-muted/60'
                                    }`}
                                  >
                                    {hasConfiguredKey
                                      ? t('settings.providerConfigured')
                                      : t('settings.providerNotConfigured')}
                                  </span>
                                </div>
                                {PROVIDER_DESCRIPTIONS[provider.id] && (
                                  <p className="mt-1 text-[10px] leading-4 text-text-muted/80">
                                    {PROVIDER_DESCRIPTIONS[provider.id]}
                                  </p>
                                )}
                              </div>
                              {isExpanded ? (
                                <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
                              ) : (
                                <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
                              )}
                            </button>

                            {isExpanded && (
                              <div className="border-t border-border-dark px-3 py-2.5">
                                {hasRegisterLinks ? (
                                  <p className="mb-2 text-[11px] text-text-muted">
                                    {t('settings.providerApiKeyGuidePrefix')}{' '}
                                    <a
                                      href={PROVIDER_REGISTER_URLS[provider.id]}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-accent hover:underline"
                                    >
                                      {t('settings.providerRegisterLink')}
                                    </a>
                                    {t('settings.providerApiKeyGuideMiddle')}{' '}
                                    <a
                                      href={PROVIDER_GET_KEY_URLS[provider.id]}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-accent hover:underline"
                                    >
                                      {t('settings.getApiKeyLink')}
                                    </a>
                                  </p>
                                ) : (
                                  <p className="mb-2 text-[11px] text-text-muted">{provider.id}</p>
                                )}

                                <div className="relative">
                                  <input
                                    type={isRevealed ? 'text' : 'password'}
                                    value={localApiKeys[provider.id] ?? ''}
                                    onChange={(event) => {
                                      const nextValue = event.target.value;
                                      setLocalApiKeys((previous) => ({
                                        ...previous,
                                        [provider.id]: nextValue,
                                      }));
                                      setProviderApiKey(provider.id, nextValue);
                                    }}
                                    placeholder={t('settings.enterApiKey')}
                                    className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 pr-9 text-xs text-text-dark placeholder:text-text-muted"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setRevealedApiKeys((previous) => ({
                                        ...previous,
                                        [provider.id]: !isRevealed,
                                      }))
                                    }
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-bg-dark"
                                  >
                                    {isRevealed ? (
                                      <EyeOff className="h-3.5 w-3.5 text-text-muted" />
                                    ) : (
                                      <Eye className="h-3.5 w-3.5 text-text-muted" />
                                    )}
                                  </button>
                                </div>

                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* 推荐平台卡片：点「添加」直接在卡片里填 API Key 完成接入，
                          配好即显示绿色「已连接」，不必再跑到下面的自定义平台表单。 */}
                      {visibleRecommendedApis.map((api) => {
                        const connected = connectedRecommendedApis.get(api.id);
                        const hasApiKey = Boolean(connected?.apiKey.trim());
                        const isConnecting = connectingRecommendedApiId === api.id;
                        const balance = providerBalances[api.id];
                        const isBalanceLoading = Boolean(api.balanceKind) && Boolean(providerBalanceLoading[api.id]);

                        return (
                          <div
                            key={api.id}
                            className="flex flex-col rounded-md border border-border-dark bg-bg-dark p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-xs font-medium text-text-dark">
                                {api.name}
                              </span>
                              {hasApiKey ? (
                                /* 「已连接」顺带显示余额(查得到才有); 点一下重新查询。
                                   查不到的平台(如 ModelScope 没有额度接口)只显示「已连接」。 */
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (connected) {
                                      void refreshRecommendedApiBalance(api, connected);
                                    }
                                  }}
                                  title={
                                    balance?.detail ?? t('settings.recommendedApisBalanceHint')
                                  }
                                  className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/25"
                                >
                                  {t('settings.recommendedApisConnected')}
                                  {balance ? ` · ${formatProviderBalance(balance)}` : ''}
                                  {!balance && isBalanceLoading ? ' · …' : ''}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConnectingRecommendedApiId(isConnecting ? null : api.id);
                                    setRecommendedApiKeyDraft(connected?.apiKey ?? '');
                                    setRevealedRecommendedApiKey(false);
                                    setRecommendedApiError(null);
                                  }}
                                  className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25"
                                >
                                  {t('settings.recommendedApisAdd')}
                                </button>
                              )}
                            </div>
                            <p className="mt-1 text-[11px] text-text-muted">{api.summary}</p>

                            {isConnecting && (
                              <div className="mt-2 space-y-1.5">
                                <div className="relative">
                                  <input
                                    autoFocus
                                    type={revealedRecommendedApiKey ? 'text' : 'password'}
                                    value={recommendedApiKeyDraft}
                                    onChange={(event) => {
                                      setRecommendedApiKeyDraft(event.target.value);
                                      setRecommendedApiError(null);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault();
                                        handleConfirmConnectRecommendedApi(api, connected);
                                      }
                                    }}
                                    placeholder={t('settings.recommendedApisKeyPlaceholder')}
                                    className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 pr-9 text-xs text-text-dark placeholder:text-text-muted"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setRevealedRecommendedApiKey((previous) => !previous)}
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-bg-dark"
                                  >
                                    {revealedRecommendedApiKey ? (
                                      <EyeOff className="h-3.5 w-3.5 text-text-muted" />
                                    ) : (
                                      <Eye className="h-3.5 w-3.5 text-text-muted" />
                                    )}
                                  </button>
                                </div>
                                {recommendedApiError && (
                                  <p className="text-[10px] text-red-400">{recommendedApiError}</p>
                                )}
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => handleConfirmConnectRecommendedApi(api, connected)}
                                    className="rounded-md bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25"
                                  >
                                    {t('settings.recommendedApisSave')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setConnectingRecommendedApiId(null);
                                      setRecommendedApiKeyDraft('');
                                      setRecommendedApiError(null);
                                    }}
                                    className="rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                                  >
                                    {t('common.cancel')}
                                  </button>
                                </div>
                              </div>
                            )}

                            {connected && !isConnecting && (
                              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConnectingRecommendedApiId(api.id);
                                    setRecommendedApiKeyDraft(connected.apiKey);
                                    setRevealedRecommendedApiKey(false);
                                    setRecommendedApiError(null);
                                  }}
                                  className="transition-colors hover:text-text-dark"
                                >
                                  {t('settings.recommendedApisChangeKey')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => applyRecommendedApi(api, connected)}
                                  className="transition-colors hover:text-text-dark"
                                >
                                  {t('settings.recommendedApisManual')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => disconnectRecommendedApi(connected)}
                                  className="transition-colors hover:text-red-400"
                                >
                                  {t('settings.recommendedApisDisconnect')}
                                </button>
                              </div>
                            )}

                            {/* 卡片数据层字段一律保留 —— 尤其 pricingRange, 节点右上角的
                                价格徽章还要靠它兜底(nodePriceBadge.ts), 删了会连带丢价格。 */}
                            <a
                              href={api.pricingUrl ?? api.registerUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1.5 text-[11px] text-accent hover:underline"
                            >
                              {api.pricingUrl
                                ? t('settings.recommendedApisPricing')
                                : t('settings.recommendedApisRegister')}
                            </a>
                          </div>
                        );
                      })}
                    </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
                    <button
                      type="button"
                      onClick={openJimengCliSettings}
                      className="flex w-full items-start gap-3 text-left transition-colors hover:opacity-80"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                        <Terminal className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-text-dark">
                            {t('settings.jimengCliTitle')}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {/* 即梦积分（dreamina user_credit）；未登录 / 查不到就不显示。 */}
                            {jimengCredit && (
                              <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                {t('settings.jimengCliCredit')}{' '}
                                {Math.round(jimengCredit.totalCredit)}
                              </span>
                            )}
                            <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs text-text-muted">
                          {t('settings.jimengCliDesc')}
                        </span>
                      </span>
                    </button>
                  </div>

                  <WanCliSettings />

                  {/* 自定义平台(OpenAI 兼容) */}
                  <div ref={customApiSectionRef} className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-text-dark">
                          {t('settings.customApiTitle')}
                        </h3>
                        <p className="mt-0.5 text-xs text-text-muted">
                          {t('settings.customApiDesc')}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowAddCustomApi(true)}
                        className="flex items-center gap-1 rounded-md border border-border-dark px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t('settings.customApiAdd')}
                      </button>
                    </div>

                    {visibleCustomApis.length === 0 && !showAddCustomApi && (
                      <p className="py-2 text-xs text-text-muted/60">
                        {t('settings.customApiEmpty')}
                      </p>
                    )}

                    {showAddCustomApi && (
                      <UiModal
                        isOpen={showAddCustomApi}
                        title={
                          editingCustomApiId
                            ? t('settings.customApiEditTitle', '编辑平台')
                            : t('settings.customApiAdd')
                        }
                        onClose={resetCustomApiForm}
                        widthClassName="w-[560px]"
                      >
                      {/* 字段变多后弹窗会超出窗口高度, 这里让表单自身滚动, 避免保存按钮不可达。 */}
                      <div className="ui-scrollbar max-h-[62vh] space-y-2 overflow-y-auto pr-1">
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">
                              {t('settings.customApiName')}
                            </span>
                            <input
                              value={customApiDraft.name}
                              onChange={(event) =>
                                setCustomApiDraft({ ...customApiDraft, name: event.target.value })
                              }
                              placeholder={t('settings.customApiNamePlaceholder')}
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">
                              {t('settings.customApiBaseUrl')}
                            </span>
                            <input
                              value={customApiDraft.baseUrl}
                              onChange={(event) =>
                                setCustomApiDraft({ ...customApiDraft, baseUrl: event.target.value })
                              }
                              placeholder="https://api.example.com"
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                            />
                          </label>
                        </div>
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-text-muted">
                            {t('settings.customApiKey')}
                          </span>
                          <input
                            type="password"
                            value={customApiDraft.apiKey}
                            onChange={(event) =>
                              setCustomApiDraft({ ...customApiDraft, apiKey: event.target.value })
                            }
                            placeholder={t('settings.customApiKeyPlaceholder')}
                            className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">
                              {t('settings.customApiReferenceAssetUploadUrl')}
                            </span>
                            <input
                              value={customApiDraft.referenceAssetUploadUrl}
                              onChange={(event) =>
                                setCustomApiDraft({ ...customApiDraft, referenceAssetUploadUrl: event.target.value })
                              }
                              placeholder="https://assets.example.com/v1/reference-assets"
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">
                              {t('settings.customApiReferenceAssetUploadToken')}
                            </span>
                            <input
                              type="password"
                              value={customApiDraft.referenceAssetUploadToken}
                              onChange={(event) =>
                                setCustomApiDraft({ ...customApiDraft, referenceAssetUploadToken: event.target.value })
                              }
                              placeholder={t('settings.customApiReferenceAssetUploadTokenPlaceholder')}
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                            />
                          </label>
                        </div>
                        <p className="text-[10px] leading-4 text-text-muted">
                          {t('settings.customApiReferenceAssetUploadHint')}
                        </p>
                        <label className="block">
                          <span className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
                            <span>{t('settings.customApiVideoModels')}</span>
                            <button
                              type="button"
                              onClick={() => void handleFetchModels('video')}
                              disabled={customApiBusy !== 'idle'}
                              className="rounded-md border border-border-dark px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark disabled:opacity-50"
                            >
                              {customApiBusy === 'fetching'
                                ? t('settings.customApiFetching', '拉取中…')
                                : t('settings.customApiFetchModels', '拉取模型')}
                            </button>
                          </span>
                          <textarea
                            value={customApiDraft.videoModelsText}
                            onChange={(event) =>
                              setCustomApiDraft({ ...customApiDraft, videoModelsText: event.target.value })
                            }
                            rows={2}
                            placeholder={t('settings.customApiVideoModelsPlaceholder')}
                            className="ui-scrollbar w-full resize-none rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
                            <span>{t('settings.customApiModels')}</span>
                            <button
                              type="button"
                              onClick={() => void handleFetchModels('image')}
                              disabled={customApiBusy !== 'idle'}
                              className="rounded-md border border-border-dark px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark disabled:opacity-50"
                            >
                              {customApiBusy === 'fetching'
                                ? t('settings.customApiFetching', '拉取中…')
                                : t('settings.customApiFetchModels', '拉取模型')}
                            </button>
                          </span>
                          <textarea
                            value={customApiDraft.modelsText}
                            onChange={(event) =>
                              setCustomApiDraft({ ...customApiDraft, modelsText: event.target.value })
                            }
                            rows={3}
                            placeholder={t('settings.customApiModelsPlaceholder')}
                            className="ui-scrollbar w-full resize-none rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
                            <span>{t('settings.customApiAudioModels')}</span>
                            <button
                              type="button"
                              onClick={() => void handleFetchModels('audio')}
                              disabled={customApiBusy !== 'idle'}
                              className="rounded-md border border-border-dark px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark disabled:opacity-50"
                            >
                              {customApiBusy === 'fetching'
                                ? t('settings.customApiFetching', '拉取中…')
                                : t('settings.customApiFetchModels', '拉取模型')}
                            </button>
                          </span>
                          <textarea
                            value={customApiDraft.audioModelsText}
                            onChange={(event) =>
                              setCustomApiDraft({ ...customApiDraft, audioModelsText: event.target.value })
                            }
                            rows={2}
                            placeholder={t('settings.customApiAudioModelsPlaceholder')}
                            className="ui-scrollbar w-full resize-none rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
                            <span>{t('settings.customApiChatModels')}</span>
                            <button
                              type="button"
                              onClick={() => void handleFetchModels('chat')}
                              disabled={customApiBusy !== 'idle'}
                              className="rounded-md border border-border-dark px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark disabled:opacity-50"
                            >
                              {customApiBusy === 'fetching'
                                ? t('settings.customApiFetching', '拉取中…')
                                : t('settings.customApiFetchModels', '拉取模型')}
                            </button>
                          </span>
                          <textarea
                            value={customApiDraft.chatModelsText}
                            onChange={(event) =>
                              setCustomApiDraft({ ...customApiDraft, chatModelsText: event.target.value })
                            }
                            rows={2}
                            placeholder={t('settings.customApiChatModelsPlaceholder')}
                            className="ui-scrollbar w-full resize-none rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">请求模式</span>
                            <select
                              value={customApiDraft.requestMode}
                              onChange={(event) =>
                                setCustomApiDraft({
                                  ...customApiDraft,
                                  requestMode: event.target.value as 'sync' | 'async',
                                })
                              }
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark"
                            >
                              <option value="sync">同步返回</option>
                              <option value="async">异步轮询</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">
                              {t('settings.customApiProtocol', '图片协议')}
                            </span>
                            <select
                              value={customApiDraft.protocol}
                              onChange={(event) =>
                                setCustomApiDraft({
                                  ...customApiDraft,
                                  protocol: event.target.value as 'images' | 'responses' | 'chat',
                                })
                              }
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark"
                            >
                              <option value="images">/v1/images/generations</option>
                              <option value="responses">/v1/responses</option>
                              <option value="chat">/v1/chat/completions</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">
                              {t('settings.customApiReferenceField', '参考图字段')}
                            </span>
                            <select
                              value={customApiDraft.referenceImageField}
                              onChange={(event) =>
                                setCustomApiDraft({
                                  ...customApiDraft,
                                  referenceImageField: event.target.value as 'image' | 'input_image' | 'images' | 'reference_images',
                                })
                              }
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark"
                            >
                              <option value="image">image / images</option>
                              <option value="images">images（纯数组）</option>
                              <option value="reference_images">reference_images（对象数组）</option>
                              <option value="input_image">input_image</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">
                              {t('settings.customApiReferenceEncoding', '参考图编码')}
                            </span>
                            <select
                              value={customApiDraft.referenceImageEncoding}
                              onChange={(event) =>
                                setCustomApiDraft({
                                  ...customApiDraft,
                                  referenceImageEncoding: event.target.value as 'auto' | 'data_url' | 'raw_base64' | 'url',
                                })
                              }
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark"
                            >
                              <option value="auto">{t('settings.customApiReferenceEncodingAuto', '自动')}</option>
                              <option value="data_url">Data URL</option>
                              <option value="raw_base64">Base64</option>
                              <option value="url">URL</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-text-muted">图生图适配器</span>
                            <select
                              value={customApiDraft.imageTransport}
                              onChange={(event) =>
                                setCustomApiDraft({
                                  ...customApiDraft,
                                  imageTransport: event.target.value as 'auto' | 'generations_json' | 'edits_multipart' | 'apimart_json',
                                })
                              }
                              className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark"
                            >
                              <option value="auto">自动（带参考图时用 edits）</option>
                              <option value="generations_json">/v1/images/generations JSON</option>
                              <option value="edits_multipart">/v1/images/edits 上传图片</option>
                              <option value="apimart_json">APIMart image_urls</option>
                            </select>
                          </label>
                        </div>
                        <p className="text-[10px] leading-4 text-text-muted">
                          {t(
                            'settings.customApiProbeHint',
                            '验证协议只使用 /v1/models 和 OPTIONS 等非计费探测，会自动填写图片协议、参考图字段、编码和图生图适配器；同步/异步无法安全探测，请手动选择。'
                          )}
                        </p>
                        {/* 连接验证只检查服务可达性和模型列表; 请求协议与参考图编码按上方配置发送。 */}
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <button
                            type="button"
                            onClick={() => void handleVerifyCustomUrl()}
                            disabled={customApiBusy !== 'idle'}
                            className="rounded-md border border-border-dark px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark disabled:opacity-50"
                          >
                            {customApiBusy === 'testing'
                              ? t('settings.customApiTesting')
                              : t('settings.customApiVerifyUrl')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleTestCustomApi()}
                            disabled={customApiBusy !== 'idle'}
                            className="rounded-md border border-border-dark px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark disabled:opacity-50"
                          >
                            {customApiBusy === 'testing'
                              ? t('settings.customApiTesting')
                              : t('settings.customApiVerifyProtocol')}
                          </button>
                          {customApiStatus && (
                            <span
                              className={`text-[11px] ${customApiStatus.type === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
                            >
                              {customApiStatus.text}
                            </span>
                          )}
                        </div>

                        <div className="flex justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={resetCustomApiForm}
                            className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-dark"
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            type="button"
                            onClick={submitCustomApi}
                            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/85"
                          >
                            {editingCustomApiId ? t('common.save') : t('settings.customApiAdd')}
                          </button>
                        </div>
                      </div>
                      </UiModal>
                    )}

                    <UiModal
                      isOpen={isModelPickerOpen}
                      title={t(
                        'settings.customApiPickModels',
                        modelPickerMediaType === 'video'
                          ? '选择视频模型'
                          : modelPickerMediaType === 'audio'
                            ? '选择音频模型'
                            : modelPickerMediaType === 'chat'
                              ? '选择 Chat 模型'
                              : '选择图片模型'
                      )}
                      onClose={() => setIsModelPickerOpen(false)}
                      widthClassName="w-[480px]"
                      footer={
                        <>
                          <button
                            type="button"
                            onClick={() => setIsModelPickerOpen(false)}
                            className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-dark"
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            type="button"
                            onClick={confirmPickedModels}
                            disabled={pickedModels.length === 0}
                            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
                          >
                            {t('settings.customApiApplyModels', '应用所选')} ({pickedModels.length})
                          </button>
                        </>
                      }
                    >
                      <div className="space-y-3">
                        <input
                          value={modelPickerSearch}
                          onChange={(event) => setModelPickerSearch(event.target.value)}
                          placeholder={t('settings.customApiSearchModels', '搜索模型…')}
                          className="w-full rounded border border-border-dark bg-surface-dark px-2.5 py-1.5 text-xs text-text-dark placeholder:text-text-muted"
                        />
                        <div className="flex items-center justify-between text-[11px] text-text-muted">
                          <span>
                            {t('settings.customApiModelCount', { count: fetchedModels.length })}
                          </span>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleSelectAllPickedModels}
                              className="text-accent transition-colors hover:opacity-80"
                            >
                              {t('settings.customApiSelectAll', '全选')}
                            </button>
                            <button
                              type="button"
                              onClick={handleClearPickedModels}
                              className="text-text-muted transition-colors hover:text-text-dark"
                            >
                              {t('settings.customApiSelectNone', '清空')}
                            </button>
                          </div>
                        </div>
                        <div className="ui-scrollbar max-h-[320px] space-y-1 overflow-y-auto rounded-lg border border-[rgba(255,255,255,0.08)] bg-bg-dark/60 p-2">
                          {filteredFetchedModels.map((model) => (
                            <label
                              key={model}
                              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                            >
                              <input
                                type="checkbox"
                                checked={pickedModels.includes(model)}
                                onChange={() => togglePickedModel(model)}
                                className="accent-accent"
                              />
                              <span className="min-w-0 truncate">{model}</span>
                              {editingCustomApiId && usableModelIds.includes(buildCustomModelId(editingCustomApiId, model)) && (
                                <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                                  可用
                                </span>
                              )}
                            </label>
                          ))}
                          {filteredFetchedModels.length === 0 && (
                            <p className="py-4 text-center text-xs text-text-muted/60">
                              {t('settings.customApiNoModelsMatch', '没有匹配的模型')}
                            </p>
                          )}
                        </div>
                      </div>
                    </UiModal>

                    {/* 平台卡片一行两个(sm 以上并排, 窄窗回退单列)。
                        两列后横向空间减半, 因此「名称 / 地址 / 统计」改为竖排各占一行,
                        比原来「名称 + 地址」挤在同一行更好读。
                        间距交给父级 gap —— 卡片自身不再带 mb-2, 否则两列时下边距会叠加。 */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {visibleCustomApis.map((api) => (
                        <div
                          key={api.id}
                          className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border-dark bg-bg-dark px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-text-dark">
                              {api.name}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-text-muted/70">
                              {api.baseUrl}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                              {api.models.length} {t('settings.customApiModelCount')} ·{' '}
                              {api.apiKey ? t('settings.customApiKeySet') : t('settings.customApiKeyMissing')}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => startEditCustomApi(api.id)}
                              className="rounded p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                              title={t('common.edit')}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeCustomApi(api.id)}
                              className="rounded p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-red-400"
                              title={t('common.delete')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-border-dark flex justify-end">
                  <button
                    onClick={handleSave}
                    className="px-4 py-2 text-sm font-medium bg-accent text-white rounded
                             hover:bg-accent/80 transition-colors"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            <UiModal
              isOpen={showJimengCliSettings}
              title={t('settings.jimengCliTitle')}
              onClose={() => setShowJimengCliSettings(false)}
              widthClassName="w-[520px]"
              footer={
                <>
                  <button
                    type="button"
                    onClick={() => setShowJimengCliSettings(false)}
                    className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-dark"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={saveJimengCliSettings}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </>
              }
            >
              <div className="space-y-4">
                <p className="text-xs leading-5 text-text-muted">{t('settings.jimengCliDialogDesc')}</p>

                <div className="rounded-md border border-border-dark bg-surface-dark/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-text-dark">
                        {jimengCliAutoInstallStatus.state === 'ready'
                          ? t('settings.jimengCliAutoReady')
                          : jimengCliAutoInstallStatus.state === 'failed'
                            ? t('settings.jimengCliAutoInstallFailed')
                            : jimengCliAutoInstallStatus.state === 'installing'
                              ? t('settings.jimengCliAutoInstalling')
                              : jimengCliAutoInstallStatus.state === 'detecting'
                                ? t('settings.jimengCliAutoDetecting')
                                : t('settings.jimengCliAutoMissing')}
                      </p>
                      {jimengCliAutoInstallStatus.resolvedPath && (
                        <p className="mt-0.5 break-all text-[11px] leading-4 text-text-muted">
                          {t('settings.jimengCliAutoPath')}: {jimengCliAutoInstallStatus.resolvedPath}
                        </p>
                      )}
                      {jimengCliAutoInstallStatus.message &&
                        jimengCliAutoInstallStatus.state !== 'ready' && (
                          <p className="mt-0.5 break-all text-[11px] leading-4 text-text-muted">
                            {jimengCliAutoInstallStatus.message}
                          </p>
                        )}
                    </div>
                    {(jimengCliAutoInstallStatus.state === 'failed' ||
                      jimengCliAutoInstallStatus.state === 'idle') && (
                      <button
                        type="button"
                        onClick={() => void handleAutoInstallJimengCli()}
                        className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t('settings.jimengCliAutoInstallBtn')}
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] leading-4 text-text-muted">
                    {t('settings.jimengCliAutoInstallNotice')}
                  </p>
                </div>

                <label className="block text-xs font-medium text-text-dark">
                  {t('settings.jimengCliExecutable')}
                  <input
                    value={localJimengCliExecutable}
                    onChange={(event) => setLocalJimengCliExecutable(event.target.value)}
                    placeholder="dreamina"
                    className="mt-1.5 w-full rounded border border-border-dark bg-surface-dark px-2.5 py-2 text-xs text-text-dark placeholder:text-text-muted"
                  />
                  <span className="mt-1 block text-[11px] font-normal leading-4 text-text-muted">
                    {t('settings.jimengCliExecutableDesc')}
                  </span>
                </label>

                <div className="rounded-md border border-border-dark bg-surface-dark/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-text-dark">
                        {t('settings.jimengCliLoginTitle', '即梦账号登录')}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                        {t('settings.jimengCliLoginDesc', '点击后自动打开浏览器完成授权，无需手动执行命令')}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
<button
                      type="button"
                      onClick={startJimengLogin}
                      disabled={jimengLoginState === 'opening' || jimengLoginState === 'polling'}
                      className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {jimengLoginState === 'opening' || jimengLoginState === 'polling'
                        ? t('settings.jimengCliLogining', '获取授权中…')
                        : jimengLoginState === 'success'
                          ? t('settings.jimengCliLoggedIn', '已登录')
                          : t('settings.jimengCliLoginBtn', '一键登录')}
                    </button>
{jimengLoginState === 'success' && (
<button
  type="button"
  onClick={handleJimengLogout}
  className="shrink-0 rounded-md border border-border-dark bg-surface-dark px-3 py-1.5 text-xs font-medium text-text-dark transition-colors hover:bg-surface-dark/70 disabled:cursor-not-allowed disabled:opacity-50"
>
  {t('settings.jimengCliLogout', '退出登录')}
</button>
)}
</div>
                  </div>

                  {jimengLoginMessage && (
                    <p className={`mt-2 break-all text-[11px] leading-4 ${
                      jimengLoginState === 'error' ? 'text-red-400' : 'text-text-muted'
                    }`}>
                      {jimengLoginState === 'error' && '✗ '}
                      {jimengLoginState === 'success' && '✓ '}
                      {jimengLoginMessage}
                    </p>
                  )}

                  {/* 即梦 CLI 剩余积分(dreamina user_credit); 未登录 / 查不到时整块不渲染。 */}
                  {jimengCredit && (
                    <div className="mt-2 flex items-center gap-2 rounded-md bg-accent/10 px-2 py-1.5">
                      <span className="text-[11px] text-text-muted">
                        {t('settings.jimengCliCredit')}
                      </span>
                      <span className="text-xs font-medium text-text-dark">
                        {Math.round(jimengCredit.totalCredit)}
                      </span>
                      {jimengCredit.vipLevel && (
                        <span className="text-[10px] text-text-muted">{jimengCredit.vipLevel}</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-md border border-border-dark bg-surface-dark/50 p-3 text-xs text-text-muted">
                  <p className="font-medium text-text-dark">{t('settings.jimengCliManualTitle')}</p>
                  <ol className="list-decimal space-y-2 pl-4">
                    <li className="space-y-1">
                      <p>{t('settings.jimengCliManualInstall')}</p>
                      <code className="block overflow-x-auto rounded bg-bg-dark px-2 py-1.5 text-[11px] text-text-dark">curl -fsSL https://jimeng.jianying.com/cli | bash</code>
                    </li>
                    <li className="space-y-1">
                      <p>{t('settings.jimengCliManualVerify')}</p>
                      <code className="block overflow-x-auto rounded bg-bg-dark px-2 py-1.5 text-[11px] text-text-dark">dreamina -h</code>
                    </li>
                    <li className="space-y-1">
                      <p>{t('settings.jimengCliManualLogin')}</p>
                      <code className="block overflow-x-auto rounded bg-bg-dark px-2 py-1.5 text-[11px] text-text-dark">dreamina login</code>
                    </li>
                    <li className="space-y-1">
                      <p>{t('settings.jimengCliManualOpenLink')}</p>
                    </li>
                    <li className="space-y-1">
                      <p>{t('settings.jimengCliManualFirstVideo')}</p>
                    </li>
                  </ol>
                </div>
              </div>
            </UiModal>

            {activeCategory === 'appearance' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.appearance')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.appearanceDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.radiusPreset')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.radiusPresetDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localUiRadiusPreset}
                        onChange={(event) =>
                          setLocalUiRadiusPreset(event.target.value as typeof localUiRadiusPreset)
                        }
                        className="h-9 text-sm"
                      >
                        <option value="compact">{t('settings.radiusCompact')}</option>
                        <option value="default">{t('settings.radiusDefault')}</option>
                        <option value="large">{t('settings.radiusLarge')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.themeTone')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.themeToneDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localThemeTonePreset}
                        onChange={(event) =>
                          setLocalThemeTonePreset(event.target.value as typeof localThemeTonePreset)
                        }
                        className="h-9 text-sm"
                      >
                        <option value="neutral">{t('settings.toneNeutral')}</option>
                        <option value="warm">{t('settings.toneWarm')}</option>
                        <option value="cool">{t('settings.toneCool')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.edgeRoutingMode')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.edgeRoutingModeDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localCanvasEdgeRoutingMode}
                        onChange={(event) =>
                          setLocalCanvasEdgeRoutingMode(
                            event.target.value as typeof localCanvasEdgeRoutingMode
                          )
                        }
                        className="h-9 text-sm"
                      >
                        <option value="spline">{t('settings.edgeRoutingSpline')}</option>
                        <option value="orthogonal">{t('settings.edgeRoutingOrthogonal')}</option>
                        <option value="smartOrthogonal">{t('settings.edgeRoutingSmartOrthogonal')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.accentColor')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.accentColorDesc')}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="color"
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        className="h-9 w-12 rounded border border-border-dark bg-surface-dark p-1"
                      />
                      <input
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        placeholder="#3B82F6"
                        className="h-9 flex-1 rounded border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none placeholder:text-text-muted"
                      />
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={() => setLocalAccentColor('#3B82F6')}
                      >
                        {t('settings.resetAccentColor')}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'pricing' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.pricing')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.pricingDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localShowNodePrice}
                    onCheckedChange={setLocalShowNodePrice}
                    title={t('settings.showNodePrice')}
                    description={t('settings.showNodePriceDesc')}
                  />

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.priceDisplayCurrencyMode')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.priceDisplayCurrencyModeDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localPriceDisplayCurrencyMode}
                        onChange={(event) =>
                          setLocalPriceDisplayCurrencyMode(
                            event.target.value as typeof localPriceDisplayCurrencyMode
                          )
                        }
                        className="h-9 text-sm"
                      >
                        <option value="auto">{t('settings.priceCurrencyAuto')}</option>
                        <option value="cny">{t('settings.priceCurrencyCny')}</option>
                        <option value="usd">{t('settings.priceCurrencyUsd')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.usdToCnyRate')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.usdToCnyRateDesc')}
                    </p>
                    <div className="mt-3">
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={localUsdToCnyRate}
                        onChange={(event) => setLocalUsdToCnyRate(event.target.value)}
                        className="h-9 w-full rounded border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none placeholder:text-text-muted"
                      />
                    </div>
                  </div>

                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'general' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.general')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.generalDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localStoryboardGenKeepStyleConsistent}
                    onCheckedChange={setLocalStoryboardGenKeepStyleConsistent}
                    title={t('settings.storyboardGenKeepStyleConsistent')}
                    description={t('settings.storyboardGenKeepStyleConsistentDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localIgnoreAtTagWhenCopyingAndGenerating}
                    onCheckedChange={setLocalIgnoreAtTagWhenCopyingAndGenerating}
                    title={t('settings.ignoreAtTagWhenCopyingAndGenerating')}
                    description={t('settings.ignoreAtTagWhenCopyingAndGeneratingDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenDisableTextInImage}
                    onCheckedChange={setLocalStoryboardGenDisableTextInImage}
                    title={t('settings.storyboardGenDisableTextInImage')}
                    description={t('settings.storyboardGenDisableTextInImageDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localUseUploadFilenameAsNodeTitle}
                    onCheckedChange={setLocalUseUploadFilenameAsNodeTitle}
                    title={t('settings.useUploadFilenameAsNodeTitle')}
                    description={t('settings.useUploadFilenameAsNodeTitleDesc')}
                  />

                  {/* 更新(原「关于」页移入) */}
                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-3">
                    <SettingsCheckboxCard
                      checked={localAutoCheckAppUpdateOnLaunch}
                      onCheckedChange={setLocalAutoCheckAppUpdateOnLaunch}
                      title={t('settings.autoCheckUpdateOnLaunch')}
                      description={t('settings.autoCheckUpdateOnLaunchDesc')}
                    />
                    <SettingsCheckboxCard
                      checked={localEnableUpdateDialog}
                      onCheckedChange={setLocalEnableUpdateDialog}
                      title={t('settings.enableUpdateDialog')}
                      description={t('settings.enableUpdateDialogDesc')}
                    />
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          void handleCheckUpdate();
                        }}
                        className="rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={checkUpdateStatus === 'checking'}
                      >
                        {checkUpdateStatus === 'checking'
                          ? t('settings.checkingUpdate')
                          : t('settings.checkUpdateNow')}
                      </button>
                      {checkUpdateStatus !== '' && (
                        <p className="mt-2 text-xs text-text-muted">
                          {checkUpdateStatus === 'has-update' && t('settings.checkUpdateHasUpdate')}
                          {checkUpdateStatus === 'up-to-date' && t('settings.checkUpdateUpToDate')}
                          {checkUpdateStatus === 'failed' && t('settings.checkUpdateFailed')}
                          {checkUpdateStatus === 'checking' && t('settings.checkingUpdate')}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'experimental' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.experimental')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.experimentalDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localEnableStoryboardGenGridPreviewShortcut}
                    onCheckedChange={setLocalEnableStoryboardGenGridPreviewShortcut}
                    title={t('settings.enableStoryboardGenGridPreviewShortcut')}
                    description={t('settings.enableStoryboardGenGridPreviewShortcutDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localShowStoryboardGenAdvancedRatioControls}
                    onCheckedChange={setLocalShowStoryboardGenAdvancedRatioControls}
                    title={t('settings.showStoryboardGenAdvancedRatioControls')}
                    description={t('settings.showStoryboardGenAdvancedRatioControlsDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenAutoInferEmptyFrame}
                    onCheckedChange={setLocalStoryboardGenAutoInferEmptyFrame}
                    title={t('settings.storyboardGenAutoInferEmptyFrame')}
                    description={t('settings.storyboardGenAutoInferEmptyFrameDesc')}
                  />
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
