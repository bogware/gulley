# SAML 2.0 SSO for the admin console

The control-api serves a **SAML 2.0 service provider (SP)** beside the OIDC gate
([ENTRA_SETUP.md](ENTRA_SETUP.md)): the console's "Sign in with SSO (SAML)" button runs
an SP-initiated login against any SAML IdP (Entra ID, Okta, Ping, ADFS, Keycloak…) and
mints the same admin session the OIDC gate does. Group / App-Role attributes map to
Gulley roles — built-in **or custom** — through `SAML_ROLE_MAP`, the same format as
`OIDC_ROLE_MAP`.

Implementation: `@node-saml/node-saml` (a deliberate production dependency of
`apps/control-api`, see [SUPPLY_CHAIN.md](SUPPLY_CHAIN.md)) does the XML signature
verification, condition checks and metadata; `apps/control-api/src/saml-gate.ts` /
`saml-routes.ts` add the flow binding, Destination/issuer checks, the replay guard and
the session tail shared with OIDC (`sso.ts`).

## Endpoints

| Route                     | Purpose                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /auth/saml/metadata` | SP metadata XML (entityID, ACS URL, NameID format, signing cert when AuthnRequests are signed) |
| `GET /auth/saml/login`    | Starts the SP-initiated flow: AuthnRequest → IdP (HTTP-Redirect binding)                       |
| `POST /auth/saml/acs`     | Assertion Consumer Service (HTTP-POST binding); validates the Response and mints the session   |
| `GET /auth/config`        | `{ enabled, loginUrl, oidc: {…}, saml: {…} }` — what the console's sign-in page shows          |

Through the console's `/control` proxy these are `https://<console-host>/control/auth/saml/…`.

## 1. Configure the SP (control-api)

```bash
SAML_ENABLED=true
SAML_SP_ENTITY_ID=urn:gulley:console                      # any stable URI; also the required Audience
SAML_SP_CALLBACK_URL=https://<console-host>/control/auth/saml/acs
SAML_IDP_ENTRY_POINT=<IdP SSO URL>                        # from the IdP (below)
SAML_IDP_ISSUER=<IdP entityID>                            # the assertion <Issuer> must equal this
SAML_IDP_CERT_FILE=/run/secrets/saml-idp.pem              # or SAML_IDP_CERT (PEM, \n-escaped)
SAML_COOKIE_SECURE=true                                   # required in production
GULLEY_ADMIN_SESSION_SECRET=<random, >=32 chars>
# group / App Role → Gulley role (built-in name or custom role id); orgId "*" = every org
SAML_ROLE_MAP=[{"group":"gulley-owner","role":"owner","orgId":"*"},{"group":"gulley-key-ops","role":"key-operator","orgId":"*"}]
```

Optional:

