import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 改名映射是模块级状态，每个用例前用 resetModules 拿一份干净的模块，
 * 避免用例之间互相污染（否则第一个用例记住的映射会影响后面所有断言）。
 */
async function loadModule() {
  vi.resetModules();
  return await import("./mediaRenames");
}

describe("mediaRenames", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("按整串精确匹配改写路径", async () => {
    const { rememberMediaRename, rewriteMediaPathInValue } = await loadModule();
    rememberMediaRename("/media/a.png", "/media/镜头1.png");

    const data = {
      imageUrl: "/media/a.png",
      prompt: "把 /media/a.png 里的人换掉",
      frames: [{ imageUrl: "/media/a.png" }],
    };
    const rewritten = rewriteMediaPathInValue(data, "/media/a.png", "/media/镜头1.png") as typeof data;

    expect(rewritten.imageUrl).toBe("/media/镜头1.png");
    expect(rewritten.frames[0].imageUrl).toBe("/media/镜头1.png");
    // 提示词是自由文本：只因为它不是「整串等于路径」才没被动，不能做子串替换。
    expect(rewritten.prompt).toBe("把 /media/a.png 里的人换掉");
  });

  it("file:// 与反斜杠写法都能命中", async () => {
    const { rememberMediaRename, resolveRenamedMediaPath } = await loadModule();
    rememberMediaRename("C:\\out\\a.png", "C:\\out\\镜头1.png");

    expect(resolveRenamedMediaPath("C:/out/a.png")).toBe("C:\\out\\镜头1.png");
    expect(resolveRenamedMediaPath("file:///C:/out/a.png")).toBe("C:\\out\\镜头1.png");
  });

  it("撤销快照里的旧路径会被修回新路径", async () => {
    const { rememberMediaRename, remapRenamedMediaPathsInNodes } = await loadModule();
    rememberMediaRename("/media/2026-11-26-11-20-41.png", "/media/开场.png");

    const nodes = [
      { id: "n1", data: { imageUrl: "/media/2026-11-26-11-20-41.png" } },
      { id: "n2", data: { prompt: "无关节点" } },
    ];
    const remapped = remapRenamedMediaPathsInNodes(nodes);

    expect(remapped[0].data.imageUrl).toBe("/media/开场.png");
    // 没命中的节点保持原引用，避免无谓的重渲染。
    expect(remapped[1]).toBe(nodes[1]);
  });

  it("没有改名记录时不改动节点数组", async () => {
    const { remapRenamedMediaPathsInNodes } = await loadModule();
    const nodes = [{ id: "n1", data: { imageUrl: "/media/a.png" } }];

    expect(remapRenamedMediaPathsInNodes(nodes)).toBe(nodes);
  });

  it("新旧路径相同不记账", async () => {
    const { rememberMediaRename, resolveRenamedMediaPath } = await loadModule();
    rememberMediaRename("/media/a.png", "/media/a.png");

    expect(resolveRenamedMediaPath("/media/a.png")).toBe("/media/a.png");
  });
});
