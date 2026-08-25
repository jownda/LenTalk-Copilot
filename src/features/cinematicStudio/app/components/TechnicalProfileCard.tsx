/**
 * 风格配方卡（P0.2 简化交互）
 * 折叠/展开态都只显示配方缩略图 tile（单击选配方 / 双击或编辑按钮进编辑模态）。
 * 11 个模块（影像格式/胶片/帧率/摄影语言/光线/色彩/表演/皮肤/物理/构图/锐化）
 * 全部入口迁入 RecipeEditorModal —— 折叠态卡片不再下挂模块列表。
 */
import { useMemo, useRef, useState } from "react";
import type { ProjectV2, TechnicalProfile } from "../../shared-types";
import {
  ACTING_PRESETS, CINEMATOGRAPHY_PRESETS, COLOR_PRESETS, COMPOSITION_PRESETS, FILM_PRESETS, FORMAT_PRESETS,
  LIGHTING_PRESETS, MASTER_STYLES, PHYSICS_PRESETS, SHARPNESS_PRESETS, SKIN_PRESETS, STYLE_RECIPES,
  recipeById, localizeRecipeTerm, type StyleRecipe,
} from "../../engine";
import { ChevronDown, Lock, LockOpen, Pencil, X } from "lucide-react";
import type { CopyZh, Locale } from "../i18n";

interface TechnicalProfileCardProps {
  project: ProjectV2;
  t: CopyZh;
  locale: Locale;
  onChange(profile: TechnicalProfile): void;
  onStyleChange?(styleId: string | undefined): void;
}

interface ModuleConfig {
  key: string;
  labelKey: string;
  presets: { id: string; zh: string; compile: string | string[]; compileZh?: string | string[] }[];
  kind: "array" | "single" | "frame" | "color";
}

const ALL_MODULE_KEYS = ["format", "filmStock", "cinematography", "lighting", "color", "acting", "skin", "physics", "composition", "sharpness"];

function recipeSwatch(recipe: StyleRecipe, locale: Locale): string[] {
  return (locale === "zh" && recipe.colorZh && recipe.colorZh.length > 0 ? recipe.colorZh : recipe.color).slice(0, 3);
}

