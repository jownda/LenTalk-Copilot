import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Canvas } from './features/canvas/Canvas';
import { TitleBar } from './components/TitleBar';
import { SettingsDialog } from './components/SettingsDialog';
import { BillingDialog } from './components/BillingDialog';
import { UpdateAvailableDialog, type UpdateIgnoreMode } from './components/UpdateAvailableDialog';
import { GlobalErrorDialog } from './components/GlobalErrorDialog';
import { ProjectManager } from './features/project/ProjectManager';
import { useThemeStore } from './stores/themeStore';
import { useProjectStore } from './stores/projectStore';
import { useSettingsStore } from './stores/settingsStore';
import { jimengCliDetect, jimengCliInstall } from './commands/ai';
import {
  checkForUpdate,
  isUpdateVersionSuppressed,
  suppressUpdateVersion
} from './features/update/application/checkForUpdate';
import { subscribeOpenGlobalErrorDialog, type GlobalErrorDialogDetail } from './features/app/errorDialogEvents';
import { subscribeOpenSettingsDialog, type SettingsCategory } from './features/settings/settingsEvents';
import { TemplatePage } from './features/templates/TemplatePage';
import { TemplateDetailPage } from './features/templates/TemplateDetailPage';
import { TemplateGraphPage } from './features/templates/TemplateGraphPage';

