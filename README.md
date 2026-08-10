# Free AI Harness

An intelligent, agentic AI service with one user login and no model picker. Provider credentials belong to the harness, which routes every reasoning and tool step to the best currently usable model across legitimate free API tiers.

This project does **not** create extra accounts, scrape consumer chat products, bypass quotas, or turn subscription allowances into API tokens.

## What works in the MVP

- One local endpoint: `POST /v1/chat/completions`
- A single public model name: `auto`
- Durable agent workflows through `POST /v1/runs`
- Automatic continuation after tool calls, with restart-safe run state
- A browser login and objective-driven workflow screen
- Streaming and non-streaming responses
- Capability filtering for vision, tools, and JSON output
- Provider fallback on throttling and transient errors
- Quota-header tracking, latency scoring, and short circuit breakers
- Privacy gate: free tiers that may use prompts for product improvement are disabled by default
- No provider or model selection exposed to the user

Initial adapters: Groq, Gemini, GitHub Models, OpenRouter free models, Cloudflare Workers AI, Mistral, Cerebras, and SambaNova.

See [PROVIDERS.md](./PROVIDERS.md) for the researched quota snapshot and the important difference between recurring allocations and expiring trial credit.

## Setup

```bash
cd /home/edith/Projects/free-ai-harness
npm install
cp .env.example .env
```

Set `HARNESS_LOGIN_PASSWORD`, add service-owned provider keys, then export the file and start:

```bash
set -a
source .env
set +a
npm start
```

Point any OpenAI-compatible client at `http://127.0.0.1:8787/v1` and use the value of `HARNESS_API_KEY` as its API key. If `HARNESS_API_KEY` is empty, authentication is disabled; keep the server bound to localhost.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto:coding","messages":[{"role":"user","content":"Write a binary search in TypeScript"}]}'
```

Open `http://127.0.0.1:8790`, log in once, and submit an objective. The 30-day session survives browser restarts. API clients can use the optional machine-to-machine `HARNESS_API_KEY` and must request `model: "auto"`.

## Honest limits

“Free” is not a single token balance. Vendors enforce different combinations of requests/day, tokens/minute, model-specific capacity, trial credits, and acceptable-use restrictions. A rate limit is a ceiling, not a guaranteed daily grant. The harness therefore treats live responses as authoritative and never promises a collective token number.

The OpenAI and Anthropic commercial APIs are intentionally not counted as recurring free providers. They can be added later as opt-in paid fallbacks with hard budget caps.

## Next build stages

1. Web setup UI with one harness login and provider connection cards.
2. OS-keychain-backed encrypted credential vault; OAuth where a provider officially supports it, pasted scoped keys elsewhere.
3. Live model catalog discovery and a signed provider registry so limits can update without a release.
4. SQLite usage ledger with daily/monthly reset windows and cost-equivalent accounting.
5. Eval-driven routing trained from the user's own accepted/rejected results, plus semantic cache and local Ollama fallback.
6. Responses API, embeddings, images, audio, and Anthropic-format compatibility.

## Security defaults for the full product

- Never send the same prompt to multiple providers unless the user enables evaluation mode.
- Redact secrets before routing and allow provider/data-region deny lists.
- Use least-privilege provider tokens, encrypted at rest, with no key values in logs.
- Keep paid fallback off by default and require explicit per-day and per-month caps.
