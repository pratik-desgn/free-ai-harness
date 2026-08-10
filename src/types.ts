export type TaskKind = "general" | "coding" | "reasoning" | "fast";
export type Capability = "text" | "vision" | "tools" | "json";

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: unknown;
  [key: string]: unknown;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  response_format?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ModelSpec {
  id: string;
  capabilities: Capability[];
  context: number;
  quality: number;
  speed: number;
  coding: number;
  reasoning: number;
}

export interface ProviderSpec {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  freeEligible: boolean;
  quotaKind?: "recurring" | "monthly-credit" | "trial" | "variable";
  dataMayTrain: boolean;
  models: ModelSpec[];
  extraHeaders?: Record<string, string>;
  availabilityCheck?: () => Promise<void>;
}

export interface Candidate {
  provider: ProviderSpec;
  model: ModelSpec;
  score: number;
  reasons: string[];
}

export interface ProviderRuntime {
  failures: number;
  unavailableUntil: number;
  latencyEwmaMs?: number;
  remainingTokens?: number;
  remainingRequests?: number;
  qualityAdjustment?: number;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunEvent {
  at: string;
  type: "created" | "model" | "tool" | "verification" | "completed" | "failed";
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  userId: string;
  status: RunStatus;
  objective: string;
  messages: ChatMessage[];
  events: RunEvent[];
  step: number;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
