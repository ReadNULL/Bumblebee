import { describe, expect, it } from "vitest";

import { buildPiMemoryPrompt } from "../../src/index.js";

describe("pi memory reader prompt", () => {
  it("passes selected memory and the current question without tools", () => {
    const prompt = buildPiMemoryPrompt({
      caseId: "fixture",
      question: "当前命令是什么？",
      memoryContext: "<memory-context>\nfixture\n</memory-context>",
    });

    expect(prompt).toContain("<memory-context>");
    expect(prompt).toContain("当前命令是什么？");
    expect(prompt).toContain("请只依据上述上下文作答");
  });

  it("makes an empty retrieval explicit", () => {
    const prompt = buildPiMemoryPrompt({
      caseId: "fixture",
      question: "未知事实是什么？",
      memoryContext: "",
    });

    expect(prompt).toContain("没有检索到匹配的持久记忆");
  });
});
