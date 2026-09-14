#!/usr/bin/env node
// Global entrypoint (`npm i -g` / `pnpm link --global` from packages/cli, or the
// workspace bin). Libraries in this monorepo ship TypeScript source, so register tsx
// and hand off to the real CLI. Kept dependency-light: tsx is the only runtime dep.
import { register } from 'tsx/esm/api';

register();
await import('../src/bin.ts');
