import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HUE_RANGE_LABELS,
  createDefaultAdjust,
  defaultCurve,
  defaultHueRange,
  defaultLevelsChannel,
  isAdjustIdentity,
  type MosaicAdjust,
  type MosaicChannelMixer,
  type MosaicColorBalance,
  type MosaicCurvePoint,
  type MosaicGradientStop,
  type MosaicLevelsChannel,
} from "@/features/canvas/domain/mosaicAdjust";
import { histogramOf, sampleCurveLut, type AdjustHistogram } from "@/features/canvas/application/mosaicAdjust";

type AdjustType =
  | "curves"
  | "levels"
  | "hsl"
  | "balance"
  | "blackWhite"
  | "mixer"
  | "filter"
  | "gradient"
  | "lookup"
  | "tone";

const TYPES: { id: AdjustType; label: string }[] = [
  { id: "tone", label: "亮度" },
  { id: "levels", label: "色阶" },
  { id: "curves", label: "曲线" },
  { id: "hsl", label: "色相/HS" },
  { id: "balance", label: "色彩" },
  { id: "blackWhite", label: "黑白" },
  { id: "mixer", label: "通道" },
  { id: "filter", label: "滤镜" },
  { id: "gradient", label: "渐变" },
  { id: "lookup", label: "LUT" },
];

type CurveChannel = "rgb" | "r" | "g" | "b";
type LevelsChannel = "master" | "r" | "g" | "b";

const CURVE_CHANNELS: { id: CurveChannel; label: string; stroke: string }[] = [
  { id: "rgb", label: "RGB", stroke: "#e6e6e6" },
  { id: "r", label: "红", stroke: "#ff6b6b" },
  { id: "g", label: "绿", stroke: "#4ade80" },
  { id: "b", label: "蓝", stroke: "#60a5fa" },
];

const LEVELS_CHANNELS: { id: LevelsChannel; label: string }[] = [
  { id: "master", label: "RGB" },
  { id: "r", label: "红" },
  { id: "g", label: "绿" },
  { id: "b", label: "蓝" },
];

const BALANCE_RANGES: { id: keyof Omit<MosaicColorBalance, "preserveLuminosity">; label: string }[] = [
  { id: "shadows", label: "阴影" },
  { id: "midtones", label: "中间调" },
  { id: "highlights", label: "高光" },
];

const BALANCE_AXES: { index: 0 | 1 | 2; left: string; right: string; track: string }[] = [
  { index: 0, left: "青", right: "红", track: "linear-gradient(90deg,#22d3ee,#ef4444)" },
  { index: 1, left: "洋红", right: "绿", track: "linear-gradient(90deg,#d946ef,#22c55e)" },
  { index: 2, left: "黄", right: "蓝", track: "linear-gradient(90deg,#eab308,#3b82f6)" },
];

const LOOKUPS: { id: string; label: string }[] = [
  { id: "teal-orange", label: "青橙电影" },
  { id: "fade", label: "褪色" },
  { id: "cool", label: "冷调" },
  { id: "vintage", label: "复古" },
  { id: "punch", label: "浓郁" },
];

interface MosaicAdjustPanelProps {
  adjust: MosaicAdjust | undefined;
  onChange: (next: MosaicAdjust) => void;
  /** 已经应用过调整的预览图，用来算直方图 */
  previewUrl: string;
  disabled?: boolean;
}

const INPUT_CLASS =
  "h-6 w-14 rounded border border-[#3f3f41] bg-[#1f1f20] px-1 text-[11px] text-[#ddd] outline-none";

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  track,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  suffix?: string;
  track?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-[#9a9a9a]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 w-full accent-[#0a84ff]"
        style={track ? { background: track } : undefined}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={INPUT_CLASS}
      />
      {suffix && <span className="w-3 text-[10px] text-[#7f7f7f]">{suffix}</span>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-[#9a9a9a]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-[#0a84ff]"
      />
      {label}
    </label>
  );
}

function Histogram({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [histogram, setHistogram] = useState<AdjustHistogram | null>(null);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0, 256, 1);
      try {
        setHistogram(histogramOf(context.getImageData(0, 0, 256, 1).data));
      } catch {
        setHistogram(null);
      }
    };
    image.onerror = () => setHistogram(null);
    image.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#141416";
    context.fillRect(0, 0, width, height);
    if (!histogram) return;
    const channels: [Uint32Array, string][] = [
      [histogram.r, "rgba(239,68,68,0.55)"],
      [histogram.g, "rgba(34,197,94,0.55)"],
      [histogram.b, "rgba(59,130,246,0.55)"],
    ];
    context.globalCompositeOperation = "lighter";
    for (const [bins, color] of channels) {
      context.fillStyle = color;
      for (let i = 0; i < 256; i += 1) {
        const ratio = Math.min(1, bins[i] / histogram.max);
        const binHeight = Math.round(ratio * (height - 2));
        if (binHeight <= 0) continue;
        context.fillRect((i / 256) * width, height - binHeight, Math.max(1, width / 256), binHeight);
      }
    }
    context.globalCompositeOperation = "source-over";
  }, [histogram]);

  return (
    <canvas
      ref={canvasRef}
      width={264}
      height={86}
      className="h-[86px] w-full rounded border border-[#3a3a3c] bg-[#141416]"
    />
  );
}

