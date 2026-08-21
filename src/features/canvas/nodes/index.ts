import type { NodeTypes } from '@xyflow/react';

import { AudioNode } from './AudioNode';
import { DirectorDeskNode } from './DirectorDeskNode';
import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageNode } from './ImageNode';
import { PanoramaNode } from './PanoramaNode';
import { SeamlessMosaicNode } from './SeamlessMosaicNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { UploadNode } from './UploadNode';
import { VideoGenNode } from './VideoGenNode';

export const nodeTypes: NodeTypes = {
  audioNode: AudioNode,
  directorDeskNode: DirectorDeskNode,
  exportImageNode: ImageNode,
  groupNode: GroupNode,
  imageNode: ImageEditNode,
  panoramaNode: PanoramaNode,
  seamlessMosaicNode: SeamlessMosaicNode,
  storyboardGenNode: StoryboardGenNode,
  storyboardNode: StoryboardNode,
  textAnnotationNode: TextAnnotationNode,
  uploadNode: UploadNode,
  videoGenNode: VideoGenNode,
};

export {
  AudioNode,
  DirectorDeskNode,
  GroupNode,
  ImageEditNode,
  ImageNode,
  PanoramaNode,
  SeamlessMosaicNode,
  StoryboardGenNode,
  StoryboardNode,
  TextAnnotationNode,
  UploadNode,
  VideoGenNode,
};