| Variable                                                    | Default          | Meaning                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAML_GROUPS_ATTRIBUTE`                                     | `groups`         | Attribute whose values feed the role map. The common group/role names (`groups`, `roles`, `role`, Entra's claims URIs) are always unioned in, like the OIDC gate. |
| `SAML_SUBJECT_ATTRIBUTE`                                    | `NameID`         | `NameID` or an attribute name that becomes the admin subject (the identity SCIM, RBAC grants and session revocation key on).                                      |
| `SAML_SP_PRIVATE_KEY(_FILE)` + `SAML_SP_CERT(_FILE)`        | unset            | Sign AuthnRequests (RSA-SHA256); the cert is published in the SP metadata.                                                                                        |
| `SAML_WANT_ASSERTIONS_SIGNED` / `SAML_WANT_RESPONSE_SIGNED` | `true` / `false` | Which signature(s) to require. At least one valid signature is always needed. Entra signs the assertion by default; Okta signs both.                              |
| `SAML_ALLOW_IDP_INITIATED`                                  | `false`          | Accept an unsolicited Response (no `InResponseTo`). See "Security" below before enabling.                                                                         |
| `SAML_CLOCK_SKEW_MS`                                        | `60000`          | Tolerance on `NotBefore` / `NotOnOrAfter`.                                                                                                                        |
| `SAML_POST_LOGIN_REDIRECT`                                  | `/`              | Landing path when the login was not started from a console page.                                                                                                  |
| `SAML_ALLOW_INSECURE_HTTP`                                  | `false`          | Production otherwise requires `https` on the entry point and ACS URL and `SAML_COOKIE_SECURE=true`.                                                               |

`SAML_IDP_CERT(_FILE)` may hold several PEM certificates (concatenated) during an IdP key
rollover; a response signed by any of them verifies. A `PUBLIC KEY` PEM is accepted too.

Boot refuses `SAML_ENABLED=true` without the full SP + IdP set. Once up,
`GET /auth/saml/metadata` serves the SP metadata and `/admin/status` reports the `saml`
subsystem.

## 2. Configure the IdP

Generic values (every IdP asks for these under its own names):

| IdP field                                | Value                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| Identifier / Entity ID / Audience URI    | `SAML_SP_ENTITY_ID`                                        |
| Reply URL / ACS URL / Single sign-on URL | `SAML_SP_CALLBACK_URL`                                     |
| Binding                                  | HTTP-POST                                                  |
| NameID format                            | emailAddress (what the SP metadata requests)               |
| Sign                                     | the assertion (or both); RSA-SHA256                        |
| Attributes                               | a `groups` (or App-Role) attribute, `displayName`, `email` |

Or import `GET /auth/saml/metadata` where the IdP supports metadata upload.

### Microsoft Entra ID

Entra admin center → **Enterprise applications → New application → Create your own
application → Integrate any other application (non-gallery)** → **Single sign-on → SAML**.

1. **Basic SAML Configuration** — Identifier = `SAML_SP_ENTITY_ID`; Reply URL =
   `SAML_SP_CALLBACK_URL`.
2. **Attributes & Claims** — add a **group claim** (or expose App Roles): Entra emits
   groups as `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups` and App
   Roles as `…/claims/role`; both names are read automatically, so `SAML_GROUPS_ATTRIBUTE`
   can stay at its default. Prefer App Roles (human-readable, no >150-group overage);
   with raw groups the values are object ids — map those ids in `SAML_ROLE_MAP`.
3. **SAML Certificates** — download the **Certificate (Base64)** → `SAML_IDP_CERT_FILE`.
   Copy **Login URL** → `SAML_IDP_ENTRY_POINT` and **Microsoft Entra Identifier**
   (`https://sts.windows.net/<tenant>/`) → `SAML_IDP_ISSUER`.
4. **Users and groups** — assign the users/groups (and App Roles) that may sign in.

