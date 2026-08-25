/**
 * 经典电影摄影机 / 电影镜头库
 * 每个型号附带「拍摄效果」描述, 编译提示词时注入, 让生成器了解该设备能拍出的画面质感。
 * id 为稳定标识, 持久化在 Shot.camera / Shot.lensModel。
 */

export interface CameraGear {
  id: string;
  brand: string;
  model: string;
  /** 效果描述(中文), 注入提示词 */
  effect: string;
}

export interface LensGear {
  id: string;
  brand: string;
  model: string;
  /** 焦距/画幅范围, 如 "35mm / 50mm / 85mm T1.8" */
  focal: string;
  /** 效果描述(中文), 注入提示词 */
  effect: string;
}

export const CAMERAS: CameraGear[] = [
  { id: "arri-alexa-35", brand: "ARRI", model: "ALEXA 35", effect: "15.5 档动态范围, 胶片质感的皮肤过渡, 柔和的暗部细节, 高光自然衰减" },
  { id: "arri-alexa-mini-lf", brand: "ARRI", model: "ALEXA Mini LF", effect: "大画幅浅景深, 经典 ARRI 色彩科学, 柔和高光, 电影感十足" },
  { id: "red-v-raptor", brand: "RED", model: "V-RAPTOR 8K", effect: "8K 超高解析力, 锐利细节, 高动态范围, 偏数字的现代质感" },
  { id: "sony-venice-2", brand: "SONY", model: "VENICE 2", effect: "16 档动态范围, 自然真实的肤色还原, 高光柔滑过渡, 双原生 ISO" },
  { id: "bmd-ursa-cine", brand: "Blackmagic", model: "URSA Cine 12K", effect: "大画幅电影色彩, 双原生 ISO, 电影感色彩科学, 性价比高的专业电影机" },
  { id: "canon-c300-iii", brand: "Canon", model: "C300 Mark III", effect: "DGO 双增益传感器, 优秀的 HDR 表现, 自然纪录片级肤色" },
  { id: "panasonic-s1h", brand: "Panasonic", model: "S1H", effect: "全画幅 V-Log, 双原生 ISO, 柔和肤色, 电影与纪录片通用的紧凑机身" },
  { id: "kinefinity-mavo-edge", brand: "Kinefinity", model: "MAVO Edge", effect: "中画幅 6K 浅景深, 优异的暗部质感, 柔和的高光滚降" }
];

export const LENSES: LensGear[] = [
  { id: "arri-master-prime", brand: "ARRI", model: "Master Prime", focal: "25-100mm T1.3 定焦组", effect: "奶油般的丝滑散景, 中心锐利, 温和自然的对比" },
  { id: "zeiss-supreme-prime", brand: "Zeiss", model: "Supreme Prime", focal: "25-135mm T1.5 全画幅定焦", effect: "全画幅像场, 丝滑散景, 自然的肤色渲染, 现代电影质感" },
  { id: "zeiss-cp4", brand: "Zeiss", model: "CP.4 定焦", focal: "21-135mm T2.1 轻量定焦", effect: "中性色彩, 锐利成像, 轻量化的低调电影质感" },
  { id: "cooke-s7i", brand: "Cooke", model: "S7/i Full Frame+", focal: "18-135mm T2.0 全画幅定焦", effect: "标志性的 Cooke Look, 暖调肤色, 柔和高光, 如画般的散景" },
  { id: "leica-summicron-c", brand: "Leica", model: "Summicron-C", focal: "18-100mm T2.0 定焦组", effect: "经典徕卡微反差, 柔和的人像质感, 自然的肤色层次" },
  { id: "angenieux-optimo", brand: "Angénieux", model: "Optimo Ultra", focal: "24-290mm 变焦", effect: "电影级变焦, 顺滑的焦点呼吸, 复古风格的高光眩光" },
  { id: "canon-cne", brand: "Canon", model: "CN-E 定焦", focal: "24-135mm T2.8 定焦组", effect: "忠实的中性色彩, 稳定的成像, 高性价比的电影镜头" },
  { id: "sigma-cine-ff", brand: "Sigma", model: "Cine FF High Speed", focal: "20-135mm T2.0 高速定焦", effect: "高速大光圈, 高解析力, 奶油散景, 性价比出众" },
  { id: "cooke-panchro", brand: "Cooke", model: "Panchro/i Classic", focal: "25-135mm T2.8 复古定焦", effect: "复古柔和画质, 低对比, 泛光高光, 年代感十足" },
  { id: "helios-44-2", brand: "Helios", model: "44-2 58mm", focal: "58mm f/2 复古", effect: "标志性的旋转散景, 个性眩光, 强烈的复古与梦幻感" }
];

export const getCamera = (id?: string): CameraGear | undefined => CAMERAS.find((camera) => camera.id === id);
export const getLens = (id?: string): LensGear | undefined => LENSES.find((lens) => lens.id === id);
