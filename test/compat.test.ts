import assert from "node:assert/strict";
import test from "node:test";
import { anthropicEnvelope, anthropicRequest, responsesEnvelope, responsesRequest } from "../src/compat.js";

test("Responses compatibility preserves the single auto model contract", () => {
  const request = responsesRequest({ input: "hello", model: "anything" });
  assert.equal(request.model, "auto");
  assert.equal(request.messages[0]?.content, "hello");
  const output = responsesEnvelope({ choices: [{ message: { role: "assistant", content: "world" } }], usage: { total_tokens: 2 } });
  assert.equal(output.model, "auto");
  assert.equal((output.output as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text, "world");
});

test("Anthropic compatibility translates tools without exposing providers", () => {
  const request = anthropicRequest({ messages: [{ role: "user", content: "hello" }], tools: [{ name: "clock", input_schema: { type: "object" } }] });
  assert.equal(request.model, "auto");
  assert.equal((request.tools?.[0] as { function: { name: string } }).function.name, "clock");
  const output = anthropicEnvelope({ choices: [{ message: { role: "assistant", content: "done" } }] });
  assert.equal(output.model, "auto");
  assert.equal(output.stop_reason, "end_turn");
});