Entra signs the assertion by default (the SP's default requirement). Entra's NameID is
the UPN for the emailAddress format; set `SAML_SUBJECT_ATTRIBUTE` to the claim your SCIM
`userName` uses if they differ, so SSO and SCIM share one subject.

### Okta

**Applications → Create App Integration → SAML 2.0.**

1. Single sign-on URL = `SAML_SP_CALLBACK_URL` (also use for Recipient/Destination);
   Audience URI = `SAML_SP_ENTITY_ID`; Name ID format = EmailAddress.
2. **Group Attribute Statements** — name `groups`, filter `Matches regex .*` (or a
   prefix); **Attribute Statements** — `displayName` = `user.displayName`, `email` =
   `user.email`.
3. **Sign On** tab → **View SAML setup instructions**: Identity Provider Single Sign-On
   URL → `SAML_IDP_ENTRY_POINT`, Identity Provider Issuer → `SAML_IDP_ISSUER`, X.509
   certificate → `SAML_IDP_CERT_FILE`.
4. Assign the app to the groups that may sign in.

Okta signs both the response and the assertion; the defaults accept that.

## 3. Role mapping

`SAML_ROLE_MAP` is a JSON array of `{ group, role, orgId }` — identical to
`OIDC_ROLE_MAP`. `group` matches any value of the groups/role attributes; `role` is a
built-in (`viewer`, `billing`, `editor`, `admin`, `owner`) **or a custom role id** created
on the console's Identity → Roles tab (or `POST /roles`); `orgId` is an org uuid or `"*"`
for every org. An unknown role id grants nothing (the rule is still carried on the
session, so it shows in the audit row). Rules whose `role` is not a well-formed id are
dropped at boot.

The mapped memberships are baked into the session and **unioned** with durable grants
(console-granted / SCIM-provisioned) for the same subject, exactly as for OIDC.

## 4. Security model

- **Signature.** The assertion (default) and/or the Response must be signed by one of
  the configured IdP certificates (RSA-SHA256 or stronger; the library rejects extra
  transforms, multiple assertions and wrapped-signature tricks). Unsigned material is
  never read.
- **Audience, issuer, destination, time.** `Audience` must equal `SAML_SP_ENTITY_ID`, the
  assertion `Issuer` must equal `SAML_IDP_ISSUER`, the Response `Destination` (when
  present) must equal the ACS URL, and `NotBefore`/`NotOnOrAfter` (Conditions and
  SubjectConfirmationData) are enforced with `SAML_CLOCK_SKEW_MS` tolerance.
- **Browser-bound flow (the CSRF defence).** `/auth/saml/login` HMAC-signs a flow
  record — a random `state`, the AuthnRequest id, its issue time, the return path and a
  10-minute expiry — into the `gulley_saml_flow` cookie and sends only the short `state`
  as `RelayState` (the binding caps RelayState at 80 bytes). The ACS requires the cookie,
  requires `RelayState` to equal the cookie's `state`, and requires the Response's
  `InResponseTo` (top level and SubjectConfirmation) to name the cookie's AuthnRequest
  id. A forged cross-site POST therefore cannot log a victim in as the attacker (login
  CSRF), and a response for one browser's request cannot be consumed by another. The
  state is stateless across replicas — the cookie is the store.
  - The ACS is **exempt from the Sec-Fetch-Site CSRF hook** (`http-edge.ts`,
    `CSRF_EXEMPT`): the IdP posts it cross-site by design, and it never acts on an
    existing session cookie.
  - The flow cookie must ride that cross-site POST, so it is `SameSite=None; Secure`
    when `SAML_COOKIE_SECURE=true` (production). On a plaintext dev edge browsers refuse
    `None` without `Secure`, so the attribute is omitted there — Chrome's Lax-by-default
    still sends a fresh attribute-less cookie on a top-level cross-site POST for two
    minutes; Firefox and Safari send it regardless. Finish a dev login within two minutes
    or use HTTPS.
- **Replay.** Each accepted assertion id is remembered until its `NotOnOrAfter` (plus
  skew, capped at 8 h); presenting it again is refused (`assertion rejected: replayed`).
  The guard is per process: with several control-api replicas and no sticky sessions,
  keep the IdP's assertion validity short (a few minutes). A shared guard is a tracked
  follow-up.
- **IdP-initiated SSO** (`SAML_ALLOW_IDP_INITIATED=true`) accepts a Response with no
  `InResponseTo` and no flow cookie, relying on the signature, audience, destination,
  time window and replay guard alone; `RelayState`, if the IdP sends one, is honoured
  only as a same-origin console path. Leave it off unless your IdP portal needs it.
- **Session.** The minted session is the ordinary admin session (`gses_…`, `src: saml`,
  audited as `admin.session.saml` with the assertion id, group count and whether the
  login was IdP-initiated); sign-out revokes it; the subject is upserted into the
  durable admin directory so SCIM deprovisioning and console grants apply.
- The IdP entry point is a browser redirect, not a server-side fetch, so it is not
  subject to the outbound egress allowlist.

## 5. Troubleshooting

| Symptom (`error.message`)                              | Cause / fix                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid or expired login state` (400)                 | Flow cookie missing/expired, or `RelayState` ≠ its state: the login took >10 min, the cookie was blocked (non-TLS edge beyond Chrome's 2-minute window → use HTTPS), or the Response was IdP-initiated with the mode off. |
| `assertion rejected: Invalid signature`                | Wrong/old IdP certificate, or the IdP signs only the Response while `SAML_WANT_ASSERTIONS_SIGNED=true`.                                                                                                                   |
| `assertion rejected: SAML assertion audience mismatch` | The IdP's Identifier/Audience ≠ `SAML_SP_ENTITY_ID`.                                                                                                                                                                      |
| `assertion rejected: issuer mismatch`                  | `SAML_IDP_ISSUER` ≠ the IdP entityID (Entra: `https://sts.windows.net/<tenant>/`, trailing slash included).                                                                                                               |
| `assertion rejected: destination mismatch`             | The IdP's Reply/ACS URL ≠ `SAML_SP_CALLBACK_URL` (scheme/host/path must match exactly).                                                                                                                                   |
| `assertion rejected: InResponseTo is not valid`        | The Response answers a different AuthnRequest (a stale IdP tab) — start the login again.                                                                                                                                  |
| `…SAML assertion expired` / not yet valid              | Clock skew between IdP and control-api; raise `SAML_CLOCK_SKEW_MS` or fix NTP.                                                                                                                                            |
| `assertion rejected: replayed`                         | The same assertion was posted twice (browser back/refresh) — start the login again.                                                                                                                                       |
| Logged in with no memberships                          | No `SAML_ROLE_MAP` rule matched: check the attribute name (`SAML_GROUPS_ATTRIBUTE`) and the group values the IdP emits (Entra raw groups are object ids).                                                                 |

Rejected responses are logged at `warn` with the library detail and `idpInitiated`.
