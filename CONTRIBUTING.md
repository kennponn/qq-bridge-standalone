# Contributing

Use Node.js >=22.13.0. Install locked dependencies with `npm ci`, run `npm test`,
`npm run test:voice`, and `npm run release:check` before opening a pull request.

Tests must use synthetic accounts, synthetic secrets, temporary directories,
mock OneBot gateways, and mock providers. Never send a test message to a real QQ
group, call a paid model, or read another user's DSH credentials by default.

Keep host authorization, per-conversation identity, allowlists, pause/reset
invalidation, rate limits, bounded timeouts, and private assistant text intact.
Role cards cannot grant permissions. Administrative APIs cannot be exposed as
model tools.

Do not add runtime state, provider keys, personal role cards, dependencies,
third-party gateway binaries, or unlicensed media to the repository. Preserve
copyright notices and document the license of new dependencies.
