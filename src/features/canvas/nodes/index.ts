import type { NodeTypes } from '@xyflow/react';

import { AudioNode } from './AudioNode';
import { CinematicStudioNode } from './CinematicStudioNode';
import { DirectorDeskNode } from './DirectorDeskNode';
import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageNode } from './ImageNode';
import { PanoramaNode } from './PanoramaNode';
import { PromptOptimizerNode } from './PromptOptimizerNode';
import { SeamlessMosaicNode } from './SeamlessMosaicNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { UploadNode } from './UploadNode';
import { VideoGenNode } from './VideoGenNode';

export const nodeTypes: NodeTypes = {
  audioNode: AudioNode,
  cinematicStudioNode: CinematicStudioNode,
  directorDeskNode: DirectorDeskNode,
  exportImageNode: ImageNode,
  groupNode: GroupNode,
  imageNode: ImageEditNode,
  panoramaNode: PanoramaNode,
  promptOptimizerNode: PromptOptimizerNode,
  seamlessMosaicNode: SeamlessMosaicNode,
  storyboardGenNode: StoryboardGenNode,
  storyboardNode: StoryboardNode,
  textAnnotationNode: TextAnnotationNode,
  uploadNode: UploadNode,
  videoGenNode: VideoGenNode,
};

export {
  AudioNode,
  CinematicStudioNode,
  DirectorDeskNode,
  GroupNode,
  ImageEditNode,
  ImageNode,
  PanoramaNode,
  PromptOptimizerNode,
  SeamlessMosaicNode,
  StoryboardGenNode,
  StoryboardNode,
  TextAnnotationNode,
  UploadNode,
  VideoGenNode,
};
