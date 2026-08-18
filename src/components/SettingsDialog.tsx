import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { X, Eye, EyeOff, Pencil, Plus, Trash2, ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { isVideoGenerationModelName, useSettingsStore } from '@/stores/settingsStore';
import { fetchProviderModels, testProviderConnection, verifyProviderUrl } from '@/commands/ai';
import { recommendedApis } from '@/features/settings/recommendedApis';
import { UiCheckbox, UiModal, UiSelect } from '@/components/ui';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { listModelProviders } from '@/features/canvas/models';
import { GRSAI_NANO_BANANA_PRO_MODEL_OPTIONS } from '@/features/canvas/models/providers/grsai';
import { GRSAI_CREDIT_TIERS } from '@/features/canvas/pricing/types';
import type { SettingsCategory } from '@/features/settings/settingsEvents';

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
    grsaiNanoBananaProModel,
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
    preferDiscountedPrice,
    grsaiCreditTierId,
    uiRadiusPreset,
    themeTonePreset,
    accentColor,
    canvasEdgeRoutingMode,
    autoCheckAppUpdateOnLaunch,
    enableUpdateDialog,
    setProviderApiKey,
    setJimengCliExecutable,
    addCustomApi,
    updateCustomApi,
    removeCustomApi,
    setGrsaiNanoBananaProModel,
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
    setPreferDiscountedPrice,
    setGrsaiCreditTierId,
    setUiRadiusPreset,
    setThemeTonePreset,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    setAutoCheckAppUpdateOnLaunch,
    setEnableUpdateDialog,
  } = useSettingsStore();
  const providers = useMemo(() => {
    const providerOrder = ['kie', 'ppio', 'fal', 'grsai'];
    const providerIndex = new Map(providerOrder.map((id, index) => [id, index]));
    // 推荐平台列表: 隐藏 KIE / 派欧云(ppio) / fal, 仅保留 grsai 等
    const hiddenProviderIds = new Set(['kie', 'ppio', 'fal']);
    return (
      listModelProviders()
        .filter((provider) => !provider.id.startsWith('custom:'))
        .filter((provider) => !hiddenProviderIds.has(provider.id))
        .slice()
        .sort((left, right) => {
          const leftIndex = providerIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
          const rightIndex = providerIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
          return leftIndex - rightIndex;
        })
    );
  }, []);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const [localApiKeys, setLocalApiKeys] = useState<Record<string, string>>(apiKeys);
  const [localGrsaiNanoBananaProModel, setLocalGrsaiNanoBananaProModel] = useState(
    grsaiNanoBananaProModel
  );
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
  const [localPreferDiscountedPrice, setLocalPreferDiscountedPrice] = useState(
    preferDiscountedPrice
  );
  const [localGrsaiCreditTierId, setLocalGrsaiCreditTierId] = useState(grsaiCreditTierId);
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
  const [expandedProviderIds, setExpandedProviderIds] = useState<Record<string, boolean>>({});
  const [recommendedApisExpanded, setRecommendedApisExpanded] = useState(false);
  const [showJimengCliSettings, setShowJimengCliSettings] = useState(false);
  const [localJimengCliExecutable, setLocalJimengCliExecutable] = useState(jimengCli.executable);
  const customApiSectionRef = useRef<HTMLDivElement>(null);
  const [showAddCustomApi, setShowAddCustomApi] = useState(false);
  const [editingCustomApiId, setEditingCustomApiId] = useState<string | null>(null);
  const [customApiDraft, setCustomApiDraft] = useState({
    name: '',
    baseUrl: '',
    apiKey: '',
    modelsText: '',
    videoModelsText: '',
    requestMode: 'async' as 'sync' | 'async',
    protocol: 'images' as 'images' | 'responses',
    referenceImageField: 'image' as 'image' | 'input_image',
  });
  const [customApiBusy, setCustomApiBusy] = useState<'idle' | 'testing' | 'fetching'>('idle');
  const [customApiStatus, setCustomApiStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [modelPickerMediaType, setModelPickerMediaType] = useState<'image' | 'video'>('image');
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [pickedModels, setPickedModels] = useState<string[]>([]);
  const [modelPickerSearch, setModelPickerSearch] = useState('');
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  /** 一键添加推荐平台(预填到新增表单) */
  const applyRecommendedApi = useCallback((api: (typeof recommendedApis)[number]) => {
    setEditingCustomApiId(null);
    setCustomApiDraft({
      name: api.name,
      baseUrl: api.baseUrl,
      apiKey: '',
      modelsText: api.models.join('\n'),
      videoModelsText: (api.videoModels ?? []).join('\n'),
      requestMode: 'async',
      protocol: 'images',
      referenceImageField: 'image',
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

  const saveJimengCliSettings = useCallback(() => {
    setJimengCliExecutable(localJimengCliExecutable);
    setShowJimengCliSettings(false);
  }, [localJimengCliExecutable, setJimengCliExecutable]);

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
  const handleFetchModels = useCallback(async (mediaType: 'image' | 'video') => {
    const baseUrl = customApiDraft.baseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) {
      setCustomApiStatus({ type: 'err', text: t('settings.customApiTestNeedUrl') });
      return;
    }
    setCustomApiBusy('fetching');
    setCustomApiStatus(null);
    try {
      const { models } = await fetchProviderModels(baseUrl, customApiDraft.apiKey.trim());
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
      const targetModels = models.filter(
        (model) => mediaType === 'video'
          ? isVideoGenerationModelName(model)
          : !videoModelIds.has(model.trim().toLowerCase()) && !isVideoGenerationModelName(model)
      );
      setFetchedModels(targetModels);
      const existing = new Set(
        (mediaType === 'video' ? customApiDraft.videoModelsText : customApiDraft.modelsText)
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
      const result = await testProviderConnection(baseUrl, apiKey);
      const models = result.models ?? [];
      const videoModelIds = new Set(
        customApiDraft.videoModelsText
          .split(/[\n,]/)
          .map((model) => model.trim().toLowerCase())
          .filter(Boolean)
      );
      const imageModels = models.filter((model) => !videoModelIds.has(model.trim().toLowerCase()));
      const hasNativeGptImage = models.some((model) => /^gpt-image-1(?:$|[-_])/i.test(model));
      setCustomApiDraft((previous) => ({
        ...previous,
        modelsText: imageModels.length > 0 ? imageModels.join('\n') : previous.modelsText,
        // 异步提交同时兼容平台直接返回图片和返回任务 ID 两种行为。
        requestMode: 'async',
        protocol: 'images',
        referenceImageField: hasNativeGptImage ? 'input_image' : 'image',
      }));
      setCustomApiStatus({
        type: 'ok',
        text: t('settings.customApiTestOk', { count: result.count ?? 0 }),
      });
    } catch (error) {
      setCustomApiStatus({
        type: 'err',
        text: `${t('settings.customApiTestFailed')} ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setCustomApiBusy('idle');
    }
  }, [customApiDraft.apiKey, customApiDraft.baseUrl, customApiDraft.videoModelsText, t]);

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
      requestMode: api.requestMode,
      protocol: api.protocol,
      referenceImageField: api.referenceImageField ?? 'image',
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
      requestMode: 'async',
      protocol: 'images',
      referenceImageField: 'image',
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
    const videoModelIds = new Set(videoModels.map((model) => model.toLowerCase()));
    const imageModels = models.filter(
      (model) => !videoModelIds.has(model.toLowerCase()) && !isVideoGenerationModelName(model)
    );
    if (!name || !baseUrl || (models.length === 0 && videoModels.length === 0)) {
      return;
    }
    if (editingCustomApiId) {
      updateCustomApi(editingCustomApiId, {
        name,
        baseUrl,
        apiKey: customApiDraft.apiKey.trim(),
        models: imageModels,
        videoModels,
        requestMode: customApiDraft.requestMode,
        protocol: customApiDraft.protocol,
        referenceImageField: customApiDraft.referenceImageField,
      });
    } else {
      addCustomApi({
        name,
        baseUrl,
        apiKey: customApiDraft.apiKey.trim(),
        models: imageModels,
        videoModels,
        requestMode: customApiDraft.requestMode,
        protocol: customApiDraft.protocol,
        referenceImageField: customApiDraft.referenceImageField,
      });
    }
    resetCustomApiForm();
  }, [addCustomApi, customApiDraft, editingCustomApiId, resetCustomApiForm, updateCustomApi]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setLocalApiKeys(apiKeys);
    setLocalGrsaiNanoBananaProModel(grsaiNanoBananaProModel);
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
    setLocalPreferDiscountedPrice(preferDiscountedPrice);
    setLocalGrsaiCreditTierId(grsaiCreditTierId);
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
    setGrsaiNanoBananaProModel(localGrsaiNanoBananaProModel);
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
    setPreferDiscountedPrice(localPreferDiscountedPrice);
    setGrsaiCreditTierId(localGrsaiCreditTierId);
    setUiRadiusPreset(localUiRadiusPreset);
    setThemeTonePreset(localThemeTonePreset);
    setAccentColor(localAccentColor);
    setCanvasEdgeRoutingMode(localCanvasEdgeRoutingMode);
    setAutoCheckAppUpdateOnLaunch(localAutoCheckAppUpdateOnLaunch);
    setEnableUpdateDialog(localEnableUpdateDialog);
    onClose();
  }, [
    localApiKeys,
    localGrsaiNanoBananaProModel,
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
    localPreferDiscountedPrice,
    localGrsaiCreditTierId,
    localUiRadiusPreset,
    localThemeTonePreset,
    localAccentColor,
    localCanvasEdgeRoutingMode,
    localAutoCheckAppUpdateOnLaunch,
    localEnableUpdateDialog,
    providers,
    setProviderApiKey,
    setGrsaiNanoBananaProModel,
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
    setPreferDiscountedPrice,
    setGrsaiCreditTierId,
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
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center`}>
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

                                {provider.id === 'grsai' && (
                                  <div className="mt-2.5">
                                    <div className="mb-1 text-[11px] font-medium text-text-dark">
                                      {t('settings.nanoBananaProModel')}
                                    </div>
                                    <p className="mb-1.5 text-[10px] text-text-muted">
                                      <Trans
                                        i18nKey="settings.nanoBananaProModelDesc"
                                        components={{
                                          modelListLink: (
                                            <a
                                              href="https://grsai.com/zh/dashboard/models"
                                              target="_blank"
                                              rel="noreferrer"
                                              className="text-accent hover:underline"
                                            />
                                          ),
                                        }}
                                      />
                                    </p>
                                    <UiSelect
                                      value={localGrsaiNanoBananaProModel}
                                      onChange={(event) =>
                                        setLocalGrsaiNanoBananaProModel(event.target.value)
                                      }
                                      className="h-8 text-xs"
                                    >
                                      {GRSAI_NANO_BANANA_PRO_MODEL_OPTIONS.map((option) => (
                                        <option key={option} value={option}>
                                          {option}
                                        </option>
                                      ))}
                                    </UiSelect>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* 第三方推荐平台(点「添加」预填自定义平台表单) */}
                      {recommendedApis.map((api) => (
                        <div
                          key={api.id}
                          className="flex flex-col rounded-md border border-border-dark bg-bg-dark p-3"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-text-dark">{api.name}</span>
                            <button
                              type="button"
                              onClick={() => applyRecommendedApi(api)}
                              className="rounded-md bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25"
                            >
                              {t('settings.recommendedApisAdd')}
                            </button>
                          </div>
                          <p className="mt-1 text-[11px] text-text-muted">{api.summary}</p>
                          {api.advantages.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {api.advantages.map((advantage) => (
                                <span
                                  key={advantage}
                                  className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
                                >
                                  {advantage}
                                </span>
                              ))}
                            </div>
                          )}
                          {api.models.length > 0 && (
                            <p className="mt-1 truncate text-[10px] text-text-muted/60">
                              {api.models.slice(0, 3).join(' · ')}
                              {api.models.length > 3 ? ' …' : ''}
                            </p>
                          )}
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
                      ))}
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
                          <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                        </span>
                        <span className="mt-0.5 block text-xs text-text-muted">
                          {t('settings.jimengCliDesc')}
                        </span>
                      </span>
                    </button>
                  </div>

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

                    {customApis.length === 0 && !showAddCustomApi && (
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
                      <div className="space-y-2">
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
                        {/* 验证连接会自动匹配请求模式、接口协议和参考图字段。 */}
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
                        modelPickerMediaType === 'video' ? '选择视频模型' : '选择图片模型'
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
                              <span className="truncate">{model}</span>
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

                    {customApis.map((api) => (
                      <div
                        key={api.id}
                        className="mb-2 flex items-center justify-between rounded-md border border-border-dark bg-bg-dark px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-text-dark">
                              {api.name}
                            </span>
                            <span className="truncate text-[10px] text-text-muted/70">
                              {api.baseUrl}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
                            <span>
                              {api.models.length} {t('settings.customApiModelCount')} ·{' '}
                              {api.apiKey ? t('settings.customApiKeySet') : t('settings.customApiKeyMissing')}
                            </span>
                          </div>
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

                <div className="space-y-2 rounded-md border border-border-dark bg-surface-dark/50 p-3 text-xs text-text-muted">
                  <p>{t('settings.jimengCliInstallStep')}</p>
                  <code className="block overflow-x-auto rounded bg-bg-dark px-2 py-1.5 text-[11px] text-text-dark">
                    curl -fsSL https://jimeng.jianying.com/cli | bash
                  </code>
                  <p>{t('settings.jimengCliLoginStep')}</p>
                  <code className="block rounded bg-bg-dark px-2 py-1.5 text-[11px] text-text-dark">
                    dreamina login
                  </code>
                  <p>{t('settings.jimengCliVideoNote')}</p>
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

                  <SettingsCheckboxCard
                    checked={localPreferDiscountedPrice}
                    onCheckedChange={setLocalPreferDiscountedPrice}
                    title={t('settings.preferDiscountedPrice')}
                    description={t('settings.preferDiscountedPriceDesc')}
                  />

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.grsaiCreditTier')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.grsaiCreditTierDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localGrsaiCreditTierId}
                        onChange={(event) =>
                          setLocalGrsaiCreditTierId(event.target.value as typeof localGrsaiCreditTierId)
                        }
                        className="h-9 text-sm"
                      >
                        {GRSAI_CREDIT_TIERS.map((tier) => (
                          <option key={tier.id} value={tier.id}>
                            {t('settings.grsaiCreditTierOption', {
                              price: tier.priceCny.toFixed(2),
                              credits: tier.credits.toLocaleString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US'),
                            })}
                          </option>
                        ))}
                      </UiSelect>
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
