# Native Microsoft Loki provider

The Microsoft authentication, model catalog and proxy logic run **inside CopilotProxyServer**.
Requests go directly to the Office Loki API. No local Loki HTTP gateway or daemon is needed.
Existing Copilot behavior remains the default; enabling Loki does not rename existing models.

## Windows / PowerShell

Use the **same `DATA_DIR` and Windows user** for authentication and the running server:

```powershell
$dataDir = Join-Path $env:USERPROFILE 'data\copilot-proxy'
$env:DATA_DIR = $dataDir
$env:LOKI_ENABLED = 'true'
$env:COPILOT_ENABLED = 'false' # omit/true to keep both providers
$env:API_KEY = '<your-existing-client-api-key>'

npm run auth:loki
npm run build
npm start
```

Authentication prefers the optional Windows sign-in broker (WAM); otherwise it uses
browser PKCE. Use `npm run auth:loki -- --device-code` for headless sign-in.
Token refresh and the private MSAL cache live in `DATA_DIR/loki/auth`. No credentials
are imported from another Loki installation. Never commit or share this directory.
The server never opens an interactive Microsoft sign-in on startup: missing/expired
consent is reported on provider requests, leaving health/dashboard and other providers available.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `COPILOT_ENABLED` | `true` | Enable GitHub login and the existing Copilot provider |
| `LOKI_ENABLED` | `false` | Enable the built-in Microsoft Loki provider |
| `LOKI_ENVIRONMENT` | `prod` | Office Loki environment: `prod`, `msit`, or `sdf` |
| `DATA_DIR` | Existing platform default | Shared data directory; credentials are isolated in `loki/auth` |
| `API_KEY` | Unset | Client authentication; keep your existing key |

An authorized Microsoft organization account is required. `COPILOT_ENABLED=false`
skips all GitHub login/token setup, allowing Loki-only operation. With both providers
enabled, Copilot startup still performs the existing GitHub authentication.

## Models and protocols

`GET /v1/models` and the Playground expose models as `loki/<upstream-model-id>`.
Use an ID returned by that catalog. Dispatch happens before Copilot model heuristics,
so even names containing `codex` or `deepseek` stay on the selected Loki provider.
Chat Completions, Responses, Messages and Messages `count_tokens` are forwarded to
their matching native upstream endpoints. Unknown request fields are retained and
SSE response bytes are not translated/re-encoded. Request JSON is reserialized to
remove the `loki/` routing prefix; original request whitespace is not preserved.
Per-model protocol availability is determined by the upstream. Gemini conversion and
WebSocket Responses are **not supported** for Loki models.

Client `API_KEY` credentials/cookies/forwarding headers are not sent upstream; Microsoft
tokens are used only for the trusted Office endpoint. A 401 triggers one forced refresh
and one retry. Client disconnect cancels upstream work; the five-minute timeout is an
**idle** timeout rather than a total stream duration limit.

Usage is observed without rewriting the response. Missing/incomplete usage is marked
unknown rather than zero; Loki models are unpriced (Copilot rates are not applied).
`count_tokens` calls do not count as generation requests in the dashboard.

## Docker (only if your organization permits non-broker sign-in)

Build this source locally; a published `latest` image does not include these changes
until separately released. These commands create a **new** container name; they do not
replace an existing service. Keep your existing client key and data directory:

```powershell
$dataDir = Join-Path $env:USERPROFILE 'data\copilot-proxy'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$env:API_KEY = '<your-existing-client-api-key>'
docker build -t copilot-proxy:native-loki .

# One-off sign-in, then start the same image with the same cache mount.
docker run --rm -it `
  --mount "type=bind,source=$dataDir,target=/app/data" `
  --env DATA_DIR=/app/data `
  copilot-proxy:native-loki --loki-auth --device-code

# Run only after the sign-in above succeeds.
docker run -d `
  --name copilot-proxy-native-loki `
  --restart=always `
  --publish 127.0.0.1:6629:6628 `
  --mount "type=bind,source=$dataDir,target=/app/data" `
  --env DATA_DIR=/app/data `
  --env LOKI_ENABLED=true `
  --env COPILOT_ENABLED=false `
  --env API_KEY `
  copilot-proxy:native-loki
```

Port `6629` must be free; do not remove an existing container/data to make it work.
Windows broker-bound credentials **cannot be transplanted into Linux containers**.
If the organization requires token protection/WAM, run this integrated server natively
on Windows. Device-code/browser sign-in cannot bypass that policy. Docker restart
policies require Docker itself to be running. Never expose an unauthenticated service
or the credential data directory publicly.
