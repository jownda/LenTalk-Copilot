import { describe, expect, it } from "vitest";

import { FACIAL_EXPRESSION_TEMPLATES, facialExpressionReferencePrompt } from "./facial-expression";

describe("facial expression reference templates", () => {
  it("contains the 50 source emotions with unique ids", () => {
    expect(FACIAL_EXPRESSION_TEMPLATES).toHaveLength(50);
    expect(new Set(FACIAL_EXPRESSION_TEMPLATES.map((template) => template.id)).size).toBe(50);
    expect(FACIAL_EXPRESSION_TEMPLATES.every((template) => template.mouth && template.eyes && template.face && template.head)).toBe(true);
  });

  it("renders all four observable expression dimensions for AI lookup", () => {
    const prompt = facialExpressionReferencePrompt();
    expect(prompt).toContain("01.自然微笑");
    expect(prompt).toContain("嘴：");
    expect(prompt).toContain("眼：");
    expect(prompt).toContain("面：");
    expect(prompt).toContain("头：");
    expect(prompt).toContain("50.坚毅不屈");
  });
});
