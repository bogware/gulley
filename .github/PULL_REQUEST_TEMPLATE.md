<!-- Thanks for contributing to Gulley! Keep PRs focused and small where you can. -->

## What & why

<!-- What does this change do, and why? Link any issue: Closes #123 -->

## How it was tested

<!-- Commands run, new/updated tests, manual verification. -->

## Checklist

- [ ] `bash ci/verify.sh` passes locally (format, lint, typecheck, test, build)
- [ ] Tests added/updated for the change
- [ ] Docs updated if behavior or config changed (`.env.example`, `docs/`)
- [ ] Commits are signed off (`git commit -s`) — DCO is required
- [ ] No secrets, credentials, or provider keys in code/tests/config (ARNs only)

## Hot path

- [ ] This change touches the data-plane hot path (`apps/gateway/src/routes/messages.ts`,
      `context.ts`, `packages/{budget,cost,cache,routing}`, `providers/src/sse.ts`).
      If checked, describe how the invariants in
      [`docs/HOTPATH_REVIEW.md`](../docs/HOTPATH_REVIEW.md) are preserved.
