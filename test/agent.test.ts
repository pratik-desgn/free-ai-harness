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

test("agent engines cannot cancel or resume another user's workflow", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-agent-isolation-"));
  try {
    const store = new Store(join(directory, "state.db"));
    const gateway = { complete: async () => new Promise<GatewayResult>(() => undefined) } as unknown as Gateway;
    const alice = new AgentEngine(gateway, store, [], 4, "puter:alice");
    const bob = new AgentEngine(gateway, store, [], 4, "puter:bob");
    const aliceRun = alice.create("alice objective");

    assert.equal(bob.cancel(aliceRun.id), undefined);
    assert.equal(bob.resume(aliceRun.id), undefined);
    assert.notEqual(store.getRun(aliceRun.id, "puter:alice")?.status, "cancelled");
    assert.equal(alice.cancel(aliceRun.id)?.status, "cancelled");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("today and market objectives search first and expose page fetching for evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-agent-current-"));
  try {
    const store = new Store(join(directory, "state.db"));
    let calls = 0;
    const gateway = {
      async complete(request: { tools?: Array<{ function: { name: string } }>; messages: Array<{ content?: unknown }> }): Promise<GatewayResult> {
        calls += 1;
        if (calls === 1) {
          assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["http_get"]);
          assert(request.messages.some((message) => typeof message.content === "string" && message.content.includes("UNTRUSTED WEB-SEARCH EVIDENCE")));
          return gatewayResult({ choices: [{ message: { role: "assistant", content: "Today's verified market update." } }] });
        }
        return gatewayResult({ choices: [{ message: { role: "assistant", content: JSON.stringify({ complete: true, feedback: "Current evidence included" }) } }] });
      },
    } as unknown as Gateway;
    const search: AgentTool = {
      definition: { type: "function", function: { name: "web_search", description: "search", parameters: { type: "object" } } },
      async execute() { return "1. Current market\nhttps://example.com/market\nUpdated today"; },
    };
    const httpGet: AgentTool = {
      definition: { type: "function", function: { name: "http_get", description: "read", parameters: { type: "object" } } },
      async execute() { return "market evidence"; },
    };
    const run = new AgentEngine(gateway, store, [search, httpGet], 12).create("market update today");
    const finished = await waitForTerminal(store, run.id);
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.events.some((event) => event.metadata?.preflightKind === "search"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent stops after three unsupported completion attempts instead of looping to the step limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-agent-loop-"));
  try {
    const store = new Store(join(directory, "state.db"));
    let calls = 0;
    const gateway = {
      async complete(): Promise<GatewayResult> {
        calls += 1;
        return calls % 2 === 1
          ? gatewayResult({ choices: [{ message: { role: "assistant", content: "I cannot obtain the required evidence." } }] })
          : gatewayResult({ choices: [{ message: { role: "assistant", content: JSON.stringify({ complete: false, feedback: "Required evidence is missing" }) } }] });
      },
    } as unknown as Gateway;
    const run = new AgentEngine(gateway, store, [], 12).create("complete an unsupported objective");
    const finished = await waitForTerminal(store, run.id);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.step, 3);
    assert.match(finished?.error ?? "", /could not obtain the required evidence after 3 attempts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function gatewayResult(payload: unknown): GatewayResult {
  return {
    response: Response.json(payload),
    candidate: { provider: { id: "mock" }, model: { id: "mock-model" }, score: 1, reasons: [] },
    attempts: [],
    latencyMs: 1,
  } as unknown as GatewayResult;
}

async function waitForTerminal(store: Store, id: string) {
  let run = store.getRun(id);
  for (let attempt = 0; attempt < 100 && run && !["completed", "failed", "cancelled"].includes(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    run = store.getRun(id);
  }
  return run;
}
