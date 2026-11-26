# Sign-in with Cloudflare Access

The site has no sign-in page of its own. Cloudflare Access sits in front of the domain and signs people in
(Google, GitHub, one-time PIN by email, whatever your Zero Trust account offers). Every request it lets through
carries a signed JWT (`Cf-Access-Jwt-Assertion` header, `CF_Authorization` cookie). The app verifies that JWT
(RS256 signature against your team's public keys, issuer, audience, expiry) and treats its email as the signed-in
admin.

A request that did not come through Access (for example straight to `http://<container-ip>:3000` on the LAN)
has no valid JWT, so it is **not** signed in: going around Cloudflare never gets anyone in. With *Public
dashboard* on it still shows the public status, like for any visitor.

`ADMIN_PASSWORD` remains an API token for scripts (`Authorization: Bearer ...`). There is no password form.

## 1. Create the Access application

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an application → Self-hosted**.

- **Application domain:** your status domain, e.g. `upt.example.com`, path empty (the whole site).
- **Policy:** *Allow*, include the emails (or group) that may use the dashboard.
- Save, open the application again, and copy the **Application Audience (AUD) Tag** from its *Overview*.

Your **team domain** is shown under **Zero Trust → Settings → Custom pages** (or in the browser address bar
while signing in): `<team>.cloudflareaccess.com`.

## 2. Let the machines through (Bypass)

Some callers can't sign in to Access: the connector agents, the other status server, uptime checks, and Claude's
connector. Add one more **Self-hosted** application with a **Bypass → Everyone** policy, covering these paths of
the same domain (an application can list several):

| Path | Who calls it |
|---|---|
| `api/agent/` | the connector agents' reports (they use their own `AGENT_TOKENS`) |
| `api/health` | health checks, um-update |
| `api/peer-status` | other status servers (`PEER_TOKEN`) |
| `mcp` | Claude's connector (OAuth access token, see [Claude connector](CONFIGURATION.md#claude-connector-mcp)) |
| `oauth/token`, `oauth/register` | Claude's connector |
| `.well-known/` | Claude's connector (OAuth discovery) |

Do **not** bypass `oauth/authorize`: that page must go through Access, it is how the app knows who approves a
connection. Access matches the most specific path, so these bypasses win over the application for the whole
domain.

If agents reach the app on its LAN address (not through Cloudflare), they don't need the bypass for
`api/agent/`, but adding it does no harm: those endpoints check the agent token themselves.

## 3. Configure the app

```bash
CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
CF_ACCESS_AUD=4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2
PUBLIC_URL=https://upt.example.com
# Optional second check, on top of the Access policy:
#ADMIN_EMAILS=you@gmail.com
```

Restart. The startup log says `Sign-in: Cloudflare Access (https://yourteam.cloudflareaccess.com)`. Several AUD
tags can be listed comma-separated (e.g. one Access application per hostname).

**Log out** in the dashboard goes to `/cdn-cgi/access/logout`, which ends the Access session.

## Bots and Claude

Cloudflare's **Block AI Bots** and **Bot Fight Mode** block Claude's connector (it calls `/mcp`, `/oauth/token`
and the discovery URLs from Anthropic's servers). Turn them off for the zone, or add **IP Access rules** (Security →
WAF → Tools) that *Allow* Anthropic's outbound ranges **160.79.104.0/21** and **153.61.208.0/20**.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Dashboard says "Sign-in is not set up" | `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is missing. |
| Signed in at Cloudflare but the dashboard stays locked | Wrong AUD tag (copy it again from the application's Overview), the team domain doesn't match the JWT's issuer, your email isn't in `ADMIN_EMAILS` (when set; the log says so), or the request didn't go through Access. |
| Log: `Could not load Cloudflare Access keys` | The app can't reach `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. It needs outbound HTTPS. |
| Agents stopped reporting after turning on Access | Add the `api/agent/` bypass (step 2). |
| Claude: "couldn't connect" / 403 from Cloudflare | Missing bypass for `mcp`, `oauth/token`, `oauth/register` or `.well-known/`, or Bot Fight Mode / Block AI Bots (see above). |
| The Approve page says it didn't get an Access sign-in | `oauth/authorize` is bypassed (or not covered by the Access application). |
