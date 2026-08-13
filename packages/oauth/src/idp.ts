/** The upstream identity provider. Entra (OIDC) is the prod adapter; the broker
 *  treats it behind this port so the token lifecycle is testable without a real
 *  tenant. `isPrincipalActive` powers revoke-on-deprovision. */
export interface IdentityProvider {
  readonly mode: 'entra' | 'simulated';
  isPrincipalActive(subject: string): Promise<boolean>;
}

/** CI / live-check IdP: identities come from a simulated consent step; principals
 *  can be deactivated to exercise revoke-on-deprovision. */
export class SimulatedIdp implements IdentityProvider {
  readonly mode = 'simulated' as const;
  private readonly inactive = new Set<string>();

  deactivate(subject: string): void {
    this.inactive.add(subject);
  }

  async isPrincipalActive(subject: string): Promise<boolean> {
    return !this.inactive.has(subject);
  }
}
