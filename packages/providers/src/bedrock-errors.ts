/**
 * Bedrock → Anthropic error shaping.
 *
 * Claude Code's capability-rejection recovery matches on the upstream's error
 * WORDING (Anthropic's gateway contract: "forward error response bodies
 * unmodified … unless the envelope's message carries a stable `capability_rejected:`
 * token"). A translated route can't forward Bedrock's `{"message": …}` body as is —
 * no client SDK understands it — so it is reshaped into Anthropic's standard
 * envelope, the status code is kept, the message is kept verbatim (so wording-based
 * matches such as "Extra inputs are not permitted" still work), and the one case
 * that has a different wording on Bedrock is replaced by its contract token:
 * Bedrock's "Input is too long for requested model." becomes
 * `capability_rejected: prompt_too_long`, which Claude Code treats like "prompt is
 * too long" (it compacts and retries).
 */
export interface AnthropicErrorBody {
  type: 'error';
  error: { type: string; message: string };
}

export const PROMPT_TOO_LONG_TOKEN = 'capability_rejected: prompt_too_long';

const INPUT_TOO_LONG_RE =
  /input is too long for requested model|too many input tokens|prompt is too long/i;

/** Map a Bedrock exception name (`ValidationException`, `throttlingException`, an
 *  `x-amzn-errortype` value such as `ThrottlingException:http://…`) and/or the HTTP
 *  status to the closest Anthropic `error.type`. */
export function anthropicErrorType(bedrockType: string | undefined, status: number): string {
  const t = (bedrockType ?? '')
    .split(':')[0]!
    .toLowerCase()
    .replace(/exception$/, '');
  switch (t) {
    case 'throttling':
      return 'rate_limit_error';
    case 'modelnotready':
    case 'serviceunavailable':
    case 'servicequotaexceeded':
      return 'overloaded_error';
    case 'validation':
      return 'invalid_request_error';
    case 'accessdenied':
      return 'permission_error';
    case 'resourcenotfound':
      return 'not_found_error';
    case 'internalserver':
    case 'internalerror':
    case 'modelstreamerror':
    case 'modeltimeout':
    case 'modelerror':
      return 'api_error';
    default:
      break;
  }
  if (status === 400 || status === 413 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 503) return 'overloaded_error';
  return 'api_error';
}

/** The message to put in the envelope: verbatim, except the contract token for a
 *  prompt that does not fit the model (a 413, or Bedrock's own wording). */
export function anthropicErrorMessage(message: string, status: number): string {
  if (status === 413 || INPUT_TOO_LONG_RE.test(message)) return PROMPT_TOO_LONG_TOKEN;
  return message;
}

export function shapeBedrockError(
  status: number,
  bedrockType: string | undefined,
  message: string,
): AnthropicErrorBody {
  return {
    type: 'error',
    error: {
      type: anthropicErrorType(bedrockType, status),
      message: anthropicErrorMessage(message, status),
    },
  };
}

/** Parse a Bedrock JSON error body (`{"message": "…"}`, sometimes `{"Message": …}`),
 *  falling back to the raw text or a generic message. */
export function bedrockErrorMessage(raw: string, fallback = 'bedrock error'): string {
  try {
    const j = JSON.parse(raw) as { message?: unknown; Message?: unknown };
    if (typeof j.message === 'string' && j.message.length > 0) return j.message;
    if (typeof j.Message === 'string' && j.Message.length > 0) return j.Message;
  } catch {
    /* not JSON */
  }
  const text = raw.trim();
  return text.length > 0 && text.length <= 2048 ? text : fallback;
}
