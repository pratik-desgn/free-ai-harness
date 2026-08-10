# Verified provider snapshot

Checked against official provider documentation on 2026-08-10. Limits change frequently, can be account-specific, and are ceilings rather than guaranteed capacity. The live provider dashboard and response headers override this file.

## Useful recurring or continuing free API access

| Provider | Documented free shape | Harness adapter | Important constraint |
|---|---|---:|---|
| Google Gemini | Free-tier token pricing for eligible models | Yes | Free-tier prompts may be used to improve Google products; disabled by the harness privacy default |
| Groq | Free-plan model-specific RPM/RPD/TPM/TPD | Yes | Organization-wide limits; for example, current GPT-OSS models show 200K TPD |
| Cloudflare Workers AI | 10,000 neurons/day | Yes | Neurons are compute units, not a simple token grant |
| GitHub Models | Free rate-limited use per account/model | Yes | Intended for prototyping and experimentation, not production |
| OpenRouter | Free-model pool, normally 50 requests/day total | Yes | Capacity and chosen model vary; 1,000 requests/day requires a prior $10 credit purchase |
| Mistral Studio | Free API mode with account-specific limits | Yes | Exact current limits are exposed in the account usage page |
| NVIDIA NIM | Free hosted prototype endpoints for Developer Program members | Yes | Trial/prototyping terms, not a production entitlement; one key covers DeepSeek, Kimi, GLM, Nemotron, MiniMax, Qwen, and more |
| Z.AI | GLM-4.7-Flash, GLM-4.5-Flash, and GLM-4.6V-Flash are listed at zero token price | Yes | Other GLM models and built-in web search are metered |
| Hugging Face Inference Providers | $0.10 credit/month for free accounts | Yes | Small monthly balance; routed providers stop when no usable credit remains |
| Cohere | Evaluation key, 1,000 calls/month | Planned | Evaluation use, not a production entitlement |

## Trial or ambiguous-duration access

| Provider | Documented shape | Harness adapter | Why separated |
|---|---|---:|---|
| Cerebras | Current pricing advertises $5 signup credit; rate-limit docs also publish a Free table up to 1M TPD on several models | Yes | Official pages disagree on whether free access continues after credit; the harness labels it trial |
| SambaNova Cloud | $5 signup credit expiring after 30 days; free-tier rate docs show 200K TPD | Yes | Not a durable daily allocation after trial credit expires |

## Not counted as recurring free general inference

- OpenAI: current general-purpose API model pages show the Free API tier as unsupported. ChatGPT/Codex subscriptions are separate products and cannot be pooled as API quota.
- Anthropic: consumer Claude plans are not a transferable API allowance. Any promotional API credit should be treated as temporary until the account dashboard proves otherwise.
- DeepSeek and Moonshot/Kimi direct APIs are metered account APIs. Their models are connected through NVIDIA's free prototype endpoints instead, preventing direct balance charges.
- Higgsfield is a consumer creative suite and currently does not publish a general developer API suitable for this harness. Website login automation is intentionally prohibited.
- Cloud welcome credits from AWS, Azure, or Google Cloud are promotional balances, not permanent free model quotas.
- Local models through Ollama are genuinely zero marginal API cost but consume the user's own electricity and hardware; they belong in the fallback layer rather than the hosted-token total.

## Primary sources

- OpenAI model limits: https://developers.openai.com/api/docs/models/gpt-5.4-mini
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Groq limits: https://console.groq.com/docs/rate-limits
- Cloudflare allocation: https://developers.cloudflare.com/workers-ai/platform/pricing/
- GitHub Models free use: https://docs.github.com/en/billing/concepts/product-billing/github-models
- OpenRouter free limits: https://openrouter.ai/docs/faq
- Mistral free mode: https://docs.mistral.ai/admin/billing-usage/subscriptions
- NVIDIA free prototype endpoints and catalog: https://docs.api.nvidia.com/nim/docs/run-anywhere and https://docs.api.nvidia.com/nim/reference/llm-apis
- Z.AI Flash pricing and API: https://docs.z.ai/guides/overview/pricing and https://docs.z.ai/guides/develop/http/introduction
- Hugging Face monthly credits and OpenAI compatibility: https://huggingface.co/docs/inference-providers/en/pricing and https://huggingface.co/docs/inference-providers/en/tasks/chat-completion
- Cerebras limits and pricing: https://inference-docs.cerebras.ai/support/rate-limits and https://www.cerebras.ai/pricing
- SambaNova limits and plan: https://docs.sambanova.ai/docs/en/models/rate-limits and https://cloud.sambanova.ai/plans
- Hugging Face credits: https://huggingface.co/docs/inference-providers/en/pricing
- Cohere evaluation limits: https://docs.cohere.com/v2/docs/rate-limits
