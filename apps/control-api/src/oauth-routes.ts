import { normalizeUserCode, type BrokerService, type OAuthError } from '@gulley/oauth';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adminRoute, body, str } from './admin';
import type { ControlContext } from './context';

/** RFC 6749 §5.2 error → HTTP status. `invalid_client` is a 401 per the RFC so a
 *  harness distinguishes "unknown client" from a bad grant. */
function oauthStatus(code: OAuthError['error']): number {
  return code === 'invalid_client' ? 401 : 400;
}

const DESCRIPTIONS: Partial<Record<OAuthError['error'], string>> = {
  invalid_client:
    'unknown, disabled, or grant-type-incapable client — an admin registers clients in the console (Identity → OAuth broker)',
  authorization_pending: 'the user has not approved the request yet — keep polling',
  slow_down: 'polling too fast — increase the interval by 5 seconds',
  expired_token: 'the device code expired — start a new authorization',
  access_denied: 'the request was denied at the consent page',
  invalid_grant: 'the grant is invalid, expired, revoked, or was already used',
  unsupported_grant_type:
    'supported: device_code (RFC 8628 URN), authorization_code, refresh_token',
};

function sendError(reply: FastifyReply, err: OAuthError | OAuthError['error']): FastifyReply {
  const code = typeof err === 'string' ? err : err.error;
  const desc = DESCRIPTIONS[code];
  return reply
    .code(oauthStatus(code))
    .send(desc ? { error: code, error_description: desc } : { error: code });
}

/** RFC 6749 §5.1: token responses must not be cached by clients or intermediaries. */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

/** The broker's public origin (issuer): configured, else derived from the
 *  proxy-trusted request (trustProxy is a fixed hop count, so X-Forwarded-* from the
 *  ALB is honored and a client cannot spoof it). */
export function publicOrigin(ctx: ControlContext, request: FastifyRequest): string {
  if (ctx.controlApiPublicUrl) return ctx.controlApiPublicUrl.replace(/\/+$/, '');
  // `host` keeps a non-default port (`hostname` strips it), which matters for a
  // dev/self-hosted broker on :8081.
  return `${request.protocol}://${request.host}`;
}

/** Where a device-flow user is sent to consent: the console's page when a console
 *  URL is configured, else this control plane's own minimal page. */
export function verificationUri(ctx: ControlContext, request: FastifyRequest): string {
  const base = ctx.consolePublicUrl
    ? ctx.consolePublicUrl.replace(/\/+$/, '')
    : publicOrigin(ctx, request);
  return `${base}/oauth/device`;
}

const DEVICE_GRANT_TYPES = new Set(['device_code', 'urn:ietf:params:oauth:grant-type:device_code']);

/**
 * OAuth broker HTTP surface — what a coding harness (`gulley login` / `gulley token`,
 * or any RFC-conformant client) talks to:
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata (discovery)
 *   POST /oauth/device_authorization               RFC 8628 §3.1 (form or JSON)
 *   GET  /oauth/device                             consent page (user enters the code)
 *   GET  /oauth/device/preview?user_code=          which client/tenancy is asking (admin session)
 *   POST /oauth/device/authorize | /deny           consent decision (admin session)
 *   POST /oauth/token                              device_code (short form or RFC URN),
 *                                                  authorization_code (PKCE S256), refresh_token
 *   POST /oauth/revoke                             RFC 7009 (always 200)
 *   GET  /oauth/authorize                          auth-code + PKCE (admin session)
 *
 * The consent + authorize endpoints require an authenticated admin identity — the
 * consenting user — so no client-supplied identity is trusted, and the consenting
 * user must hold `key:create` on the client's tenancy (deny by default).
 */
