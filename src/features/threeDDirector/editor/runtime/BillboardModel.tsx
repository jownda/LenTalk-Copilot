import { useMemo } from "react";
import { Billboard, useTexture } from "@react-three/drei";
import { DoubleSide } from "three";

interface BillboardModelProps {
  imageUrl: string;
  aspectRatio?: number;
  faceCamera?: boolean;
}

const BILLBOARD_WIDTH = 1.6;

/** 2D 立绘卡:参考图贴在平面上,默认面向相机(Billboard),可切换固定朝向 */
export function BillboardModel({
  imageUrl,
  aspectRatio = 1,
  faceCamera = true,
}: BillboardModelProps) {
  const texture = useTexture(imageUrl);
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const width = BILLBOARD_WIDTH;
  const height = width / ratio;

  const card = useMemo(
    () => (
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} side={DoubleSide} transparent />
      </mesh>
    ),
    [height, texture, width]
  );

  if (faceCamera) {
    return <Billboard>{card}</Billboard>;
  }

  return card;
}
