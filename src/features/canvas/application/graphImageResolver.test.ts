import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from "../domain/canvasNodes";
import { DefaultGraphImageResolver } from "./graphImageResolver";

function createNode(id: string, type: CanvasNode["type"], data: Record<string, unknown>): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  } as CanvasNode;
}

function createEdge(source: string, target: string): CanvasEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
  };
}

describe("DefaultGraphImageResolver", () => {
  it("collects all ordered frames from an upstream storyboard split node", () => {
    const targetId = "target";
    const resolver = new DefaultGraphImageResolver();
    const nodes = [
      createNode("storyboard", CANVAS_NODE_TYPES.storyboardSplit, {
        frames: [
          { id: "second", order: 2, imageUrl: "frame-2.png", note: "" },
          { id: "first", order: 1, imageUrl: "frame-1.png", note: "" },
        ],
      }),
      createNode(targetId, CANVAS_NODE_TYPES.imageEdit, {}),
    ];

    expect(resolver.collectInputImages(targetId, nodes, [createEdge("storyboard", targetId)])).toEqual([
      "frame-1.png",
      "frame-2.png",
    ]);
  });

  it("collects output images from every image-producing node type", () => {
    const targetId = "target";
    const resolver = new DefaultGraphImageResolver();
    const nodes = [
      createNode("storyboard-gen", CANVAS_NODE_TYPES.storyboardGen, {
        imageUrl: "storyboard-grid.png",
      }),
      createNode("panorama", CANVAS_NODE_TYPES.panorama, {
        inputImageUrl: "panorama-input.png",
        outputImageUrl: "framed-output.png",
      }),
      createNode("director-desk", CANVAS_NODE_TYPES.directorDesk, {
        lastCaptureUrl: "director-capture.png",
      }),
      createNode("mosaic", CANVAS_NODE_TYPES.seamlessMosaic, {
        outputImageUrl: "mosaic-output.png",
      }),
      createNode(targetId, CANVAS_NODE_TYPES.imageEdit, {}),
    ];
    const edges = [
      createEdge("storyboard-gen", targetId),
      createEdge("panorama", targetId),
      createEdge("director-desk", targetId),
      createEdge("mosaic", targetId),
    ];

    expect(resolver.collectInputImages(targetId, nodes, edges)).toEqual([
      "storyboard-grid.png",
      "framed-output.png",
      "director-capture.png",
      "mosaic-output.png",
    ]);
  });
});
