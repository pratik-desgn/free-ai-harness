import type { Candidate, Capability, ChatRequest, ProviderRuntime, ProviderSpec, TaskKind } from "./types.js";

export function inferCapabilities(request: ChatRequest): Set<Capability> {
  const required = new Set<Capability>(["text"]);
  if (request.tools?.length) required.add("tools");
  if (request.response_format?.type) required.add("json");
  if (request.messages.some((message) => Array.isArray(message.content))) required.add("vision");
  return required;
}

export function inferTask(request: ChatRequest): TaskKind {
  const text = request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join(" ").toLowerCase();
  if (/\b(code|debug|typescript|python|rust|sql|function|repository|compile)\b/.test(text)) return "coding";
  if (/\b(prove|reason|derive|logic|theorem|step by step|analy[sz]e)\b/.test(text)) return "reasoning";
  return "general";
}

export interface RouterOptions {
  freeOnly: boolean;
  allowTrainingData: boolean;
  now?: number;
}

export function rankCandidates(
  providers: ProviderSpec[],
  runtime: Map<string, ProviderRuntime>,
  request: ChatRequest,
  options: RouterOptions,
): Candidate[] {
  const now = options.now ?? Date.now();
  const required = inferCapabilities(request);
  const task = inferTask(request);
  const ranked: Candidate[] = [];

  for (const provider of providers) {
    if (options.freeOnly && !provider.freeEligible) continue;
    if (!options.allowTrainingData && provider.dataMayTrain) continue;
    const state = runtime.get(provider.id);
    if (state && state.unavailableUntil > now) continue;
    for (const candidateModel of provider.models) {
      if ([...required].some((capability) => !candidateModel.capabilities.includes(capability))) continue;

      const taskScore = task === "coding" ? candidateModel.coding : task === "reasoning" ? candidateModel.reasoning : task === "fast" ? candidateModel.speed : candidateModel.quality;
      const latencyPenalty = state?.latencyEwmaMs ? Math.min(15, state.latencyEwmaMs / 1_000) : 0;
      const scarcityPenalty = state?.remainingRequests !== undefined && state.remainingRequests < 10 ? 20 : 0;
      const score = taskScore + candidateModel.quality * 0.15 + candidateModel.speed * 0.05 + (state?.qualityAdjustment ?? 0) - latencyPenalty - scarcityPenalty;
      ranked.push({
        provider,
        model: candidateModel,
        score,
        reasons: [`task=${task}`, `quality=${candidateModel.quality}`, `speed=${candidateModel.speed}`],
      });
    }
  }
  return ranked.sort((a, b) => b.score - a.score);
}