function toRgbCssValue(hexColor: string): string {
  const hex = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return '59 130 246';
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function AppShell() {
  const { theme } = useThemeStore();
  const uiRadiusPreset = useSettingsStore((state) => state.uiRadiusPreset);
  const themeTonePreset = useSettingsStore((state) => state.themeTonePreset);
  const accentColor = useSettingsStore((state) => state.accentColor);
  const autoCheckAppUpdateOnLaunch = useSettingsStore((state) => state.autoCheckAppUpdateOnLaunch);
  const enableUpdateDialog = useSettingsStore((state) => state.enableUpdateDialog);
  const setEnableUpdateDialog = useSettingsStore((state) => state.setEnableUpdateDialog);
  const jimengCliExecutable = useSettingsStore((state) => state.jimengCli.executable);
  const setJimengCliAutoInstallStatus = useSettingsStore(
    (state) => state.setJimengCliAutoInstallStatus
  );
  const setJimengCliExecutable = useSettingsStore((state) => state.setJimengCliExecutable);
  const [showSettings, setShowSettings] = useState(false);
  const [showBilling, setShowBilling] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<SettingsCategory>('general');
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [currentVersion, setCurrentVersion] = useState<string>('');
  const [globalError, setGlobalError] = useState<GlobalErrorDialogDetail | null>(null);

  const isHydrated = useProjectStore((state) => state.isHydrated);
  const hydrate = useProjectStore((state) => state.hydrate);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const closeProject = useProjectStore((state) => state.closeProject);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.uiRadius = uiRadiusPreset;
  }, [uiRadiusPreset]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.themeTone = themeTonePreset;
  }, [themeTonePreset]);

  useEffect(() => {
    const root = document.documentElement;
    const isMac =
      typeof navigator !== 'undefined' &&
      /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
    root.dataset.platform = isMac ? 'macos' : 'default';
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const normalized = accentColor.startsWith('#') ? accentColor : `#${accentColor}`;
    root.style.setProperty('--accent', normalized);
    root.style.setProperty('--accent-rgb', toRgbCssValue(normalized));
  }, [accentColor]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const unsubscribe = subscribeOpenGlobalErrorDialog((detail) => {
      setGlobalError(detail);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOpenSettingsDialog(({ category }) => {
      setSettingsInitialCategory(category ?? 'general');
      setShowSettings(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof window.setTimeout> | null = null;

    const notifyFrontendReady = async (attempt = 1) => {
      if (cancelled) {
        return;
      }

      try {
        await invoke('frontend_ready');
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (attempt === 1 || attempt % 10 === 0) {
          console.warn('failed to notify frontend readiness', error);
        }

        const retryDelayMs = Math.min(500, 80 * attempt);
        retryTimer = window.setTimeout(() => {
          void notifyFrontendReady(attempt + 1);
        }, retryDelayMs);
      }
    };

    requestAnimationFrame(() => {
      void notifyFrontendReady();
    });

    return () => {
      cancelled = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  // 启动时自动检测即梦 CLI：未安装则在后台静默自动安装（不阻塞 UI、不弹窗），
  // 安装成功后自动配置 executable（仅当原设置不可用时写入，尊重手动配置）；
  // 任何失败都不影响主流程，状态在 Settings 弹窗可见，保证"失败不致命"。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let cancelled = false;
    setJimengCliAutoInstallStatus({
      state: 'detecting',
      message: '',
      resolvedPath: null,
      detectedAt: Date.now(),
    });

    (async () => {
      try {
        const result = await jimengCliDetect(jimengCliExecutable);
        if (cancelled) {
          return;
        }
        if (result.found) {
          setJimengCliAutoInstallStatus({
            state: 'ready',
            message: '',
            resolvedPath: result.resolvedPath,
            detectedAt: Date.now(),
          });
          return;
        }
        // 未检测到：静默后台自动安装。
        setJimengCliAutoInstallStatus({
          state: 'detecting',
          message: '未检测到即梦 CLI，正在后台自动安装…',
          resolvedPath: null,
          detectedAt: Date.now(),
        });
        const install = await jimengCliInstall();
        if (cancelled) {
          return;
        }
        if (install.success && install.resolvedPath) {
          setJimengCliAutoInstallStatus({
            state: 'ready',
            message: install.message,
            resolvedPath: install.resolvedPath,
            detectedAt: Date.now(),
          });
          setJimengCliExecutable(install.resolvedPath);
        } else {
          setJimengCliAutoInstallStatus({
            state: 'failed',
            message: install.message || '自动安装未完成',
            resolvedPath: null,
            detectedAt: Date.now(),
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setJimengCliAutoInstallStatus({
          state: 'idle',
          message: error instanceof Error ? error.message : String(error),
          resolvedPath: null,
          detectedAt: Date.now(),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jimengCliExecutable, setJimengCliAutoInstallStatus, setJimengCliExecutable]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    let cancelled = false;
    const runUpdateCheck = async () => {
      if (!autoCheckAppUpdateOnLaunch) {
        return;
      }
      const result = await checkForUpdate();
      if (!cancelled && result.hasUpdate && result.latestVersion && enableUpdateDialog) {
        if (isUpdateVersionSuppressed(result.latestVersion)) {
          return;
        }
        setLatestVersion(result.latestVersion ?? '');
        setCurrentVersion(result.currentVersion ?? '');
        setShowUpdateDialog(true);
      }
    };

    void runUpdateCheck();
    return () => {
      cancelled = true;
    };
  }, [isHydrated, autoCheckAppUpdateOnLaunch, enableUpdateDialog]);

  const handleManualCheckUpdate = async (): Promise<'has-update' | 'up-to-date' | 'failed'> => {
    const result = await checkForUpdate();
    if (!result.hasUpdate) {
      return result.error ? 'failed' : 'up-to-date';
    }

    setLatestVersion(result.latestVersion ?? '');
    setCurrentVersion(result.currentVersion ?? '');

    if (enableUpdateDialog) {
      setShowUpdateDialog(true);
    }

    return 'has-update';
  };

  const handleApplyIgnore = (mode: UpdateIgnoreMode) => {
    if (mode === 'forever-all') {
      setEnableUpdateDialog(false);
      return;
    }

    if (!latestVersion) {
      return;
    }

    suppressUpdateVersion(latestVersion, mode === 'today-version' ? 'today' : 'forever');
  };

  if (!isHydrated) {
    return (
      <ReactFlowProvider>
        <div className="w-full h-full bg-bg-dark" />
      </ReactFlowProvider>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="w-full h-full flex flex-col bg-bg-dark">
        <TitleBar
          onSettingsClick={() => {
            setSettingsInitialCategory('general');
            setShowSettings(true);
          }}
          onBillingClick={() => setShowBilling(true)}
          showBackButton={!!currentProjectId}
          onBackClick={closeProject}
        />

        <main className="relative min-h-0 min-w-0 flex-1">
          <Routes>
            <Route path="/templates" element={<TemplatePage />} />
            <Route path="/templates/:templateId/graph" element={<TemplateGraphPage />} />
            <Route path="/templates/:templateId" element={<TemplateDetailPage />} />
            <Route path="*" element={currentProjectId ? <Canvas /> : <ProjectManager />} />
          </Routes>
        </main>

        <SettingsDialog
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          initialCategory={settingsInitialCategory}
          onCheckUpdate={handleManualCheckUpdate}
        />
        <BillingDialog isOpen={showBilling} onClose={() => setShowBilling(false)} />
        <UpdateAvailableDialog
          isOpen={showUpdateDialog}
          onClose={() => setShowUpdateDialog(false)}
          latestVersion={latestVersion}
          currentVersion={currentVersion}
          onApplyIgnore={handleApplyIgnore}
        />
        <GlobalErrorDialog
          isOpen={Boolean(globalError)}
          title={globalError?.title ?? ''}
          message={globalError?.message ?? ''}
          details={globalError?.details}
          copyText={globalError?.copyText}
          onClose={() => setGlobalError(null)}
        />
      </div>
    </ReactFlowProvider>
  );
}

function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}

export default App;