export default function TechnicalProfileCard({ project, t, locale, onChange, onStyleChange }: TechnicalProfileCardProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const profile = project.technicalProfile ?? {};
  const recipe = recipeById(profile.recipeId);

  const modules: ModuleConfig[] = useMemo(() => [
    { key: "format", labelKey: "moduleFormat", presets: FORMAT_PRESETS, kind: "single" },
    { key: "filmStock", labelKey: "moduleFilm", presets: FILM_PRESETS, kind: "single" },
    { key: "cinematography", labelKey: "moduleCinematography", presets: CINEMATOGRAPHY_PRESETS, kind: "array" },
    { key: "lighting", labelKey: "moduleLighting", presets: LIGHTING_PRESETS, kind: "array" },
    { key: "color", labelKey: "moduleColor", presets: COLOR_PRESETS, kind: "color" },
    { key: "acting", labelKey: "moduleActing", presets: ACTING_PRESETS, kind: "array" },
    { key: "skin", labelKey: "moduleSkin", presets: SKIN_PRESETS, kind: "array" },
    { key: "physics", labelKey: "modulePhysics", presets: PHYSICS_PRESETS, kind: "array" },
    { key: "composition", labelKey: "moduleComposition", presets: COMPOSITION_PRESETS, kind: "array" },
    { key: "sharpness", labelKey: "moduleSharpness", presets: SHARPNESS_PRESETS, kind: "array" },
  ], [t]);

  /** 配方应用（不动 11 模块字段，只锁当前配方） */
  /** 应用配方：4 字段 + 推荐模块全部填好，并全部上锁（解锁后才能编辑） */
  const applyRecipe = (recipeId: string) => {
    if (!recipeId) {
      onChange({ ...profile, recipeId: undefined, cinematography: [], lighting: [], color: "", composition: [], lockedModules: [] });
      onStyleChange?.(undefined);
      return;
    }
    const r = recipeById(recipeId)!;
    // array 型推荐模块：preset id → compile 值数组（中文界面用 compileZh）
    const moduleValues = (key: string, presetId?: string): string[] | undefined => {
      if (!presetId) return undefined;
      const table = key === "acting" ? ACTING_PRESETS : key === "skin" ? SKIN_PRESETS : key === "physics" ? PHYSICS_PRESETS : key === "sharpness" ? SHARPNESS_PRESETS : null;
      if (!table) return undefined;
      const preset = table.find((p) => p.id === presetId);
      if (!preset) return undefined;
      const raw = Array.isArray(preset.compile) ? preset.compile : [preset.compile];
      const zhArr = preset.compileZh ? (Array.isArray(preset.compileZh) ? preset.compileZh : [preset.compileZh]) : null;
      return locale === "zh" && zhArr ? zhArr : raw;
    };
    const m = r.modules ?? {};
    const updates: Record<string, any> = {
      recipeId,
      cinematography: r.cinematography,
      lighting: r.lighting,
      color: (locale === "zh" && r.colorZh?.length ? r.colorZh : r.color).join(", "),
      composition: r.composition,
      format: m.format ?? profile.format,
      filmStock: m.filmStock ?? profile.filmStock,
      acting: moduleValues("acting", m.acting),
      skin: moduleValues("skin", m.skin),
      physics: moduleValues("physics", m.physics),
      sharpness: moduleValues("sharpness", m.sharpness),
      lockedModules: [...ALL_MODULE_KEYS],
    };
    onChange({ ...profile, ...updates });
    const master = MASTER_STYLES.find((s) => s.recipeId === recipeId);
    onStyleChange?.(master?.id);
  };

  /** 编辑模态保存：接收完整 patch（11 模块 + 锁定） */
  const saveEditorPatch = (patch: Partial<TechnicalProfile>) => {
    onChange({ ...profile, ...patch });
    const master = MASTER_STYLES.find((s) => s.recipeId === (patch.recipeId ?? profile.recipeId));
    onStyleChange?.(master?.id);
  };

  return <div className="tech-card">
    <RecipeTile recipe={recipe} locale={locale} t={t} onClick={() => setPickerOpen(true)} onEdit={() => setEditorOpen(true)} />

    {pickerOpen && (
      <RecipePickerModal
        currentId={profile.recipeId}
        locale={locale}
        t={t}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => { applyRecipe(id); setPickerOpen(false); }}
      />
    )}
    {editorOpen && (
      <RecipeEditorModal
        currentId={profile.recipeId}
        locale={locale}
        t={t}
        modules={modules}
        profile={profile}
        onClose={() => setEditorOpen(false)}
        onSave={(patch) => { saveEditorPatch(patch); setEditorOpen(false); }}
      />
    )}
  </div>;
}

/** 配方缩略图 tile（仿资产库 asset-tile）：单击选配方 / 双击或编辑按钮进编辑页 */
function RecipeTile({ recipe, locale, t, onClick, onEdit }: {
  recipe: StyleRecipe | undefined;
  locale: Locale;
  t: CopyZh;
  onClick(): void;
  onEdit(): void;
}) {
  const timer = useRef<number | undefined>(undefined);
  const handleClick = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onClick(), 220);
  };
  const handleDblClick = () => {
    if (timer.current) window.clearTimeout(timer.current);
    onEdit();
  };
  if (!recipe) {
    return <div className="recipe-tile-empty" onClick={handleClick} onDoubleClick={handleDblClick} title={t.editRecipe}>
      <span className="recipe-tile-swatch empty"><i /><i /><i /></span>
      <span className="recipe-tile-name muted">{t.recipeNone}</span>
      <button className="recipe-edit-btn" title={t.editRecipe} onClick={(event) => { event.stopPropagation(); onEdit(); }}><Pencil size={12} /></button>
    </div>;
  }
  const swatches = recipeSwatch(recipe, locale);
  return <div className="recipe-tile-card" onClick={handleClick} onDoubleClick={handleDblClick} title={t.editRecipe}>
    <span className="recipe-tile-swatch">{swatches.map((s, i) => <i key={i} style={{ background: `hsl(${160 + i * 70}, 45%, ${70 - i * 8}%)` }} title={s} />)}</span>
    <div className="tile-info">
      <div className="tile-name">{locale === "zh" ? recipe.name : recipe.nameEn}</div>
      <span className="recipe-tile-desc">{swatches.join(locale === "zh" ? "、" : ", ")}</span>
    </div>
    <button className="recipe-edit-btn" title={t.editRecipe} onClick={(event) => { event.stopPropagation(); onEdit(); }}><Pencil size={12} /></button>
  </div>;
}

