# Free AI Harness

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A one-login AI gateway with no model picker. The user describes an outcome; the harness selects an eligible model for each step, uses tools, verifies the result, falls back when a provider is exhausted, and persists the workflow across restarts.

It uses legitimate provider APIs and local Ollama. It does **not** create accounts, scrape consumer chat products, bypass limits, or convert ChatGPT/Claude subscriptions into API quota. See [PROVIDERS.md](./PROVIDERS.md) for the researched free-tier snapshot.

## Implemented

- One-click Puter authorization for user-owned access to hundreds of models
- Isolated multi-user sessions, encrypted credentials, workflows, usage, and caches
- Administrator password fallback and optional bearer key for API clients
- Only one public model name: `auto`
- OpenAI-compatible chat completions, including streaming
- Non-streaming OpenAI Responses and Anthropic Messages compatibility
- Embeddings, image generation, and audio transcription routing
- Durable agent runs with planning, tool continuation, verification, cancellation, resumption, and restart recovery
- Automatic task/capability/privacy filtering, adaptive quality feedback, latency and quota scoring, provider fallback, and circuit breakers
- Encrypted SQLite credential vault and provider connection dashboard
- Live provider model discovery, health, usage ledger, and exact-response cache
- Built-in web search, safe HTTP, local workspace file tools, restricted test execution, time, and deterministic chess-square reasoning
- Private local Ollama fallback that the service starts automatically when installed

Supported connections: Puter Universal AI, NVIDIA NIM, Z.AI/GLM, Hugging Face Inference Providers, Groq, Gemini, GitHub Models, OpenRouter, Cloudflare Workers AI, Mistral, Cerebras, SambaNova, and any additional OpenAI-compatible endpoint through the custom connector. Puter supplies the primary user-owned model pool. One NVIDIA key exposes an administrator to free prototype endpoints for DeepSeek, Kimi, GLM, Nemotron, MiniMax, Qwen, GPT-OSS, and other chat models discovered from NVIDIA's live catalog. The browser never asks the end user to select one.

For an end user, “one login” is the **Continue with Universal AI** action. Puter authenticates the user and the harness validates and encrypts the resulting app credential. Every user gets a separate provider pool and separate workflow state. Administrator-connected capacity is not shared with users unless `HARNESS_SHARE_OPERATOR_CAPACITY=true` is explicitly enabled.

## Run

```bash
cd /home/edith/Projects/free-ai-harness
npm install
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `HARNESS_VAULT_KEY`, set `HARNESS_LOGIN_PASSWORD`, and optionally connect hosted providers in the dashboard. `.env` is loaded automatically:

```bash
chmod 600 .env
npm start
```

Open <http://127.0.0.1:8790> and choose **Continue with Universal AI**. The included user service can keep it running:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/free-ai-harness.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now free-ai-harness.service
```

For a small HTTPS preview, follow the non-destructive [Tailscale Funnel guide](./deploy/TAILSCALE.md). For a release deployment with immutable images, Caddy, backups, SBOMs, and rollback, use [production operations](./deploy/OPERATIONS.md) and the [release procedure](./deploy/RELEASE.md).

## API

Set `HARNESS_API_KEY` for machine clients, then request only `model: "auto"`:

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer $HARNESS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Write a binary search in TypeScript"}]}'
```

Primary routes:

| Route | Compatibility |
|---|---|
| `POST /v1/chat/completions` | OpenAI, streaming and non-streaming |
| `POST /v1/responses` | OpenAI Responses, non-streaming |
| `POST /v1/messages` | Anthropic Messages, non-streaming |
| `POST /v1/embeddings` | OpenAI embeddings |
| `POST /v1/images/generations` | OpenAI image shape; Cloudflare native adapter |
| `POST /v1/audio/transcriptions` | OpenAI multipart transcription; Groq Whisper adapter |
| `POST /v1/runs` | Persistent autonomous workflow |

## Honest limits

“Free” is not one fungible token balance. Providers enforce different request/day, token/minute, model, trial-credit, and acceptable-use limits. A rate limit is a ceiling, not a promised daily grant. Live model and quota responses are therefore authoritative. Aggregate capacity can grow into billions of tokens across a sufficiently large genuine user base, but the harness does not promise one billion free tokens to each user.

OpenAI and Anthropic commercial APIs are not treated as recurring free providers. Their consumer subscriptions cannot be reused as API access. Image and hosted audio routes require a compatible connected provider; local Ollama supplies chat and embeddings, not those modalities.

Likewise, website-only consumer credits are not scraped. Higgsfield currently has no public general API suitable for this pool. DeepSeek and Kimi are available through NVIDIA's free prototype endpoints; their direct metered APIs are not enabled in free-only mode.

## Security

- Keep the server on localhost unless it is placed behind TLS and access control.
- Use least-privilege provider keys. They are AES-256-GCM encrypted at rest and never returned by the API.
- Puter credentials are validated against Puter over HTTPS, converted to opaque local user IDs, and stored in the per-user encrypted vault.
- Do not reuse the login password as the vault key in a shared or production installation.
- Direct free providers whose policy permits training on prompts remain disabled unless `HARNESS_ALLOW_TRAINING_DATA=true` is explicitly set. Puter is a user-authorized broker across upstream providers with differing privacy terms; its disclosure is shown before authorization.
- Direct paid-provider fallback is absent by default. Puter is user-pays: the harness checks the reported allowance in free-only mode and blocks once exhausted, while Puter's own billing controls remain authoritative.
- Per-user request, output-token, rolling usage, workspace, and concurrent-run ceilings limit accidental or abusive consumption. The rolling token ceiling depends on upstream usage reporting and is a safety rail, not a billing guarantee.
- User workspaces are isolated. Production disables in-process code execution; network and file tools can be disabled independently. Stored runs and usage are retained for 30 days by default. Users can export a retained workflow/usage summary or permanently delete their harness account and workspace from the dashboard.
- Rate limits and runtime coordination are process-local. A multi-replica deployment needs a shared limiter and run coordinator before scaling horizontally.

## Open-source project

Free AI Harness is MIT-licensed. Contributions are welcome; read [CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md), the [privacy template](./PRIVACY.md), [acceptable-use terms](./TERMS.md), and the [code of conduct](./CODE_OF_CONDUCT.md) before participating. Never commit `.env`, provider credentials, databases, backups, user workspaces, or logs. CI runs the same repository-safety scan, typecheck, test suite, dependency audit, production build, and container build expected for releases. Public operators must adapt the privacy and terms templates with their own identity, jurisdiction, contact method, retention policy, and subprocessors.