export function registerOAuthRoutes(
  app: FastifyInstance,
  broker: BrokerService,
  ctx: ControlContext,
): void {
  app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
    const issuer = publicOrigin(ctx, request);
    return reply.header('cache-control', 'public, max-age=300').send({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      introspection_endpoint: `${issuer}/oauth/introspect`,
      grant_types_supported: [
        'urn:ietf:params:oauth:grant-type:device_code',
        'authorization_code',
        'refresh_token',
      ],
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      // Gulley extension: the consent page a device-flow user is sent to.
      device_verification_uri: verificationUri(ctx, request),
    });
  });

  app.post('/oauth/device_authorization', async (request, reply) => {
    const clientId = str(body(request)['client_id']);
    if (!clientId) return sendError(reply, 'invalid_request');
    const r = await broker.deviceAuthorization(clientId, {
      verificationUri: verificationUri(ctx, request),
    });
    return r.ok ? noStore(reply).send(r.value) : sendError(reply, r.error);
  });

  // The consent page. Static HTML + a nonce'd inline script; the user code is read
  // client-side from the query string (never interpolated server-side), the decision is
  // POSTed same-origin with the admin session cookie (SSO) or a pasted admin token.
  app.get('/oauth/device', async (request, reply) => {
    const nonce = randomBytes(16).toString('base64');
    const loginUrl = ctx.oidc ? `${publicOrigin(ctx, request)}/auth/login` : '';
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
      )
      .send(consentPage(nonce, loginUrl));
  });

  app.get(
    '/oauth/device/preview',
    adminRoute(ctx, async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const userCode = str(q['user_code']);
      if (!userCode) return sendError(reply, 'invalid_request');
      const r = await broker.devicePreview(userCode);
      if (!r.ok) return sendError(reply, r.error);
      const ws = ctx.workspaces.get(r.value.workspaceId);
      const org = ctx.orgs.get(r.value.orgId);
      return noStore(reply).send({
        userCode: normalizeUserCode(userCode),
        clientId: r.value.clientId,
        clientName: r.value.clientName,
        orgId: r.value.orgId,
        orgName: org?.name,
        workspaceId: r.value.workspaceId,
        workspaceName: ws?.name,
        expiresAt: new Date(r.value.expiresAt).toISOString(),
      });
    }),
  );

  app.post(
    '/oauth/device/authorize',
    adminRoute(ctx, async (request, reply, admin) => {
      const userCode = str(body(request)['user_code']);
      if (!userCode) return sendError(reply, 'invalid_request');
      const r = await broker.deviceApprove(
        userCode,
        { subject: admin.subject, displayName: admin.displayName },
        (t) => ctx.access.can(admin, 'key:create', { orgId: t.orgId, workspaceId: t.workspaceId }),
      );
      if (r.ok) {
        await ctx.audit.append({
          orgId: null,
          actor: admin.subject,
          action: 'oauth.device_approved',
          target: normalizeUserCode(userCode),
          payload: { userCode: normalizeUserCode(userCode) },
        });
      }
      return r.ok ? noStore(reply).send({ approved: true }) : sendError(reply, r.error);
    }),
  );

  app.post(
    '/oauth/device/deny',
    adminRoute(ctx, async (request, reply, admin) => {
      const userCode = str(body(request)['user_code']);
      if (!userCode) return sendError(reply, 'invalid_request');
      const r = await broker.deviceDeny(userCode, (t) =>
        ctx.access.can(admin, 'key:create', { orgId: t.orgId, workspaceId: t.workspaceId }),
      );
      if (r.ok) {
        await ctx.audit.append({
          orgId: null,
          actor: admin.subject,
          action: 'oauth.device_denied',
          target: normalizeUserCode(userCode),
          payload: { userCode: normalizeUserCode(userCode) },
        });
      }
      return r.ok ? noStore(reply).send({ denied: true }) : sendError(reply, r.error);
    }),
  );

  app.post('/oauth/token', async (request, reply) => {
    const b = body(request);
    const grantType = str(b['grant_type']) ?? '';
    const clientId = str(b['client_id']) ?? '';
    noStore(reply);
    if (DEVICE_GRANT_TYPES.has(grantType)) {
      const dc = str(b['device_code']);
      if (!dc) return sendError(reply, 'invalid_request');
      const r = await broker.tokenDeviceCode(dc, clientId);
      return r.ok ? reply.send(r.value) : sendError(reply, r.error);
    }
    if (grantType === 'refresh_token') {
      const rt = str(b['refresh_token']);
      if (!rt) return sendError(reply, 'invalid_request');
      const r = await broker.refresh(rt, clientId);
      return r.ok ? reply.send(r.value) : sendError(reply, r.error);
    }
    if (grantType === 'authorization_code') {
      const code = str(b['code']);
      const verifier = str(b['code_verifier']);
      const redirectUri = str(b['redirect_uri']);
      if (!code || !verifier || !redirectUri) return sendError(reply, 'invalid_request');
      const r = await broker.tokenAuthCode({ code, codeVerifier: verifier, redirectUri, clientId });
      return r.ok ? reply.send(r.value) : sendError(reply, r.error);
    }
    return sendError(reply, 'unsupported_grant_type');
  });

  // RFC 7662 introspection, restricted to the token the caller already holds: it
  // answers only "is THIS access token still active" (plus its client/subject/expiry),
  // so a harness's token helper notices an admin revocation or a reuse-triggered family
  // kill within its refresh interval instead of handing the agent a dead token. Sits
  // under the auth-surface rate limit; reveals nothing a holder does not already know.
  app.post('/oauth/introspect', async (request, reply) => {
    const token = str(body(request)['token']);
    noStore(reply);
    if (!token) return sendError(reply, 'invalid_request');
    const r = await broker.introspectAccessToken(token);
    return reply.send(
      r
        ? {
            active: true,
            token_type: 'Bearer',
            client_id: r.clientId,
            sub: r.principalId,
            exp: Math.floor(r.accessTokenExpiresAt / 1000),
          }
        : { active: false },
    );
  });

  app.post('/oauth/revoke', async (request, reply) => {
    const token = str(body(request)['token']);
    if (token) await broker.revoke(token);
    return noStore(reply).send({}); // always 200, regardless of token validity (RFC 7009)
  });

  app.get(
    '/oauth/authorize',
    adminRoute(ctx, async (request, reply, admin) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const clientId = str(q['client_id']);
      const redirectUri = str(q['redirect_uri']);
      const codeChallenge = str(q['code_challenge']);
      const method = str(q['code_challenge_method']) ?? '';
      const state = str(q['state']) ?? '';
      if (!clientId || !redirectUri || !codeChallenge) return sendError(reply, 'invalid_request');
      const r = await broker.authorize(
        {
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod: method,
          identity: { subject: admin.subject, displayName: admin.displayName },
        },
        (t) => ctx.access.can(admin, 'key:create', { orgId: t.orgId, workspaceId: t.workspaceId }),
      );
      return r.ok ? noStore(reply).send(r.value) : sendError(reply, r.error);
    }),
  );
}

