import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../src/agent.js";
import type { Gateway, GatewayResult } from "../src/gateway.js";
import { Store } from "../src/store.js";
import type { AgentTool } from "../src/tools.js";

test("agent continues after a tool call and completes the objective", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-agent-"));
  try {
    const store = new Store(join(directory, "state.db"));
    let calls = 0;
    const gateway = {
      async complete(): Promise<GatewayResult> {
        calls += 1;
        const payload = calls === 1
          ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "test_tool", arguments: "{}" } }] } }] }
          : calls === 2
            ? { choices: [{ message: { role: "assistant", content: "Finished with evidence." } }] }
            : { choices: [{ message: { role: "assistant", content: JSON.stringify({ complete: true, feedback: "All requirements met" }) } }] };
        return {
          response: new Response(JSON.stringify(payload)),
          candidate: { provider: { id: "mock" }, model: { id: "mock-model" }, score: 1, reasons: [] },
          attempts: [],
          latencyMs: 1,
        } as unknown as GatewayResult;
      },
    } as unknown as Gateway;
    const tool: AgentTool = {
      definition: { type: "function", function: { name: "test_tool", description: "test", parameters: { type: "object" } } },
      async execute() { return "evidence"; },
    };
    const engine = new AgentEngine(gateway, store, [tool], 4);
    const created = engine.create("do it");

    let run = store.getRun(created.id);
    for (let attempt = 0; attempt < 100 && run?.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      run = store.getRun(created.id);
    }
    assert.equal(run?.status, "completed");
    assert.equal(run?.result, "Finished with evidence.");
    assert.equal(run?.step, 2);
    assert.equal(run?.events.some((event) => event.type === "tool"), true);
    assert.equal(run?.events.some((event) => event.type === "verification"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
