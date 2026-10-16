#!/usr/bin/env node
/**
 * 把一个 skill 目录（`SKILL.md` + 可选 `skill-meta.json`）编译成
 * LenTalk AI Agent 可直接加载的 TS 模块。
 *
 * 用法：
 *   node scripts/import-agent-skill.mjs "<skill 目录 或 SKILL.md 路径>" [--id <slug>]
 *
 * 产物：`src/features/agent/skills/<slug>.ts`
 * 之后把它登记进 `src/features/agent/skills/index.ts` 的 `AGENT_SKILLS` 即可被面板加载。
 *
 * 为什么是「编译进源码」而不是「运行时扫盘」：
 * LenTalk 的画布/提示词规则一贯以 TS 常量形式内置（见 `canvas/domain/liraRules.ts`），
 * 好处是零 Rust 改动、无文件作用域问题、打包即用、HMR 可验。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(repoRoot, "src", "features", "agent", "skills");
/** 缩略图落在这里（vite 的 public 根），运行时用 `import.meta.env.BASE_URL` 拼 URL */
const THUMB_DIR = join(repoRoot, "public", "local-assets", "agent-skills");
/** 跟着 skill 一起放进目录的图片；取排序后的第一张当缩略图 */
const IMAGE_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg", ".gif", ".avif", ".bmp"];

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  let id = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--id") {
      id = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    positional.push(argv[index]);
  }
  return { input: positional[0] ?? null, id };
}

/**
 * 拆出 YAML frontmatter。只认 `key: value` 与 `key: >-` 折叠块两种写法，
 * 够覆盖 skill 的 `name` / `description`，因此不引入 YAML 依赖。
 */
function splitFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
    if (/^[>|]-?$/.test(value)) {
      const isFolded = value.startsWith(">");
      const collected = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        collected.push(lines[index + 1].trim());
        index += 1;
      }
      value = collected.join(isFolded ? " " : "\n");
    }
    data[key] = value.replace(/^["']|["']$/g, "");
  }
  return { data, body: source.slice(match[0].length) };
}

/** 转义成模板字符串字面量 */
function toTemplateLiteral(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * 读 `skill-meta.json`。
 *
 * ⚠️ 这类文件是第三方导出的，实测会出现**值里没有转义的引号**
 * （例：`"howToUse": "…需明确说明"混合配色"。"`），严格 `JSON.parse` 会整份失败。
 * 失败后退回逐字段正则提取 —— 只取我们真正要用的几个键，
 * 不为一个坏字段丢掉整份元数据（丢了 `name` 面板就只能显示 slug）。
 */
function readSkillMeta(file) {
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    const loose = {};
    for (const key of ["name", "skillKey", "intro", "useScenario"]) {
      const match = new RegExp(
        `"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*\\r?\\n|\\r?\\n\\s*})`,
      ).exec(text);
      if (match) loose[key] = match[1].trim();
    }
    if (Object.keys(loose).length > 0) {
      console.warn(
        `! skill-meta.json 不是合法 JSON（${error.message}），已按字段宽松提取：${Object.keys(loose).join(" / ")}`,
      );
      return loose;
    }
    console.warn(`! skill-meta.json 解析失败，改用 frontmatter：${error.message}`);
    return {};
  }
}

function camelCase(slug) {
  return slug
    .replace(/[-_\s]+(.)?/g, (_, char) => (char ? char.toUpperCase() : ""))
    .replace(/^(.)/, (char) => char.toLowerCase());
}

/**
 * 找 skill 目录里的缩略图（第一张图片，按文件名自然序）。
 *
 * 自然序很重要：`1.png` / `2.png` / `10.png` 按字典序会排成 1, 10, 2，
 * 用 `numeric: true` 才符合直觉。
 */
function findThumbnailImage(skillDir) {
  const images = readdirSync(skillDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => IMAGE_EXTENSIONS.includes(extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
  return images[0] ?? null;
}

/** 文件名安全化：public 下的资源要经 URL 取，避免用中文/空格文件名 */
function safeFileName(slug) {
  return slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

const { input, id: idFlag } = parseArgs(process.argv.slice(2));
if (!input) {
  die('用法: node scripts/import-agent-skill.mjs "<skill 目录 或 SKILL.md 路径>" [--id <slug>]');
}

const skillFile = resolve(input.endsWith(".md") ? input : join(input, "SKILL.md"));
if (!existsSync(skillFile)) die(`找不到 SKILL.md：${skillFile}`);
const skillDir = dirname(skillFile);

const raw = readFileSync(skillFile, "utf8").replace(/^\uFEFF/, "");
const { data: front, body } = splitFrontmatter(raw);
const rules = body.trim();
if (!rules) die("SKILL.md 正文为空，拒绝生成空规则");

let meta = {};
const metaPath = join(skillDir, "skill-meta.json");
if (existsSync(metaPath)) {
  meta = readSkillMeta(metaPath);
}

const slug = String(idFlag || front.name || meta.skillKey || basename(skillDir)).trim();
const displayName = String(meta.name || front.name || slug).trim();
const intro = String(meta.intro || front.description || "").trim().replace(/\s+/g, " ");
const varName = camelCase(slug);

// 缩略图：跟 SKILL.md 同目录的图片 → 复制到 public/local-assets/agent-skills/
const thumbSourceName = findThumbnailImage(skillDir);
let thumbnailRelPath = null;
if (thumbSourceName) {
  const destName = `${safeFileName(slug)}${extname(thumbSourceName).toLowerCase()}`;
  mkdirSync(THUMB_DIR, { recursive: true });
  copyFileSync(join(skillDir, thumbSourceName), join(THUMB_DIR, destName));
  thumbnailRelPath = `local-assets/agent-skills/${destName}`;
}

const header = [
  "/**",
  ` * ${displayName}${slug === displayName ? "" : `（${slug}）`}`,
  " *",
  ` * ${intro || displayName}`,
  " *",
  " * ⚠️ 本文件由 `node scripts/import-agent-skill.mjs` 生成，不要手改 —— 重新生成会整份覆盖。",
  ` * 源文件：${skillFile}`,
  " */",
].join("\n");

const file = `${header}
import type { AgentSkill } from "./types";

export const ${varName}: AgentSkill = {
  id: ${JSON.stringify(slug)},
  name: ${JSON.stringify(displayName)},
  intro: ${JSON.stringify(intro)},${
    thumbnailRelPath
      ? `\n  // 缩略图：由脚本从 skill 目录复制到 public，随应用打包一起走\n  thumbnail: \`\${import.meta.env.BASE_URL}${thumbnailRelPath}\`,`
      : ""
  }
  // 下面这段就是 SKILL.md 正文全文，会原样进入 system prompt —— 不要在这里做精简，
  // 精简即等于替用户改了 skill 的规则。
  rules: \`${toTemplateLiteral(rules)}\`,
};
`;

mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, `${slug}.ts`);
writeFileSync(outFile, file, "utf8");

console.log(`✓ 已生成 ${outFile}`);
console.log(`  id=${slug}  name=${displayName}`);
console.log(
  thumbnailRelPath
    ? `  缩略图 ${thumbSourceName} → public/${thumbnailRelPath}`
    : "  ⚠️ skill 目录里没有图片，未生成缩略图（放一张 *.webp/*.png 进去后重跑即可）",
);
console.log(`  规则 ${rules.length} 字符 / ${rules.split(/\r?\n/).length} 行`);
console.log("");
console.log("还剩一步：把它加进 src/features/agent/skills/index.ts 的 AGENT_SKILLS");