/** 曲线编辑：拖点、空白处加点、双击中点删点。 */
function CurveEditor({
  points,
  stroke,
  onChange,
}: {
  points: MosaicCurvePoint[];
  stroke: string;
  onChange: (next: MosaicCurvePoint[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const path = useMemo(() => {
    const lut = sampleCurveLut(points);
    let d = "";
    for (let i = 0; i < 256; i += 1) {
      d += `${i === 0 ? "M" : "L"}${((i / 255) * 100).toFixed(2)},${(100 - (lut[i] / 255) * 100).toFixed(2)}`;
    }
    return d;
  }, [points]);

  const toValue = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.round(Math.min(255, Math.max(0, ((clientX - rect.left) / rect.width) * 255))),
      y: Math.round(Math.min(255, Math.max(0, 255 - ((clientY - rect.top) / rect.height) * 255))),
    };
  }, []);

  useEffect(() => {
    if (dragIndex === null) return;
    const handleMove = (event: PointerEvent) => {
      event.preventDefault();
      const { x, y } = toValue(event.clientX, event.clientY);
      const next = points.map((point) => ({ ...point }));
      const sorted = [...next].sort((a, b) => a.x - b.x);
      const target = next[dragIndex];
      if (!target) return;
      const position = sorted.indexOf(target);
      const minX = position > 0 ? sorted[position - 1].x + 1 : 0;
      const maxX = position < sorted.length - 1 ? sorted[position + 1].x - 1 : 255;
      target.x = Math.min(maxX, Math.max(minX, x));
      target.y = y;
      onChange(next);
    };
    const handleUp = () => setDragIndex(null);
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragIndex, onChange, points, toValue]);

  const sorted = [...points].sort((a, b) => a.x - b.x);

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-[190px] w-full cursor-crosshair rounded border border-[#3a3a3c] bg-[#141416]"
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const { x, y } = toValue(event.clientX, event.clientY);
          onChange([...points, { x, y }].sort((a, b) => a.x - b.x));
        }}
      >
        {[25, 50, 75].map((value) => (
          <g key={value}>
            <line x1={value} y1={0} x2={value} y2={100} stroke="#2a2a2c" strokeWidth={0.4} />
            <line x1={0} y1={value} x2={100} y2={value} stroke="#2a2a2c" strokeWidth={0.4} />
          </g>
        ))}
        <line x1={0} y1={100} x2={100} y2={0} stroke="#333" strokeWidth={0.5} strokeDasharray="2 2" />
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        {sorted.map((point, index) => (
          <circle
            key={`${point.x}-${point.y}-${index}`}
            cx={(point.x / 255) * 100}
            cy={100 - (point.y / 255) * 100}
            r={2.2}
            fill="#0a84ff"
            stroke="#fff"
            strokeWidth={0.6}
            vectorEffect="non-scaling-stroke"
            className="cursor-grab"
            onPointerDown={(event) => {
              event.stopPropagation();
              const originalIndex = points.indexOf(point);
              setDragIndex(originalIndex >= 0 ? originalIndex : index);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (point.x === 0 || point.x === 255) return;
              onChange(points.filter((item) => item !== point));
            }}
          />
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-[#7f7f7f]">
        <span>暗</span>
        <span>双击控制点删除</span>
        <span>亮</span>
      </div>
    </div>
  );
}

/**
 * 调整面板（图层级）。
 *
 * 上：直方图；中：调整类型清单（有改动的项带圆点）；下：当前类型的参数。
 * 全部参数写在图层上，源图不动，随时可复位。
 */
export function MosaicAdjustPanel({ adjust, onChange, previewUrl, disabled }: MosaicAdjustPanelProps) {
  const [type, setType] = useState<AdjustType>("curves");
  const [curveChannel, setCurveChannel] = useState<CurveChannel>("rgb");
  const [levelsChannel, setLevelsChannel] = useState<LevelsChannel>("master");
  const [balanceRange, setBalanceRange] = useState<"shadows" | "midtones" | "highlights">("midtones");
  const [hueRangeIndex, setHueRangeIndex] = useState(0);

  const current = adjust ?? createDefaultAdjust();
  const touchedAll = !isAdjustIdentity(current);

  const patch = useCallback(
    (partial: Partial<MosaicAdjust>) => onChange({ ...current, ...partial }),
    [current, onChange],
  );

  const patchLevels = useCallback(
    (channel: LevelsChannel, partial: Partial<MosaicLevelsChannel>) => {
      patch({ levels: { ...current.levels, [channel]: { ...current.levels[channel], ...partial } } });
    },
    [current.levels, patch],
  );

  const patchMixer = useCallback(
    (partial: Partial<MosaicChannelMixer>) => patch({ channelMixer: { ...current.channelMixer, ...partial } }),
    [current.channelMixer, patch],
  );

  const typesWithChanges = useMemo(() => {
    const map = new Set<AdjustType>();
    if (current.brightness || current.contrast || current.exposure) map.add("tone");
    const levels = current.levels;
    if (
      [levels.master, levels.r, levels.g, levels.b].some(
        (channel) => channel.black !== 0 || channel.white !== 255 || Math.abs(channel.gamma - 1) > 1e-6,
      )
    ) {
      map.add("levels");
    }
    const curves = current.curves;
    if (curves.rgb.length > 2 || curves.r.length > 2 || curves.g.length > 2 || curves.b.length > 2) {
      map.add("curves");
    }
    if (
      current.hue ||
      current.saturation ||
      current.lightness ||
      current.vibrance ||
      current.hueRanges.some((range) => range.hue || range.saturation || range.lightness)
    ) {
      map.add("hsl");
    }
    const balance = current.colorBalance;
    if (
      balance.shadows.some((value) => value !== 0) ||
      balance.midtones.some((value) => value !== 0) ||
      balance.highlights.some((value) => value !== 0)
    ) {
      map.add("balance");
    }
    if (current.blackWhite.enabled) map.add("blackWhite");
    if (current.channelMixer.enabled) map.add("mixer");
    if (current.photoFilter.enabled) map.add("filter");
    if (current.gradientMap.enabled) map.add("gradient");
    if (current.colorLookup.enabled) map.add("lookup");
    return map;
  }, [current]);

  const balanceValues = current.colorBalance[balanceRange];
  const activeCurve = current.curves[curveChannel];
  const activeCurveStroke = CURVE_CHANNELS.find((item) => item.id === curveChannel)?.stroke ?? "#e6e6e6";

  return (
    <div className={`space-y-3 ${disabled ? "pointer-events-none opacity-45" : ""}`}>
      <Histogram url={previewUrl} />

      <div className="grid grid-cols-5 gap-1">
        {TYPES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`relative h-6 rounded text-[11px] transition-colors ${
              type === item.id ? "bg-[#3d3d3f] text-white" : "text-[#9a9a9a] hover:bg-[#333335]"
            }`}
            onClick={() => setType(item.id)}
          >
            {item.label}
            {typesWithChanges.has(item.id) && (
              <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-[#0a84ff]" />
            )}
          </button>
        ))}
      </div>

      {type === "curves" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            {CURVE_CHANNELS.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className={`h-5 flex-1 rounded text-[10px] ${
                  curveChannel === channel.id ? "bg-[#3d3d3f] text-white" : "text-[#9a9a9a] hover:bg-[#333335]"
                }`}
                onClick={() => setCurveChannel(channel.id)}
              >
                {channel.label}
              </button>
            ))}
            <button
              type="button"
              className="h-5 rounded px-1.5 text-[10px] text-[#9a9a9a] hover:bg-[#333335]"
              onClick={() => patch({ curves: { ...current.curves, [curveChannel]: defaultCurve() } })}
            >
              复位
            </button>
          </div>
          <CurveEditor
            points={activeCurve}
            stroke={activeCurveStroke}
            onChange={(next) => patch({ curves: { ...current.curves, [curveChannel]: next } })}
          />
        </div>
      )}

      {type === "levels" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            {LEVELS_CHANNELS.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className={`h-5 flex-1 rounded text-[10px] ${
                  levelsChannel === channel.id ? "bg-[#3d3d3f] text-white" : "text-[#9a9a9a] hover:bg-[#333335]"
                }`}
                onClick={() => setLevelsChannel(channel.id)}
              >
                {channel.label}
              </button>
            ))}
          </div>
          <Slider
            label="黑场"
            min={0}
            max={254}
            value={current.levels[levelsChannel].black}
            onChange={(value) => patchLevels(levelsChannel, { black: Math.min(value, 254) })}
          />
          <Slider
            label="白场"
            min={1}
            max={255}
            value={current.levels[levelsChannel].white}
            onChange={(value) => patchLevels(levelsChannel, { white: Math.max(value, 1) })}
          />
          <Slider
            label="中间调"
            min={0.1}
            max={9.99}
            step={0.01}
            value={current.levels[levelsChannel].gamma}
            onChange={(value) => patchLevels(levelsChannel, { gamma: value })}
          />
          <button
            type="button"
            className="h-5 w-full rounded text-[10px] text-[#9a9a9a] hover:bg-[#333335]"
            onClick={() => patchLevels(levelsChannel, defaultLevelsChannel())}
          >
            复位本通道
          </button>
        </div>
      )}

      {type === "hsl" && (
        <div className="space-y-2">
          <Slider label="色相" min={-180} max={180} value={current.hue} onChange={(v) => patch({ hue: v })} suffix="°" />
          <Slider
            label="饱和度"
            min={-100}
            max={100}
            value={current.saturation}
            onChange={(v) => patch({ saturation: v })}
          />
          <Slider label="明度" min={-100} max={100} value={current.lightness} onChange={(v) => patch({ lightness: v })} />
          <Slider
            label="自然饱和"
            min={-100}
            max={100}
            value={current.vibrance}
            onChange={(v) => patch({ vibrance: v })}
          />
          <div className="border-t border-white/10 pt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-[#8a8a8a]">
              <span>六色域</span>
              <button
                type="button"
                className="rounded px-1.5 hover:bg-[#333335]"
                onClick={() =>
                  patch({
                    hueRanges: current.hueRanges.map(() => defaultHueRange()) as MosaicAdjust["hueRanges"],
                  })
                }
              >
                全部复位
              </button>
            </div>
            <div className="mb-1 flex items-center gap-1">
              {HUE_RANGE_LABELS.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  className={`h-5 flex-1 rounded text-[10px] ${
                    hueRangeIndex === index ? "bg-[#3d3d3f] text-white" : "text-[#9a9a9a] hover:bg-[#333335]"
                  }`}
                  onClick={() => setHueRangeIndex(index)}
                >
                  {label}
                </button>
              ))}
            </div>
            {(() => {
              const range = current.hueRanges[hueRangeIndex];
              const setRange = (partial: Partial<typeof range>) => {
                const next = current.hueRanges.map((item, index) =>
                  index === hueRangeIndex ? { ...item, ...partial } : item,
                ) as MosaicAdjust["hueRanges"];
                patch({ hueRanges: next });
              };
              return (
                <div className="space-y-1.5">
                  <Slider label="色相" min={-60} max={60} value={range.hue} onChange={(v) => setRange({ hue: v })} suffix="°" />
                  <Slider
                    label="饱和度"
                    min={-100}
                    max={100}
                    value={range.saturation}
                    onChange={(v) => setRange({ saturation: v })}
                  />
                  <Slider
                    label="明度"
                    min={-100}
                    max={100}
                    value={range.lightness}
                    onChange={(v) => setRange({ lightness: v })}
                  />
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {type === "balance" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            {BALANCE_RANGES.map((range) => (
              <button
                key={range.id}
                type="button"
                className={`h-5 flex-1 rounded text-[10px] ${
                  balanceRange === range.id ? "bg-[#3d3d3f] text-white" : "text-[#9a9a9a] hover:bg-[#333335]"
                }`}
                onClick={() => setBalanceRange(range.id)}
              >
                {range.label}
              </button>
            ))}
          </div>
          {BALANCE_AXES.map((axis) => (
            <div key={axis.index} className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-[#8a8a8a]">
                <span>{axis.left}</span>
                <span>{axis.right}</span>
              </div>
              <input
                type="range"
                min={-100}
                max={100}
                value={balanceValues[axis.index]}
                onChange={(event) => {
                  const values = [...balanceValues] as [number, number, number];
                  values[axis.index] = Number(event.target.value);
                  patch({ colorBalance: { ...current.colorBalance, [balanceRange]: values } });
                }}
                className="h-1.5 w-full appearance-none rounded accent-[#0a84ff]"
                style={{ background: axis.track }}
              />
            </div>
          ))}
          <Toggle
            label="保持明度"
            checked={current.colorBalance.preserveLuminosity}
            onChange={(checked) => patch({ colorBalance: { ...current.colorBalance, preserveLuminosity: checked } })}
          />
        </div>
      )}

      {type === "blackWhite" && (
        <div className="space-y-2">
          <Toggle
            label="启用黑白"
            checked={current.blackWhite.enabled}
            onChange={(enabled) => patch({ blackWhite: { ...current.blackWhite, enabled } })}
          />
          {HUE_RANGE_LABELS.map((label, index) => (
            <Slider
              key={label}
              label={label}
              min={0}
              max={200}
              value={current.blackWhite.weights[index]}
              onChange={(value) => {
                const weights = [...current.blackWhite.weights] as [number, number, number, number, number, number];
                weights[index] = value;
                patch({ blackWhite: { ...current.blackWhite, weights } });
              }}
            />
          ))}
          <div className="flex items-center justify-between">
            <Toggle
              label="单色调"
              checked={current.blackWhite.tint}
              onChange={(tint) => patch({ blackWhite: { ...current.blackWhite, tint } })}
            />
            <input
              type="color"
              value={current.blackWhite.tintColor}
              onChange={(event) =>
                patch({ blackWhite: { ...current.blackWhite, tintColor: event.target.value } })
              }
              className="h-6 w-10 cursor-pointer rounded border border-[#3f3f41] bg-[#1f1f20]"
            />
          </div>
        </div>
      )}

      {type === "mixer" && (
        <div className="space-y-2">
          <Toggle
            label="启用通道混合器"
            checked={current.channelMixer.enabled}
            onChange={(enabled) => patchMixer({ enabled })}
          />
          {(
            [
              ["red", "红输出"],
              ["green", "绿输出"],
              ["blue", "蓝输出"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex items-center gap-1.5">
              <span className="w-12 shrink-0 text-[11px] text-[#9a9a9a]">{label}</span>
              {current.channelMixer[key].map((value, index) => (
                <input
                  key={index}
                  type="number"
                  min={-200}
                  max={200}
                  value={value}
                  onChange={(event) => {
                    const next = [...current.channelMixer[key]] as [number, number, number];
                    next[index] = Number(event.target.value);
                    patchMixer({ [key]: next } as Partial<MosaicChannelMixer>);
                  }}
                  className="h-6 w-full rounded border border-[#3f3f41] bg-[#1f1f20] px-1 text-[11px] text-[#ddd] outline-none"
                />
              ))}
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Toggle
              label="单色"
              checked={current.channelMixer.monochrome}
              onChange={(monochrome) => patchMixer({ monochrome })}
            />
            <button
              type="button"
              className="h-5 rounded px-1.5 text-[10px] text-[#9a9a9a] hover:bg-[#333335]"
              onClick={() =>
                patchMixer({ red: [100, 0, 0], green: [0, 100, 0], blue: [0, 0, 100], monochrome: false })
              }
            >
              复位
            </button>
          </div>
        </div>
      )}

      {type === "filter" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Toggle
              label="启用照片滤镜"
              checked={current.photoFilter.enabled}
              onChange={(enabled) => patch({ photoFilter: { ...current.photoFilter, enabled } })}
            />
            <input
              type="color"
              value={current.photoFilter.color}
              onChange={(event) => patch({ photoFilter: { ...current.photoFilter, color: event.target.value } })}
              className="h-6 w-10 cursor-pointer rounded border border-[#3f3f41] bg-[#1f1f20]"
            />
          </div>
          <Slider
            label="浓度"
            min={0}
            max={100}
            value={current.photoFilter.density}
            onChange={(density) => patch({ photoFilter: { ...current.photoFilter, density } })}
            suffix="%"
          />
          <Toggle
            label="保持明度"
            checked={current.photoFilter.preserveLuminosity}
            onChange={(preserveLuminosity) => patch({ photoFilter: { ...current.photoFilter, preserveLuminosity } })}
          />
          <div className="flex gap-1">
            {[
              { color: "#ec8a00", label: "暖调" },
              { color: "#0066ff", label: "冷调" },
              { color: "#8b5cf6", label: "紫调" },
              { color: "#22c55e", label: "绿调" },
            ].map((preset) => (
              <button
                key={preset.color}
                type="button"
                className="h-5 flex-1 rounded text-[10px] text-[#c9c9c9] hover:bg-[#333335]"
                style={{ borderLeft: `3px solid ${preset.color}` }}
                onClick={() =>
                  patch({ photoFilter: { ...current.photoFilter, enabled: true, color: preset.color } })
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {type === "gradient" && (
        <div className="space-y-2">
          <Toggle
            label="启用渐变映射"
            checked={current.gradientMap.enabled}
            onChange={(enabled) => patch({ gradientMap: { ...current.gradientMap, enabled } })}
          />
          <div
            className="h-5 w-full rounded border border-[#3f3f41]"
            style={{
              background: `linear-gradient(90deg, ${[...current.gradientMap.stops]
                .sort((a, b) => a.pos - b.pos)
                .map((stop) => `${stop.color} ${Math.round(stop.pos * 100)}%`)
                .join(", ")})`,
            }}
          />
          {current.gradientMap.stops.map((stop, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <input
                type="color"
                value={stop.color}
                onChange={(event) => {
                  const stops = current.gradientMap.stops.map((item, i) =>
                    i === index ? { ...item, color: event.target.value } : item,
                  );
                  patch({ gradientMap: { ...current.gradientMap, stops } });
                }}
                className="h-6 w-8 shrink-0 cursor-pointer rounded border border-[#3f3f41] bg-[#1f1f20]"
              />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(stop.pos * 100)}
                onChange={(event) => {
                  const stops = current.gradientMap.stops.map((item, i) =>
                    i === index ? { ...item, pos: Number(event.target.value) / 100 } : item,
                  );
                  patch({ gradientMap: { ...current.gradientMap, stops } });
                }}
                className="h-1 w-full accent-[#0a84ff]"
              />
              <button
                type="button"
                className="text-[10px] text-[#9a9a9a] hover:text-[#ff6b6b]"
                disabled={current.gradientMap.stops.length <= 2}
                onClick={() =>
                  patch({
                    gradientMap: {
                      ...current.gradientMap,
                      stops: current.gradientMap.stops.filter((_, i) => i !== index),
                    },
                  })
                }
              >
                删
              </button>
            </div>
          ))}
          <button
            type="button"
            className="h-5 w-full rounded text-[10px] text-[#9a9a9a] hover:bg-[#333335]"
            onClick={() => {
              const stops: MosaicGradientStop[] = [
                ...current.gradientMap.stops,
                { pos: 0.5, color: "#888888" },
              ].sort((a, b) => a.pos - b.pos);
              patch({ gradientMap: { ...current.gradientMap, stops } });
            }}
          >
            + 添加色标
          </button>
        </div>
      )}

      {type === "lookup" && (
        <div className="space-y-2">
          <Toggle
            label="启用 3D LUT"
            checked={current.colorLookup.enabled}
            onChange={(enabled) => patch({ colorLookup: { ...current.colorLookup, enabled } })}
          />
          <select
            value={current.colorLookup.preset}
            onChange={(event) => patch({ colorLookup: { ...current.colorLookup, preset: event.target.value } })}
            className="h-6 w-full rounded border border-[#3f3f41] bg-[#1f1f20] px-1 text-[11px] text-[#ddd] outline-none"
          >
            {LOOKUPS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <Slider
            label="强度"
            min={0}
            max={100}
            value={current.colorLookup.intensity}
            onChange={(intensity) => patch({ colorLookup: { ...current.colorLookup, intensity } })}
            suffix="%"
          />
        </div>
      )}

      {type === "tone" && (
        <div className="space-y-2">
          <Slider label="亮度" min={-100} max={100} value={current.brightness} onChange={(v) => patch({ brightness: v })} />
          <Slider label="对比度" min={-100} max={100} value={current.contrast} onChange={(v) => patch({ contrast: v })} />
          <Slider
            label="曝光"
            min={-3}
            max={3}
            step={0.05}
            value={current.exposure}
            onChange={(v) => patch({ exposure: v })}
            suffix="EV"
          />
        </div>
      )}

      <div className="flex items-center justify-between border-t border-white/10 pt-2">
        <span className="text-[10px] text-[#7f7f7f]">{touchedAll ? "已调整" : "未调整"}</span>
        <button
          type="button"
          className="h-6 rounded px-2 text-[11px] text-[#9a9a9a] hover:bg-[#333335] hover:text-white"
          onClick={() => onChange(createDefaultAdjust())}
        >
          全部复位
        </button>
      </div>
    </div>
  );
}
