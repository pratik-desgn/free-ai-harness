# Contributing

Contributions are welcome. Keep changes focused, preserve the one-public-model (`auto`) contract, and never commit credentials or user data.

## Development

Requirements: Node.js 24 and npm.

```bash
npm ci
npm run check
```

Copy `.env.example` to `.env` only for local development. Use fake credentials in tests and examples. The repository safety check scans tracked files and rejects common secret formats and private runtime paths.

## Pull requests

1. Explain the user-visible behavior and security implications.
2. Add or update tests for behavior changes, tenant boundaries, migrations, and failure paths.
3. Run `npm run check` and `npm audit --omit=dev`.
4. Update provider documentation only from official API, pricing, quota, and privacy sources; record the verification date.
5. Do not weaken authentication, origin checks, quota controls, provider isolation, or tool policy to make a test pass.

Provider integrations must use documented APIs and legitimate user or operator authorization. Account creation automation, credential sharing, consumer-site scraping, quota bypasses, and subscription-token conversion are out of scope.

By contributing, you agree that your contribution is licensed under the MIT License.