/** The minimal consent page served by the control plane itself (the console has a
 *  richer one). No server-side interpolation of user input: the code comes from
 *  `location.search` on the client and only ever lands in an input's `.value`. */
function consentPage(nonce: string, loginUrl: string): string {
  const login = loginUrl
    ? `<p class="hint">Not signed in? <a id="sso" href="${loginUrl}">Sign in with SSO</a>, then return here.</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gulley · Approve a device</title>
<style nonce="${nonce}">
  :root{color-scheme:light dark}
  body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#111}
  main{max-width:420px;margin:8vh auto;padding:0 16px}
  .card{background:#fff;border:1px solid #e2e5ea;border-radius:10px;padding:20px}
  h1{font-size:18px;margin:0 0 4px}.sub{color:#5b6472;margin:0 0 16px}
  label{display:block;font-size:12px;color:#5b6472;margin:12px 0 4px}
  input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cfd4dc;border-radius:6px;font:inherit}
  #code{font:600 20px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}
  .row{display:flex;gap:8px;margin-top:16px}
  button{flex:1;padding:9px 12px;border-radius:6px;border:1px solid #cfd4dc;background:#fff;font:inherit;cursor:pointer}
  button.primary{background:#111;color:#fff;border-color:#111}
  button:disabled{opacity:.5;cursor:default}
  .preview{margin-top:14px;padding:10px 12px;background:#f3f4f6;border-radius:6px;font-size:13px}
  .preview b{font-weight:600}.hint{font-size:12px;color:#5b6472}
  .msg{margin-top:12px;font-size:13px}.ok{color:#137333}.err{color:#b3261e}
  @media (prefers-color-scheme:dark){body{background:#0f1115;color:#e6e8eb}.card{background:#171a21;border-color:#2a2f3a}input{background:#0f1115;color:#e6e8eb;border-color:#2a2f3a}button{background:#171a21;color:#e6e8eb;border-color:#2a2f3a}button.primary{background:#e6e8eb;color:#111;border-color:#e6e8eb}.preview{background:#1f232c}}
</style></head>
<body><main><div class="card">
  <h1>Approve a device</h1>
  <p class="sub">A coding agent (Claude Code, Codex, …) is asking for access to the LLM gateway on your behalf. Confirm the code it showed you.</p>
  <label for="code">Code</label>
  <input id="code" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX" maxlength="9">
  <div id="preview" class="preview" hidden></div>
  <label for="token">Admin token <span class="hint">(only if you are not signed in with SSO)</span></label>
  <input id="token" type="password" autocomplete="off" placeholder="gadm_… or gses_…">
  ${login}
  <div class="row">
    <button id="deny">Deny</button>
    <button id="approve" class="primary">Approve</button>
  </div>
  <div id="msg" class="msg" hidden></div>
</div></main>
<script nonce="${nonce}">
(function(){
  var $=function(id){return document.getElementById(id)};
  var code=$('code'),token=$('token'),msg=$('msg'),preview=$('preview'),approve=$('approve'),deny=$('deny');
  var q=new URLSearchParams(location.search).get('user_code');
  if(q){code.value=q;}
  function headers(){var h={'content-type':'application/json','accept':'application/json'};var t=token.value.trim();if(t)h['authorization']='Bearer '+t;return h;}
  function say(text,cls){msg.textContent=text;msg.className='msg '+cls;msg.hidden=false;}
  function busy(b){approve.disabled=b;deny.disabled=b;}
  var previewTimer;
  function loadPreview(){
    var c=code.value.trim();if(c.replace(/[^A-Za-z0-9]/g,'').length!==8){preview.hidden=true;return;}
    fetch('/oauth/device/preview?user_code='+encodeURIComponent(c),{headers:headers(),credentials:'same-origin'})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,status:r.status,j:j};});})
      .then(function(res){
        if(!res.ok){preview.hidden=true;if(res.status===401){say('Sign in with SSO or paste an admin token to look up this code.','err');}else{say('Unknown or expired code.','err');}return;}
        msg.hidden=true;preview.hidden=false;preview.textContent='';
        var b=document.createElement('b');b.textContent=res.j.clientName+' ('+res.j.clientId+')';
        preview.appendChild(b);
        preview.appendChild(document.createTextNode(' wants access to workspace '+(res.j.workspaceName||res.j.workspaceId)+(res.j.orgName?' in '+res.j.orgName:'')+'. Expires '+new Date(res.j.expiresAt).toLocaleTimeString()+'.'));
      }).catch(function(){preview.hidden=true;});
  }
  code.addEventListener('input',function(){clearTimeout(previewTimer);previewTimer=setTimeout(loadPreview,250);});
  token.addEventListener('change',loadPreview);
  function decide(path,label){
    var c=code.value.trim();if(!c){say('Enter the code shown by the agent.','err');return;}
    busy(true);
    fetch(path,{method:'POST',headers:headers(),credentials:'same-origin',body:JSON.stringify({user_code:c})})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,status:r.status,j:j};});})
      .then(function(res){
        if(res.ok){say(label+' — you can close this page and return to the agent.','ok');return;}
        if(res.status===401){say('Not signed in: sign in with SSO or paste an admin token.','err');return;}
        say('Could not '+label.toLowerCase()+': '+(res.j.error_description||res.j.error||('HTTP '+res.status)),'err');
      }).catch(function(e){say('Network error: '+e,'err');}).then(function(){busy(false);});
  }
  approve.addEventListener('click',function(){decide('/oauth/device/authorize','Approved');});
  deny.addEventListener('click',function(){decide('/oauth/device/deny','Denied');});
  if(q){loadPreview();}
})();
</script></body></html>`;
}
