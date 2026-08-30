import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, FolderOpen, Image as ImageIcon, ImagePlus, Pencil, Trash2, Library, Boxes, Clapperboard } from 'lucide-react';
import { useProjectStore } from '@/stores/projectStore';
import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { UiButton, UiSelect } from '@/components/ui/primitives';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { AssetLibraryPanel } from '@/features/library/AssetLibraryPanel';
import { ThreeDDirectorDesk } from '@/features/threeDDirector/ThreeDDirectorDesk';
import { CinematicStudioWorkbench } from '@/features/cinematicStudio/CinematicStudioWorkbench';
import { RenameDialog } from './RenameDialog';

type ProjectSortField = 'name' | 'createdAt' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

export function ProjectManager() {
  const { t } = useTranslation();
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [sortField, setSortField] = useState<ProjectSortField>('updatedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  /** 项目卡片宽度(px, 由顶部滑杆调节, 网格固定宽度线性跟随) */
  const [thumbSize, setThumbSize] = useState(240);
  const [showLibrary, setShowLibrary] = useState(false);
  /** 素材库按钮底部视口 Y,素材库面板从此处下方平滑呼出(不顶到最顶部) */
  const [libraryAnchorTop, setLibraryAnchorTop] = useState(0);
  const [show3DDirector, setShow3DDirector] = useState(false);
  const [showCinematicStudio, setShowCinematicStudio] = useState(false);

  const { projects, isOpeningProject, createProject, deleteProject, renameProject, openProject } =
    useProjectStore();

  const handleCreateProject = () => {
    setEditingProjectId(null);
    setEditingProjectName('');
    setShowRenameDialog(true);
  };

  const handleRenameClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProjectId(id);
    setEditingProjectName(name);
    setShowRenameDialog(true);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteProject(id);
  };

  const handleConfirm = (name: string) => {
    if (editingProjectId) {
      renameProject(editingProjectId, name);
    } else {
      createProject(name);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  const sortedProjects = useMemo(() => {
    const list = [...projects];
    const direction = sortDirection === 'asc' ? 1 : -1;

    list.sort((a, b) => {
      if (sortField === 'name') {
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }) * direction;
      }

      const left = sortField === 'createdAt' ? a.createdAt : a.updatedAt;
      const right = sortField === 'createdAt' ? b.createdAt : b.updatedAt;
      return (left - right) * direction;
    });

    return list;
  }, [projects, sortDirection, sortField]);

  return (
    <div
      className="ui-scrollbar h-full w-full min-w-0 overflow-auto p-4 sm:p-6 lg:p-8"
      onDoubleClick={(event) => {
        // 双击空白区域新建项目(卡片/按钮/素材库面板上双击不触发)
        const target = event.target as HTMLElement;
        if (
          target.closest('[data-project-card]')
          || target.closest('[data-asset-library]')
          || target.closest('.director-desk-app')
          || target.closest('.cinematic-studio-app')
          || target.closest('button, select, input, a, textarea')
        ) {
          return;
        }
        handleCreateProject();
      }}
    >
      <div className="mx-auto w-full max-w-[1920px] min-w-0">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 lg:mb-8">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <h1 className="shrink-0 text-2xl font-bold text-text-dark">{t('project.title')}</h1>
            <div className="flex shrink-0 items-center gap-2">
              <UiSelect
                aria-label={t('project.sortBy')}
                value={sortField}
                onChange={(event) => setSortField(event.target.value as ProjectSortField)}
                className="h-9 w-[100px] rounded-lg text-sm"
              >
                <option value="name">{t('project.sortByName')}</option>
                <option value="createdAt">{t('project.sortByCreatedAt')}</option>
                <option value="updatedAt">{t('project.sortByUpdatedAt')}</option>
              </UiSelect>
              <UiSelect
                aria-label={t('project.sortDirection')}
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value as SortDirection)}
                className="h-9 w-[60px] rounded-lg text-sm"
              >
                <option value="asc">{t('project.sortAsc')}</option>
                <option value="desc">{t('project.sortDesc')}</option>
              </UiSelect>
            </div>
            {/* 项目卡片大小滑杆(线性丝滑) */}
            <div className="flex shrink-0 items-center gap-2 border-l border-border-dark pl-3">
              <ImagePlus className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                type="range"
                min={160}
                max={400}
                step={4}
                value={thumbSize}
                onChange={(event) => setThumbSize(Number(event.target.value))}
                aria-label={t('project.cardSize', '卡片大小')}
                title={t('project.cardSize', '卡片大小')}
                className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-border-dark accent-accent"
              />
              <span className="w-9 shrink-0 text-xs tabular-nums text-text-muted">{thumbSize}</span>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:shrink-0">
            <UiButton type="button" variant="muted" onClick={() => setShow3DDirector(true)} className="gap-2">
              <Boxes className="w-5 h-5" />
              3D导演台
            </UiButton>
            <UiButton type="button" variant="muted" onClick={() => setShowCinematicStudio(true)} className="gap-2">
              <Clapperboard className="w-5 h-5" />
              电影提示词工作室
            </UiButton>
            <UiButton
              type="button"
              variant="muted"
              onClick={(event) => {
                setLibraryAnchorTop(event.currentTarget.getBoundingClientRect().bottom);
                setShowLibrary(true);
              }}
              className="gap-2"
            >
              <Library className="w-5 h-5" />
              {t('project.assetLibrary')}
            </UiButton>
            <UiButton type="button" variant="primary" onClick={handleCreateProject} className="gap-2">
              <Plus className="w-5 h-5" />
              {t('project.newProject')}
            </UiButton>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-text-muted">
            <FolderOpen className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">{t('project.empty')}</p>
            <p className="text-sm mt-2">{t('project.emptyHint')}</p>
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${thumbSize}px), 1fr))` }}
          >
            {sortedProjects.map((project) => (
              <div
                key={project.id}
                data-project-card
                onClick={() => openProject(project.id)}
                className="bg-surface-dark border border-border-dark rounded-lg overflow-hidden cursor-pointer hover:border-primary/50 hover:shadow-lg transition-all group"
              >
                {/* 正方形四宫格缩略图封面(高度随卡片宽度等比联动) */}
                <div className="relative aspect-[1.89] w-full">
                  {project.thumbnails && project.thumbnails.length > 0 ? (
                    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-bg-dark p-px">
                      {[0, 1, 2, 3].map((index) => {
                        const url = project.thumbnails?.[index];
                        return (
                          <div
                            key={index}
                            className="relative overflow-hidden bg-bg-dark/60"
                          >
                            {url ? (
                              <img
                                src={resolveImageDisplayUrl(url)}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover"
                                draggable={false}
                                onError={(event) => {
                                  (event.currentTarget as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-bg-dark/60">
                                <ImageIcon className="h-4 w-4 text-text-muted/30" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-bg-dark/40">
                      <ImageIcon className="h-7 w-7 text-text-muted/30" />
                      <span className="text-[11px] text-text-muted/50">{t('project.noPreview', '暂无预览')}</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                </div>

                <div className="p-3">
                  <div className="flex items-start justify-between mb-1.5">
                    <h3 className="font-semibold text-text-dark truncate flex-1">
                      {project.name}
                    </h3>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => handleRenameClick(project.id, project.name, e)}
                        className="p-1 hover:bg-bg-dark rounded"
                        title={t('project.rename')}
                      >
                        <Pencil className="w-4 h-4 text-text-muted hover:text-text-dark" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteClick(project.id, e)}
                        className="p-1 hover:bg-bg-dark rounded"
                        title={t('project.delete')}
                      >
                        <Trash2 className="w-4 h-4 text-text-muted hover:text-red-500" />
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-text-muted">
                    <p>
                      {t('project.modified')}: {formatDate(project.updatedAt)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isOpeningProject && (
        <div className={`pointer-events-none fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} bg-black/10`} />
      )}

      <RenameDialog
        isOpen={showRenameDialog}
        title={editingProjectId ? t('project.renameTitle') : t('project.newProjectTitle')}
        defaultValue={editingProjectName}
        onClose={() => setShowRenameDialog(false)}
        onConfirm={handleConfirm}
      />

      <AssetLibraryPanel open={showLibrary} onClose={() => setShowLibrary(false)} fullscreen anchorTop={libraryAnchorTop} />

      {show3DDirector && <ThreeDDirectorDesk onClose={() => setShow3DDirector(false)} />}

      {showCinematicStudio && <CinematicStudioWorkbench onClose={() => setShowCinematicStudio(false)} />}
    </div>
  );
}
