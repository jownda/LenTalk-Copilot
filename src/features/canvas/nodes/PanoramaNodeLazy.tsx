import { Suspense, lazy, type ComponentProps } from 'react';

/**
 * 全景节点的懒加载外壳。
 *
 * 全景节点内部用 three 做 WebGL 球面投影 + 离屏截帧，连 three 内核一起约 1MB；
 * 而注册表（`nodes/index.ts`）是模块级常量，静态 import 就等于「不管画布上有没有
 * 全景节点，首屏都要先把 three 载进来」。这里把组件本体挪到按需 chunk，
 * 只有真的画了一个全景节点时才去加载。
 */
const LazyPanoramaNode = lazy(() =>
  import('./PanoramaNode').then((module) => ({ default: module.PanoramaNode })),
);

type PanoramaNodeProps = ComponentProps<typeof LazyPanoramaNode>;

export function PanoramaNode(props: PanoramaNodeProps) {
  return (
    <Suspense
      fallback={
        <div
          className="rounded-xl border border-border-dark bg-surface-dark"
          style={{ width: props.width ?? 360, height: props.height ?? 240 }}
        />
      }
    >
      <LazyPanoramaNode {...props} />
    </Suspense>
  );
}