/** 风格配方选择模态（单击）：14 个缩略图 + 自定义风格，点击即应用 */
function RecipePickerModal({ currentId, locale, t, onClose, onPick }: {
  currentId?: string;
  locale: Locale;
  t: CopyZh;
  onClose(): void;
  onPick(id: string): void;
}) {
  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal asset-modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <h2>{t.pickRecipe}</h2>
        <button className="modal-close" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="recipe-grid picker">
        {STYLE_RECIPES.map((r) => (
          <button key={r.id} className={`recipe-tile ${currentId === r.id ? "active" : ""}`} onClick={() => onPick(r.id)}>
            <span className="recipe-tile-swatch">{recipeSwatch(r, locale).map((_s, i) => <i key={i} style={{ background: `hsl(${160 + i * 70}, 45%, ${70 - i * 8}%)` }} />)}</span>
            <span className="recipe-tile-name">{locale === "zh" ? r.name : r.nameEn}</span>
          </button>
        ))}
        <button className="recipe-tile none" onClick={() => onPick("")}>
          <span className="recipe-tile-swatch empty"><i /><i /><i /></span>
          <span className="recipe-tile-name">{t.recipeNone}</span>
        </button>
      </div>
    </div>
  </div>;
}

/**
 * 配方编辑模态（双击/编辑按钮）：11 个模块全部可编辑
 * kind=single（影像格式/胶片）/ kind=frame（帧率）：preset select
 * kind=array（摄影语言/光线/表演/皮肤/物理/构图/锐化）：comma-separated textarea
 * kind=color（色彩）：textarea
 * 编辑后保存为完整 profile patch（包含锁定列表）。
 */
