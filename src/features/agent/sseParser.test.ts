import { describe, expect, it } from "vitest";

import { contentToText, createSseChatParser, extractDeltaText } from "./sseParser";

/** 收集 parser 吐出的所有增量，拼接为完整文本 */
function collect(chunks: string[]): { text: string; done: boolean; sawDataLine: boolean } {
  let text = "";
  const parser = createSseChatParser((delta) => {
    text += delta;
  });
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return { text, done: parser.done, sawDataLine: parser.sawDataLine };
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (text: string) => sse({ choices: [{ delta: { content: text } }] });

describe("extractDeltaText", () => {
  it("reads standard streaming delta.content", () => {
    expect(extractDeltaText({ choices: [{ delta: { content: "你好" } }] })).toBe("你好");
  });

  it("falls back to message.content for gateways that stream as message", () => {
    expect(extractDeltaText({ choices: [{ message: { content: "完整回答" } }] })).toBe("完整回答");
  });

  it("falls back to choice.text for completion-style endpoints", () => {
    expect(extractDeltaText({ choices: [{ text: "补全内容" }] })).toBe("补全内容");
  });

  it("joins multimodal content parts", () => {
    expect(
      extractDeltaText({
        choices: [{ delta: { content: [{ type: "text", text: "上" }, "半", { text: "段" }] } }],
      }),
    ).toBe("上半段");
  });

  it("returns empty string for malformed payloads instead of throwing", () => {
    expect(extractDeltaText(null)).toBe("");
    expect(extractDeltaText({})).toBe("");
    expect(extractDeltaText({ choices: [] })).toBe("");
    expect(extractDeltaText({ choices: [{}] })).toBe("");
  });
});

describe("contentToText", () => {
  it("passes strings through and stringifies arrays", () => {
    expect(contentToText("abc")).toBe("abc");
    expect(contentToText([{ text: "a" }, { text: "b" }])).toBe("ab");
    expect(contentToText(42)).toBe("");
    expect(contentToText(undefined)).toBe("");
  });
});

describe("createSseChatParser", () => {
  it("accumulates a normal multi-chunk stream", () => {
    const result = collect([delta("Hello"), delta(" "), delta("world"), "data: [DONE]\n\n"]);
    expect(result.text).toBe("Hello world");
    expect(result.done).toBe(true);
    expect(result.sawDataLine).toBe(true);
  });

  it("survives a chunk boundary cutting through the middle of a JSON line", () => {
    // 上游真实行为：一次 HTTP chunk 可能停在任意字节位置
    const whole = delta("完整的一句话");
    const cut = Math.floor(whole.length / 2);
    const result = collect([whole.slice(0, cut), whole.slice(cut)]);
    expect(result.text).toBe("完整的一句话");
  });

  it("survives a chunk boundary cutting through the middle of the `data:` marker", () => {
    const result = collect(["da", "ta: ", '{"choices":[{"delta":{"content":"x"}}]}', "\n", "\n"]);
    expect(result.text).toBe("x");
  });

  it("survives [DONE] being split across chunks", () => {
    const result = collect([delta("hi"), "data: [D", "ONE]", "\n\n"]);
    expect(result.text).toBe("hi");
    expect(result.done).toBe(true);
  });

  it("produces identical output for byte-by-byte feeding and whole-body feeding", () => {
    const whole =
      delta("第一段") + delta("，第二段") + ": keep-alive\n\n" + delta("，第三段") + "data: [DONE]\n\n";
    const expected = collect([whole]).text;
    // 逐字节喂入：最严苛的边界条件
    const byteByByte = collect(whole.split(""));
    expect(expected).toBe("第一段，第二段，第三段");
    expect(byteByByte.text).toBe(expected);
  });

  it("ignores comment and blank lines", () => {
    const result = collect([": ping\n\n", "\n", delta("ok"), "\n"]);
    expect(result.text).toBe("ok");
  });

  it("does not abort the whole stream when a data line holds non-JSON content", () => {
    const result = collect(["data: upstream gateway warming up\n\n", delta("正文"), "data: [DONE]\n\n"]);
    expect(result.text).toBe("正文");
    expect(result.done).toBe(true);
  });

  it("handles CRLF line endings", () => {
    const result = collect(['data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n']);
    expect(result.text).toBe("crlf");
  });

  it("falls back to whole-body JSON when a gateway ignores stream=true", () => {
    const body = JSON.stringify({ choices: [{ message: { content: "非流式整段回答" } }] });
    const result = collect([body]);
    expect(result.text).toBe("非流式整段回答");
    expect(result.sawDataLine).toBe(false);
  });

  it("closes out a trailing line that never got its newline", () => {
    // 连接被提前掐断：最后一行没有换行符也不能丢
    const result = collect([delta("A"), 'data: {"choices":[{"delta":{"content":"B"}}]}']);
    expect(result.text).toBe("AB");
    expect(result.done).toBe(false);
  });

  it("reports a truly empty response as empty text", () => {
    const result = collect([]);
    expect(result.text).toBe("");
    expect(result.done).toBe(false);
  });
});
