# @gulley/control-client

A dependency-free, typed TypeScript client for the Gulley control-plane admin API,
plus the published **OpenAPI 3.1** document that describes it.

## Client

```ts
import { ControlClient } from '@gulley/control-client';

const gulley = new ControlClient({
  baseUrl: 'https://gulley.internal:8081',
  token: process.env.GULLEY_ADMIN_TOKEN!, // gses_ session or gadm_ bootstrap token
});

const { org } = await gulley.createOrg('Acme');
const { workspace } = await gulley.createWorkspace(org.id, 'prod');
const key = await gulley.mintKey({ workspaceId: workspace.id, name: 'app' });

// Governed prompt registry
const { prompt } = await gulley.createPrompt({
  workspaceId: workspace.id,
  name: 'greeting',
  body: 'Hello {{name}}',
});
await gulley.renderPrompt(prompt.id, { variables: { name: 'Ada' } });
const chain = await gulley.verifyPromptChain(prompt.id); // { verified, count }
```

Every method sends the admin bearer token; a non-2xx response throws
`ControlApiError` carrying the status and parsed body (a non-JSON error page keeps
its status), and a network failure or a per-call deadline (`timeoutMs`) throws
`ControlNetworkError`. Pass `fetch` explicitly in runtimes without a global `fetch`.

## OpenAPI

`src/openapi.ts` is the source of truth. Regenerate the published artifact
(`docs/openapi/control-api.json`) with:

```bash
pnpm --filter @gulley/control-client openapi:emit
```

Import the document directly for codegen or a docs UI:

```ts
import { controlApiOpenApi } from '@gulley/control-client/openapi';
```
