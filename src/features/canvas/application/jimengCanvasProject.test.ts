import { describe, expect, it } from 'vitest';
import {
  CANVAS_NAME_PREFIX,
  canvasNameForProject,
  pickCanvasForProject,
} from './jimengCanvasProject';

const PROJECT_ID = '3fa5626f-f323-4663-858c-7b8a8fa7266f';

describe('canvasNameForProject', () => {
  it('带工程 id 前 8 位，同名工程不会撞车', () => {
    expect(canvasNameForProject('分镜A', PROJECT_ID)).toBe('LenTalk-分镜A-3fa5626f');
    expect(canvasNameForProject('分镜A', '9c1d2e3f-0000-0000-0000-000000000000')).toBe(
      'LenTalk-分镜A-9c1d2e3f',
    );
  });

  it('没有工程名时用 Untitled 占位，不会生成 `LenTalk--xxxx`', () => {
    expect(canvasNameForProject('   ', PROJECT_ID)).toBe('LenTalk-Untitled-3fa5626f');
  });

  it('清掉会破坏命令行的字符并合并空白', () => {
    expect(canvasNameForProject('a/b:c*d?e|f\\g', PROJECT_ID)).toBe('LenTalk-a b c d e f g-3fa5626f');
    expect(canvasNameForProject('两  个   空格', PROJECT_ID)).toBe('LenTalk-两 个 空格-3fa5626f');
  });

  it('超长工程名截断，总长不超过 48 个字符', () => {
    const name = '很长的项目名称'.repeat(20);
    const result = canvasNameForProject(name, PROJECT_ID);
    expect(result.length).toBeLessThanOrEqual(48);
    expect(result.startsWith(CANVAS_NAME_PREFIX)).toBe(true);
    expect(result.endsWith('3fa5626f')).toBe(true);
  });
});

describe('pickCanvasForProject', () => {
  const projects = [
    { projectId: 'p-exact', name: 'LenTalk-分镜A-3fa5626f', updatedAt: 100 },
    { projectId: 'p-legacy', name: 'LenTalk-分镜A', updatedAt: 900 },
    { projectId: 'p-other', name: 'LenTalk-分镜B-3fa5626f', updatedAt: 999 },
    { projectId: 'p-shared', name: 'LenTalk', updatedAt: 500 },
  ];

  it('优先精确命中带 id 后缀的画布，不会被同工程的旧名抢走', () => {
    expect(pickCanvasForProject(projects, '分镜A', PROJECT_ID)?.projectId).toBe('p-exact');
  });

  it('只有旧命名(无 id 后缀)时也算命中 —— 升级后不会给同一工程再建一张', () => {
    const legacyOnly = [projects[1]!];
    expect(pickCanvasForProject(legacyOnly, '分镜A', PROJECT_ID)?.projectId).toBe('p-legacy');
  });

  it('不会误用别的工程的画布', () => {
    expect(pickCanvasForProject([projects[2]!], '分镜A', PROJECT_ID)).toBeNull();
  });

  it('没有任何命中时返回 null（调用方据此新建）', () => {
    expect(pickCanvasForProject([], '分镜A', PROJECT_ID)).toBeNull();
  });

  it('🔴 裸 `LenTalk`(老版共享画布) 不会被任何工程认领', () => {
    const sharedOnly = [projects[3]!];
    expect(pickCanvasForProject(sharedOnly, '分镜A', PROJECT_ID)).toBeNull();
    expect(pickCanvasForProject(sharedOnly, '分镜B', PROJECT_ID)).toBeNull();
  });

  it('同工程的多个同名候选取最近更新的那张', () => {
    const dupes = [
      { projectId: 'old', name: 'LenTalk-分镜A-3fa5626f', updatedAt: 10 },
      { projectId: 'new', name: 'LenTalk-分镜A-3fa5626f', updatedAt: 20 },
    ];
    expect(pickCanvasForProject(dupes, '分镜A', PROJECT_ID)?.projectId).toBe('new');
  });
});
