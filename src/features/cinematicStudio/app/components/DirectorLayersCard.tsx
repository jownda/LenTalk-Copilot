/**
 * 分层导演文档卡（P0.6）。
 * 展示 AI 编译产出的导演文档各层（directorLayers），默认收起、可展开编辑：
 * - 每层一个可折叠区块，标签为 canonical 层名（中/英友好）；
 * - 层内容可编辑，改动写入 scene.directorLayers；
 * - 每层可锁定（🔒），锁定层在再次 AI 编译时不被覆盖（见 App.aiCompileScene）。
 */
import { useState } from "react";
import type { SceneV2 } from "../../shared-types";
import { DIRECTOR_LAYERS, type DirectorLayerKey } from "../../engine";
import { ChevronDown, Lock, LockOpen } from "lucide-react";
import type { CopyZh, Locale } from "../i18n";

interface DirectorLayersCardProps {
  scene: SceneV2;
  t: CopyZh;
  locale: Locale;
  onUpdateScene(patch: Partial<SceneV2>): void;
}

export default function DirectorLayersCard({ scene, t, locale, onUpdateScene }: DirectorLayersCardProps) {
  const [openKey, setOpenKey] = useState<DirectorLayerKey | null>(null);
  const layers = scene.directorLayers ?? {};
  const locked = new Set(scene.lockedDirectorLayers ?? []);

  const toggleLock = (key: DirectorLayerKey) => {
    const next = new Set(locked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onUpdateScene({ lockedDirectorLayers: [...next] });
  };

  const updateLayer = (key: DirectorLayerKey, text: string) => {
    onUpdateScene({ directorLayers: { ...layers, [key]: text } });
  };

  return <section className="card director-layers-card">
    <div className="card-head">
      <div className="card-head-title"><span className="eyebrow">{t.directorDocument}</span></div>
    </div>
    <p className="hint-text">{t.directorLayersHint}</p>
    <div className="director-layers">
      {DIRECTOR_LAYERS.map((layer) => {
        const isLocked = locked.has(layer.key);
        const text = layers[layer.key] ?? "";
        const isOpen = openKey === layer.key;
        const label = locale === "zh" ? layer.zh : layer.en;
        return <div key={layer.key} className={`director-layer${isLocked ? " locked" : ""}`}>
          <div className="director-layer-head" onClick={() => setOpenKey(isOpen ? null : layer.key)}>
            <button className={`layer-lock${isLocked ? " active" : ""}`} title={isLocked ? t.unlockLayer : t.lockLayer} onClick={(event) => { event.stopPropagation(); toggleLock(layer.key); }}>
              {isLocked ? <Lock size={14} /> : <LockOpen size={14} />}
            </button>
            <span className="director-layer-label">{label}</span>
            {!text && <em className="layer-empty-mark">{t.directorLayerEmpty}</em>}
            <ChevronDown size={15} className={`director-layer-caret${isOpen ? "" : " collapsed"}`} />
          </div>
          {isOpen && (
            <textarea className="modal-textarea director-layer-textarea" value={text} placeholder={t.directorLayerEmpty} onChange={(event) => updateLayer(layer.key, event.target.value)} />
          )}
        </div>;
      })}
    </div>
  </section>;
}
