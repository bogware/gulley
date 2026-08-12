/**
 * Internal auth-failure reasons for logging/telemetry. The gateway maps EVERY
 * one of these to a single generic 401 to the client — never leaking which
 * check failed (no prefix-vs-secret distinction).
 */
export type AuthFailureReason =
  | 'missing_credential'
  | 'malformed_credential'
  | 'unknown_key'
  | 'bad_secret'
  | 'disabled'
  | 'expired'
  | 'mode_not_allowed'
  | 'no_scope';

export interface AuthFailure {
  reason: AuthFailureReason;
}