function RecipeEditorModal({ currentId, locale, t, modules, profile, onClose, onSave }: {
  currentId?: string;
  locale: Locale;
  t: CopyZh;
  modules: ModuleConfig[];
  profile: TechnicalProfile;
  onClose(): void;
  onSave(patch: Partial<TechnicalProfile>): void;
}) {
  const recipeId = currentId ?? "";
  const recipe = recipeById(recipeId);
  const join = (arr: string[]) => arr.join(locale === "zh" ? "，" : ", ");
  const toArray = (v: string) => v.split(/[,,， \n]/).map((s) => s.trim()).filter(Boolean);
  const zh = (arr: string[]) => arr.map((term) => localizeRecipeTerm(term, locale));

  const [state, setState] = useState<Record<string, any>>(() => {
    const r = recipeById(recipeId);
    const arrField = (v: string[] | undefined, src: string[] | undefined) => {
      const values = v ?? src ?? [];
      return join(zh(values));
    };
    const colorVal = (() => {
      if (profile.color) return profile.color;
      if (r) return join(locale === "zh" && r.colorZh?.length ? r.colorZh : r.color);
      return "";
    })();
    return {
      recipeId: recipeId || undefined,
      format: (profile.format ?? r?.id) as string ?? "",
      filmStock: profile.filmStock ?? "",
      fps: profile.fps ?? 24,
      shutterAngle: profile.shutterAngle ?? 180,
      cinematography: arrField(profile.cinematography, r?.cinematography),
      lighting: arrField(profile.lighting, r?.lighting),
      color: colorVal,
      acting: arrField(profile.acting, undefined),
      skin: arrField(profile.skin, undefined),
      physics: arrField(profile.physics, undefined),
      composition: arrField(profile.composition, r?.composition),
      sharpness: arrField(profile.sharpness, undefined),
      lockedModules: [...(profile.lockedModules ?? [])],
    };
  });

  const set = (patch: Partial<TechnicalProfile>) => setState({ ...state, ...patch });

  const presetValue = (module: ModuleConfig): string => {
    if (module.kind === "single") return (state[module.key as keyof TechnicalProfile] as string) ?? "";
    if (module.kind === "color") {
      const v = state.color ?? "";
      const matched = COLOR_PRESETS.find((p) => String(p.compile) === v || (locale === "zh" && p.compileZh && String(p.compileZh) === v));
      return matched?.id ?? "";
    }
    const current = (state[module.key as keyof TechnicalProfile] as string | undefined) ?? "";
    const matched = module.presets.find((p) => {
      const c = Array.isArray(p.compile) ? p.compile : [p.compile];
      const cz = p.compileZh ? (Array.isArray(p.compileZh) ? p.compileZh : [p.compileZh]) : null;
      return [...c, ...(cz ?? [])].some((v) => v === current);
    });
    return matched?.id ?? "";
  };

  const onPresetSelect = (module: ModuleConfig, presetId: string) => {
    if (!presetId) {
      if (module.kind === "single") set({ [module.key]: "" } as Partial<TechnicalProfile>);
      return;
    }
    const preset = module.presets.find((p) => p.id === presetId);
    if (!preset) return;
    if (module.kind === "single") {
      set({ [module.key]: presetId } as Partial<TechnicalProfile>);
    } else if (module.kind === "color") {
      const value = locale === "zh" && preset.compileZh ? String(preset.compileZh) : String(preset.compile);
      set({ color: value });
    } else {
      const rawArr = Array.isArray(preset.compile) ? preset.compile : [preset.compile];
      const zhArr = preset.compileZh ? (Array.isArray(preset.compileZh) ? preset.compileZh : [preset.compileZh]) : null;
      const compiled = locale === "zh" && zhArr ? zhArr : rawArr;
      const current = (state[module.key as keyof TechnicalProfile] as string | undefined) ?? "";
      const before = current ? toArray(current) : [];
      set({ [module.key]: [...before.filter((v) => !compiled.includes(v)), ...compiled].join(locale === "zh" ? "，" : ", ") } as Partial<TechnicalProfile>);
    }
  };

  const toggleLock = (key: string) => {
    const locked = new Set(state.lockedModules ?? []);
    if (locked.has(key)) locked.delete(key); else locked.add(key);
    set({ lockedModules: [...locked] as string[] });
  };

  const isLocked = (key: string) => (state.lockedModules ?? []).includes(key);

  const onSaveClick = () => {
    const patch: Record<string, any> = {
      recipeId: state.recipeId as string | undefined,
      format: state.format ? (state.format as string) : undefined,
      filmStock: state.filmStock ? (state.filmStock as string) : undefined,
      fps: state.fps as 24, shutterAngle: state.shutterAngle as 180,
      cinematography: toArray(state.cinematography ?? "") as string[],
      lighting: toArray(state.lighting ?? "") as string[],
      color: state.color ?? "",
      acting: toArray(state.acting ?? "") as string[],
      skin: toArray(state.skin ?? "") as string[],
      physics: toArray(state.physics ?? "") as string[],
      composition: toArray(state.composition ?? "") as string[],
      sharpness: toArray(state.sharpness ?? "") as string[],
      lockedModules: state.lockedModules as string[],
    };
    onSave(patch);
  };

  const onCustomStyle = () => {
    onSave({
      recipeId: undefined,
      cinematography: [], lighting: [], color: "", composition: [],
    });
  };

  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal asset-modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <h2>{t.editRecipe}{recipe ? ` · ${locale === "zh" ? recipe.name : recipe.nameEn}` : ""}</h2>
        <button className="modal-close" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="recipe-edit-fields">
        {modules.map((module) => {
          const label = t[module.labelKey as keyof CopyZh] as string;
          if (module.kind === "single") {
            return <div className="recipe-edit-row" key={module.key}>
              <div className="recipe-edit-row-head">
                <span className="recipe-edit-label">{label}</span>
                <button className={`tech-lock ${isLocked(module.key) ? "on" : ""}`} title={t.lockModule} onClick={() => toggleLock(module.key)}>
                  {isLocked(module.key) ? <Lock size={12} /> : <LockOpen size={12} />}
                </button>
              </div>
              <span className="select-wrap recipe-edit-select">
                <select value={presetValue(module)} onChange={(event) => onPresetSelect(module, event.target.value)}>
                  <option value="">{t.none}</option>
                  {module.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.zh}</option>)}
                </select><ChevronDown size={13} />
              </span>
            </div>;
          }
          const fieldKey = module.key as keyof TechnicalProfile;
          const value = (state[fieldKey] as string) ?? "";
          return <label className="field-label" key={module.key}>
            <div className="recipe-edit-row-head">
              <span>{label}</span>
              <button className={`tech-lock ${isLocked(module.key) ? "on" : ""}`} title={t.lockModule} onClick={() => toggleLock(module.key)}>
                {isLocked(module.key) ? <Lock size={12} /> : <LockOpen size={12} />}
              </button>
            </div>
            <textarea className="modal-textarea" rows={2} value={value} placeholder={t.custom} onChange={(event) => set({ [module.key]: event.target.value } as Partial<TechnicalProfile>)} />
          </label>;
        })}
        <span className="hint-text">{t.recipeEditHint}</span>
      </div>
      <div className="modal-actions">
        <button className="primary-button" onClick={onSaveClick}>{t.save}</button>
        <button className="outline-button" onClick={onCustomStyle}>{t.recipeNone}</button>
        <button className="outline-button" onClick={onClose}>{t.cancel}</button>
      </div>
    </div>
  </div>;
}
