import assert from "node:assert/strict";
import test from "node:test";
import { inferCapabilities, inferTask, rankCandidates } from "../src/router.js";
import type { ProviderSpec } from "../src/types.js";

const providers: ProviderSpec[] = [
  {
    id: "private-fast",
    label: "Private fast",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test",
    freeEligible: true,
    dataMayTrain: false,
    models: [{ id: "small", capabilities: ["text", "tools", "json"], context: 10_000, quality: 60, speed: 100, coding: 60, reasoning: 55 }],
  },
  {
    id: "training-smart",
    label: "Training smart",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test",
    freeEligible: true,
    dataMayTrain: true,
    models: [{ id: "smart", capabilities: ["text", "vision", "tools", "json"], context: 100_000, quality: 95, speed: 60, coding: 98, reasoning: 98 }],
  },
];

test("infers task and required capabilities", () => {
  const request = { model: "auto", messages: [{ role: "user" as const, content: "debug this TypeScript function" }], tools: [{}] };
  assert.equal(inferTask(request), "coding");
  assert.deepEqual([...inferCapabilities(request)].sort(), ["text", "tools"]);
});

test("privacy policy excludes free tiers that may train", () => {
  const ranked = rankCandidates(providers, new Map(), { model: "auto", messages: [{ role: "user", content: "debug this code" }] }, { freeOnly: true, allowTrainingData: false, now: 1 });
  assert.deepEqual(ranked.map((entry) => entry.provider.id), ["private-fast"]);
});

test("task-aware routing picks the stronger coding model when allowed", () => {
  const ranked = rankCandidates(providers, new Map(), { model: "auto", messages: [{ role: "user", content: "debug this code" }] }, { freeOnly: true, allowTrainingData: true, now: 1 });
  assert.equal(ranked[0]?.model.id, "smart");
});

test("caller-supplied model names cannot force provider selection", () => {
  const ranked = rankCandidates(providers, new Map(), { model: "private-fast/small", messages: [{ role: "user", content: "debug this code" }] }, { freeOnly: true, allowTrainingData: true, now: 1 });
  assert.equal(ranked[0]?.provider.id, "training-smart");
});
