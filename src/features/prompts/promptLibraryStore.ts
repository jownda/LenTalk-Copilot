import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { builtinPromptSeeds, type BuiltinPromptSeed } from './builtinPromptSeeds';

/** 提示词条目(对齐 Infinite Canvas:名称/用途说明/正向/负向) */
export interface PromptTemplate {
  id: string;
  name: string;
  /** 用途说明 */
  scene: string;
  /** 正向提示词 */
  positive: string;
  /** 负向提示词 */
  negative: string;
  category: string;
  createdAt: number;
  updatedAt: number;
}

/** 提示词库 */
export interface PromptLibrary {
  id: string;
  name: string;
  /** 只读词库(内置案例,不可增删改条目) */
  readonly?: boolean;
  items: PromptTemplate[];
  createdAt: number;
}

interface PromptLibraryStore {
  libraries: PromptLibrary[];
  /** 全局分组(分类)定义:允许存在空分组;条目中出现的分类会自动并入 */
  categories: string[];
  addLibrary: (name: string) => PromptLibrary | null;
  renameLibrary: (id: string, name: string) => void;
  deleteLibrary: (id: string) => void;
  addTemplate: (libraryId: string, template: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateTemplate: (libraryId: string, id: string, update: Partial<Omit<PromptTemplate, 'id' | 'createdAt'>>) => void;
  deleteTemplate: (libraryId: string, id: string) => void;
  addCategory: (name: string) => void;
  renameCategory: (oldName: string, newName: string) => void;
  deleteCategory: (name: string) => void;
}

const STORAGE_KEY = 'storyboard-prompt-library-v2';
const CATEGORIES_KEY = 'storyboard-prompt-categories-v1';

const BUILTIN_LIBRARY_ID = 'lib-builtin-canvas-prompts';

function seedFromBuiltin(): PromptTemplate[] {
  return builtinPromptSeeds.map((seed: BuiltinPromptSeed) => ({
    id: `prompt-${uuid().slice(0, 12)}`,
    name: seed.name,
    scene: seed.scene,
    positive: seed.positive,
    negative: seed.negative,
    category: seed.category,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

function buildBuiltinLibrary(): PromptLibrary {
  return {
    id: BUILTIN_LIBRARY_ID,
    name: '无限画布预设',
    readonly: true,
    items: seedFromBuiltin(),
    createdAt: Date.now(),
  };
}

function migrateLegacyData(): PromptLibrary[] {
  try {
    const legacy = localStorage.getItem('storyboard-prompt-library-v1');
    if (!legacy) {
      return [];
    }
    const parsed = JSON.parse(legacy);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // 迁移旧版条目(仅 name/content/category)到「我的提示词」库
    const legacyItems: Array<{ name?: string; content?: string; category?: string }> = parsed;
    if (legacyItems.length === 0) {
      return [];
    }
    const items: PromptTemplate[] = legacyItems.map((item) => ({
      id: `prompt-${uuid().slice(0, 12)}`,
      name: String(item.name ?? '提示词'),
      scene: '',
      positive: String(item.content ?? ''),
      negative: '',
      category: String(item.category ?? 'custom'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    return [{
      id: `lib-${uuid().slice(0, 12)}`,
      name: '我的提示词',
      items,
      createdAt: Date.now(),
    }];
  } catch {
    return [];
  }
}

/** 清洗持久化数据:过滤缺 id/items 的损坏条目,防止历史脏数据导致启动崩溃 */
function sanitizeLibraries(value: unknown): PromptLibrary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((lib) => {
    if (!lib || typeof lib !== 'object') {
      return [];
    }
    const candidate = lib as Partial<PromptLibrary>;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0 || !Array.isArray(candidate.items)) {
      return [];
    }
    const items = candidate.items.filter((item): item is PromptTemplate => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const entry = item as Partial<PromptTemplate>;
      return typeof entry.id === 'string' && entry.id.length > 0;
    });
    return [{
      id: candidate.id,
      name: typeof candidate.name === 'string' ? candidate.name : '提示词库',
      ...(candidate.readonly === true ? { readonly: true } : {}),
      items,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    }];
  });
}

function readLibraries(): PromptLibrary[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    const parsed = value ? JSON.parse(value) : null;
    const sanitized = sanitizeLibraries(parsed);
    if (sanitized.length > 0) {
      // 确保内置库始终存在:存储中有内置库则用存储版本(用户可编辑),
      // 没有则补充种子内置库(兼容旧版本只存用户库的情况),并立即写回
      const hasBuiltin = sanitized.some((lib: PromptLibrary) => lib.id === BUILTIN_LIBRARY_ID);
      if (!hasBuiltin) {
        const merged = [buildBuiltinLibrary(), ...sanitized];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch {
          // 忽略写入失败
        }
        return merged;
      }
      return sanitized;
    }
    // 无数据或空数组时:内置库 + 旧版迁移
    const migrated = migrateLegacyData();
    if (migrated.length > 0) {
      localStorage.removeItem('storyboard-prompt-library-v1');
      return [buildBuiltinLibrary(), ...migrated];
    }
    return [buildBuiltinLibrary()];
  } catch {
    return [buildBuiltinLibrary()];
  }
}

function persist(libraries: PromptLibrary[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(libraries));
  } catch {
    // 忽略写入失败
  }
}

function readCategories(): string[] {
  try {
    const value = localStorage.getItem(CATEGORIES_KEY);
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

function persistCategories(categories: string[]): void {
  try {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
  } catch {
    // 忽略写入失败
  }
}

export const usePromptLibraryStore = create<PromptLibraryStore>((set, get) => ({
  libraries: readLibraries(),
  categories: readCategories(),

  addLibrary: (name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }
    const library: PromptLibrary = {
      id: `lib-${uuid().slice(0, 12)}`,
      name: trimmed,
      items: [],
      createdAt: Date.now(),
    };
    const libraries = [...get().libraries, library];
    set({ libraries });
    persist(libraries);
    return library;
  },

  renameLibrary: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const libraries = get().libraries.map((library) =>
      library.id === id ? { ...library, name: trimmed } : library
    );
    set({ libraries });
    persist(libraries);
  },

  deleteLibrary: (id) => {
    const libraries = get().libraries.filter((library) => library.id !== id);
    set({ libraries });
    persist(libraries);
  },

  addTemplate: (libraryId, template) => {
    const library = get().libraries.find((lib) => lib.id === libraryId);
    if (!library) {
      return;
    }
    const now = Date.now();
    const item: PromptTemplate = {
      ...template,
      id: `prompt-${uuid().slice(0, 12)}`,
      createdAt: now,
      updatedAt: now,
    };
    const libraries = get().libraries.map((lib) =>
      lib.id === libraryId
        ? { ...lib, items: [...lib.items, item] }
        : lib
    );
    set({ libraries });
    persist(libraries);
  },

  updateTemplate: (libraryId, id, update) => {
    const library = get().libraries.find((lib) => lib.id === libraryId);
    if (!library) {
      return;
    }
    const libraries = get().libraries.map((lib) =>
      lib.id === libraryId
        ? {
            ...lib,
            items: lib.items.map((item) =>
              item.id === id
                ? { ...item, ...update, updatedAt: Date.now() }
                : item
            ),
          }
        : lib
    );
    set({ libraries });
    persist(libraries);
  },

  deleteTemplate: (libraryId, id) => {
    const library = get().libraries.find((lib) => lib.id === libraryId);
    if (!library) {
      return;
    }
    const libraries = get().libraries.map((lib) =>
      lib.id === libraryId
        ? { ...lib, items: lib.items.filter((item) => item.id !== id) }
        : lib
    );
    set({ libraries });
    persist(libraries);
  },

  addCategory: (name) => {
    const trimmed = name.trim();
    if (!trimmed || get().categories.includes(trimmed)) {
      return;
    }
    const categories = [...get().categories, trimmed];
    set({ categories });
    persistCategories(categories);
  },

  renameCategory: (oldName, newName) => {
    const oldTrimmed = oldName.trim();
    const newTrimmed = newName.trim();
    if (!oldTrimmed || !newTrimmed || oldTrimmed === newTrimmed) {
      return;
    }
    // categories 中 old→new;若 old 不在 categories(如仅出现在条目分类中),
    // 仍把 new 加入 categories,保证新分组名可继续管理
    const hasOld = get().categories.includes(oldTrimmed);
    const categories = hasOld
      ? get().categories.map((category) => (category === oldTrimmed ? newTrimmed : category))
      : [...get().categories, newTrimmed];
    set({ categories });
    persistCategories(categories);
    // 同步更新所有非只读词库中该分类条目的分类
    const libraries = get().libraries.map((lib) =>
      lib.readonly
        ? lib
        : {
            ...lib,
            items: lib.items.map((item) =>
              item.category === oldTrimmed
                ? { ...item, category: newTrimmed, updatedAt: Date.now() }
                : item
            ),
          }
    );
    set({ libraries });
    persist(libraries);
  },

  deleteCategory: (name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const categories = get().categories.filter((category) => category !== trimmed);
    set({ categories });
    persistCategories(categories);
    // 删除所有非只读词库中该分类的条目
    const libraries = get().libraries.map((lib) =>
      lib.readonly
        ? lib
        : { ...lib, items: lib.items.filter((item) => item.category !== trimmed) }
    );
    set({ libraries });
    persist(libraries);
  },
}));
