/** The control-api base the /control proxy forwards to — read at REQUEST time from
 *  `CONTROL_API_URL` (a runtime env, so one console image serves any environment). */
export function controlApiUpstream(): string {
  // `||`, not `??`: an EMPTY env (a blank build arg, `CONTROL_API_URL=` in an env file)
  // must fall back too, not proxy to "".
  return (process.env['CONTROL_API_URL'] || 'http://localhost:8081').replace(/\/+$/, '');
}
