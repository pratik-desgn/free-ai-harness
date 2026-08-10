import type { Gateway } from "./gateway.js";
import type { Store } from "./store.js";
import type { AgentRun, ChatMessage } from "./types.js";
import type { AgentTool } from "./tools.js";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface CompletionEnvelope {
  choices?: Array<{ message?: ChatMessage & { tool_calls?: ToolCall[] } }>;
}

interface Verification {
  complete: boolean;
  feedback: string;
}

const SYSTEM_PROMPT = `You are the execution brain inside an autonomous AI harness.
Work toward the user's objective until it is actually complete. Use tools when they provide necessary evidence.
After each tool result, reassess the objective and continue. Never claim a tool action happened unless its result is in the transcript.
When the objective is complete, respond with the final useful result and do not call another tool.`;

export class AgentEngine {
  private readonly active = new Set<string>();
  private readonly toolsByName: Map<string, AgentTool>;

  constructor(
    private readonly gateway: Gateway,
    private readonly store: Store,
    tools: AgentTool[],
    private readonly maxSteps: number,
  ) {
    this.toolsByName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
  }

  create(objective: string): AgentRun {
    const run = this.store.createRun(objective);
    this.start(run.id);
    return run;
  }

  resumePersisted(): void {
    for (const run of this.store.resumableRuns()) this.start(run.id);
  }

  start(id: string): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    void this.execute(id).finally(() => this.active.delete(id));
  }

  private async execute(id: string): Promise<void> {
    const run = this.store.getRun(id);
    if (!run || ["completed", "cancelled"].includes(run.status)) return;
    run.status = "running";
    this.store.updateRun(run);

    try {
      while (run.step < this.maxSteps) {
        run.step += 1;
        const result = await this.gateway.complete({
          model: "auto",
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...run.messages],
          tools: [...this.toolsByName.values()].map((tool) => tool.definition),
          tool_choice: "auto",
          stream: false,
        });
        const envelope = (await result.response.json()) as CompletionEnvelope;
        const message = envelope.choices?.[0]?.message;
        if (!message) throw new Error("Provider returned no assistant message");
        run.messages.push(message);
        this.store.appendEvent(run, {
          type: "model",
          message: `Step ${run.step} routed automatically`,
          metadata: { provider: result.candidate.provider.id, model: result.candidate.model.id },
        });

        const calls = message.tool_calls ?? [];
        if (!calls.length) {
          const proposedResult = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          const verification = await this.verify(run.objective, proposedResult);
          this.store.appendEvent(run, {
            type: "verification",
            message: verification.complete ? "Completion independently verified" : "Verifier requested more work",
            metadata: { feedback: verification.feedback },
          });
          if (verification.complete) {
            run.status = "completed";
            run.result = proposedResult;
            this.store.appendEvent(run, { type: "completed", message: "Objective completed" });
            return;
          }
          run.messages.push({ role: "user", content: `Completion verifier says the objective is not finished: ${verification.feedback}\nContinue working and resolve this gap.` });
          continue;
        }

        for (const call of calls) {
          const tool = this.toolsByName.get(call.function.name);
          let content: string;
          try {
            content = tool ? await tool.execute(call.function.arguments) : `Error: unknown tool ${call.function.name}`;
          } catch (error) {
            content = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          run.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content });
          this.store.appendEvent(run, { type: "tool", message: `Executed ${call.function.name}`, metadata: { ok: !content.startsWith("Error:") } });
        }
      }
      throw new Error(`Workflow reached the ${this.maxSteps}-step safety limit`);
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      this.store.appendEvent(run, { type: "failed", message: run.error });
    }
  }

  private async verify(objective: string, proposedResult: string): Promise<Verification> {
    const result = await this.gateway.complete({
      model: "auto",
      messages: [
        {
          role: "system",
          content: "Act as a strict completion verifier. Decide whether the proposed result fully satisfies the objective with supported evidence. Return JSON only: {\"complete\":boolean,\"feedback\":string}.",
        },
        { role: "user", content: `OBJECTIVE:\n${objective}\n\nPROPOSED RESULT:\n${proposedResult}` },
      ],
      response_format: { type: "json_object" },
      stream: false,
    });
    const envelope = (await result.response.json()) as CompletionEnvelope;
    const content = envelope.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Completion verifier returned no result");
    const parsed = JSON.parse(content) as Partial<Verification>;
    if (typeof parsed.complete !== "boolean") throw new Error("Completion verifier returned an invalid verdict");
    return { complete: parsed.complete, feedback: typeof parsed.feedback === "string" ? parsed.feedback : "No feedback supplied" };
  }
}
