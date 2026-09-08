# Microsoft Entra ID (Azure AD) setup

Gulley supports Entra end to end: **SSO into the admin console**, **JWT auth into the
data-plane gateway**, **group/App-Role → RBAC**, **SCIM provisioning**, and
**revoke-on-deprovision** via Microsoft Graph. This guide registers the Enterprise
App and wires each piece. Roles map from **Entra App Roles** (recommended) or
security groups.

## 1. Register the application

Entra admin center → **App registrations → New registration**.

- **Redirect URI** (Web): `https://<your-console-host>/control/auth/callback`
- Note the **Application (client) ID**, **Directory (tenant) ID**, and create a
  **client secret** (Certificates & secrets).
- **Expose an API** → set the Application ID URI, e.g. `api://gulley`. This is your
  `JWT_AUDIENCE` for data-plane tokens.

## 2. Define App Roles (recommended over raw groups)

**App registrations → your app → App roles → Create app role.** App Roles are
human-readable, appear in the `roles` claim, and never hit the >200-group "overage".

| Display name  | Value           | Allowed member types |
| ------------- | --------------- | -------------------- |
| Gulley Owner  | `gulley-owner`  | Users/Groups         |
| Gulley Editor | `gulley-editor` | Users/Groups         |
| Gulley Viewer | `gulley-viewer` | Users/Groups         |

Then, under **Enterprise applications → your app → Users and groups**, assign users
or groups to these roles.

> Prefer App Roles. If you must use security groups instead, add a **groups** claim
> (Token configuration → Add groups claim) and map group **object IDs** in the role
> maps below. Gulley also detects the Entra groups-overage indirection and logs a
> clear warning — another reason to use App Roles.

## 3. Console SSO (control-api)

```bash
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application-client-id>
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://<your-console-host>/control/auth/callback
OIDC_COOKIE_SECURE=true
GULLEY_ADMIN_SESSION_SECRET=<random, >=32 chars>
# App Role / group name -> Gulley role. orgId "*" = platform-wide.
OIDC_ROLE_MAP=[{"group":"gulley-owner","role":"owner","orgId":"*"},{"group":"gulley-viewer","role":"viewer","orgId":"*"}]
```

The console shows **"Sign in with SSO"** whenever `/auth/config` reports enabled. On
callback Gulley verifies the id_token (JWKS, asymmetric-only), maps App Roles/groups
to memberships, and **upserts the user into the durable admin directory** so SSO,
RBAC, SCIM, and the console are one identity.

## 4. Data-plane gateway auth (optional)

Let clients call the gateway with an Entra JWT (`Authorization: Bearer <jwt>`)
instead of, or alongside, virtual keys:

```bash
JWT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
JWT_AUDIENCE=api://gulley
# Entra group/App-Role -> data-plane scope. DENY-BY-DEFAULT: with this set, a valid
# token whose roles/groups match no rule (and carries no explicit workspace claim) is
# rejected — token validity alone never authorizes.
JWT_GROUP_SCOPE_MAP=[{"group":"gulley-eng","orgId":"<org-uuid>","workspaceId":"<ws-uuid>","models":["claude-sonnet-4-6"],"providers":["anthropic"]}]
```

Acquire tokens for `api://gulley` (client-credentials for services, or on-behalf-of
for user flows). Custom scope claims (`JWT_WORKSPACE_CLAIM` etc.) still take
precedence when present.

## 5. Revoke-on-deprovision via Microsoft Graph

So a disabled/deleted user loses broker + data-plane access at the next refresh
(not at the 90-day absolute TTL), grant the app the **`User.Read.All`** (or
`Directory.Read.All`) **APPLICATION** permission (API permissions → add → Microsoft
Graph → Application permissions → **Grant admin consent**), then:

```bash
ENTRA_TENANT_ID=<tenant-id>
ENTRA_GRAPH_CLIENT_ID=<application-client-id>   # same app, or a dedicated Graph app
ENTRA_GRAPH_CLIENT_SECRET=<client-secret>
OUTBOUND_HOST_ALLOWLIST=login.microsoftonline.com,graph.microsoft.com
```

## 6. SCIM provisioning

Point Entra's provisioning at `https://<your-console-host>/control/scim/v2` with a
bootstrap admin (or session) token as the secret. Gulley implements SCIM **Users**
(lifecycle + deprovision cascade) and **Groups**. To have a group assignment
provision a role, map the SCIM group's displayName:

```bash
SCIM_GROUP_ROLE_MAP={"gulley-editors":{"role":"editor","orgId":"*"}}
```

Each member of a provisioned group is granted the mapped role; removing the member —
or deleting the group — revokes exactly that grant.

## Roles

Gulley RBAC roles: `owner`, `admin`, `editor`, `viewer` (deny-by-default; see
`packages/rbac`). Map the least privilege each App Role/group needs.
