import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { controlApiOpenApi } from '../src/openapi';

// Serialize the OpenAPI document (the source of truth in src/openapi.ts) to the
// published artifact under docs/openapi/. Manual/idempotent — run when the spec
// changes; there is no runtime/scheduled regeneration.
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../docs/openapi/control-api.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(controlApiOpenApi, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${out}\n`);
