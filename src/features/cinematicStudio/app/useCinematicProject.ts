import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectV2 } from "../shared-types";
import {
  loadProjectById,
  loadProjectFromDatabaseById,
  persistProjectById,
  persistProjectToDatabaseById,
} from "./model";
import { projectReducer, type ProjectAction } from "./store/projectReducer";
import { isTauri } from "@tauri-apps/api/core";

export interface CinematicProjectController {
  project: ProjectV2;
  projectStorageReady: boolean;
  dispatch: (action: ProjectAction) => void;
  setProject: Dispatch<SetStateAction<ProjectV2>>;
}

/**
 * 画布侧边栏「资产库」自持项目状态。
 *
 * 资产库是**独立于节点工程**的全局数据源（载体为历史全局工程）：
 * 不管画布上打开的是哪个工作室节点，这里读写的永远是同一份资产，
 * 因此不存在「新建/打开节点把资产库清空」的情况。
 *
 * 持久化与工作室 App 共用同一条通道（SQLite 优先 / localStorage 兜底）：
 * - enabled=true：hydrate 一次（每次重新启用都拉取最新，避免与工作室双实例漂移），变更后落库；
 * - enabled=false：不 hydrate、不持久化（工作室打开时由 bridge 提供实时状态，这里必须退位，避免双写互相覆盖）。
 */
export function useCinematicProject(enabled: boolean): CinematicProjectController {
  const [project, setProject] = useState<ProjectV2>(() => loadProjectById());
  const [projectStorageReady, setProjectStorageReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setProjectStorageReady(false);
      return;
    }
    let active = true;
    setProjectStorageReady(false);
    setProject(loadProjectById());
    void (async () => {
      const stored = await loadProjectFromDatabaseById();
      if (!active) return;
      if (stored) {
        setProject(stored);
      } else if (isTauri()) {
        // 资产库尚无存档时落一份，避免后续与工作室读到空。
        await persistProjectToDatabaseById(undefined, loadProjectById());
      }
      if (active) setProjectStorageReady(true);
    })();
    return () => {
      active = false;
    };
  }, [enabled]);

  // persist：enabled 且 storage 就绪后，每次结构变更落库（SQLite 失败回退 localStorage）。
  useEffect(() => {
    if (!enabled || !projectStorageReady) return;
    void persistProjectToDatabaseById(undefined, project).then((saved) => {
      if (!saved) persistProjectById(undefined, project);
    });
  }, [enabled, project, projectStorageReady]);

  const dispatch = useCallback((action: ProjectAction) => {
    setProject((prev) => projectReducer(prev, action));
  }, []);

  return { project, projectStorageReady, dispatch, setProject };
}
