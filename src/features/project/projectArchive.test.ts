import { describe, expect, it } from 'vitest';

import { createProjectArchive, parseProjectArchive } from './projectArchive';

const project = {
  id: 'source-project',
  name: '地铁追逐',
  createdAt: 100,
  updatedAt: 200,
  nodeCount: 1,
  thumbnails: ['__img_ref__:0'],
  nodesJson: '[{"id":"node-1"}]',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[],"imagePool":["data:image/png;base64,abc"]}',
};

describe('project archive import', () => {
  it('reads an exported project archive', async () => {
    const archive = createProjectArchive(project);

    expect(parseProjectArchive(await archive.text())).toEqual(project);
  });

  it('rejects files that are not LenTalk project archives', () => {
    expect(() => parseProjectArchive('{"project":{}}')).toThrow('不是受支持的 LenTalk 项目文件。');
  });
});
