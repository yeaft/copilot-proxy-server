# CopilotProxyServer

A standalone proxy server that exposes GitHub Copilot's LLM capabilities through standard API formats. Supports **OpenAI**, **Anthropic**, and **Google Gemini** compatible endpoints.

Run on any server (including headless machines without GUI) via Docker — no VS Code required.

## Features

- **Multi-format API support** — OpenAI, Anthropic Messages, and Gemini API formats
- **Automatic format translation** — Anthropic/Gemini requests are transparently converted to/from OpenAI format
- **Streaming support** — Full SSE streaming for all three API formats
- **Token management** — Automatic Copilot token refresh, no manual intervention needed
- **Usage tracking** — Built-in SQLite database tracks requests, tokens, and usage per IP/model
- **Dashboard** — Web-based usage analytics dashboard with charts
- **Rate limiting** — Optional per-request rate limiting
- **API key authentication** — Optional API key protection with timing-safe comparison
- **Docker ready** — Multi-stage Dockerfile with health checks

## Prerequisites

- **Node.js** >= 22
- A **GitHub account** with an active **GitHub Copilot** subscription

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Authenticate with GitHub

You need a GitHub OAuth token obtained via Device Flow (starts with `ghu_`).

> **Important**: Personal Access Tokens (PAT) created from GitHub Settings **cannot** be used. Only tokens obtained through the OAuth Device Flow have Copilot API access.

**Option A: Device Flow (recommended)**

```bash
npm run auth
```

This will display a device code. Open https://github.com/login/device in your browser and enter the code to authorize. The token will be saved automatically to `~/.local/share/copilot-proxy/github_token`.

**Option B: Environment variable**

If you already have a Device Flow token:

```bash
export GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in your configuration. See [Environment Variables](#environment-variables) for details.

### 4. Run

```bash
# Development mode (hot reload)
npm run dev

# Production mode
npm run build && npm start
```

### 5. Docker

```bash
docker build -t copilot-proxy .
docker run -d \
  --name copilot-proxy \
  -p 6628:6628 \
  -e GITHUB_TOKEN=ghu_xxxx \
  -e API_KEY=your-api-key \
  -v copilot-data:/app/data \
  copilot-proxy
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub OAuth token (obtained via Device Flow, starts with `ghu_`) |
| `API_KEY` | — | API key for client authentication. If set, all API endpoints require it |
| `ACCOUNT_TYPE` | `individual` | Copilot account type: `individual`, `business`, or `enterprise` |
| `PORT` | `6628` | Server listen port |
| `VERBOSE` | `false` | Enable verbose debug logging |
| `VSCODE_VERSION` | `1.109.2` | VS Code version to emulate in request headers |
| `RATE_LIMIT_SECONDS` | — | Minimum interval between requests (seconds) |
| `DASHBOARD_USER` | `admin` | Dashboard Basic Auth username |
| `DASHBOARD_PASS` | `admin` | Dashboard Basic Auth password |
| `DATA_DIR` | `~/.local/share/copilot-proxy` | Directory for storing tokens and usage database |

## Authentication

When `API_KEY` is set, all API endpoints (except health check `GET /`) require authentication:

```bash
# Via Authorization header
curl -H "Authorization: Bearer YOUR_API_KEY" ...

# Via x-api-key header
curl -H "x-api-key: YOUR_API_KEY" ...
```

If `API_KEY` is not set, no client authentication is required (suitable for local or internal network use).

## API Endpoints

### Health Check

```
GET /
```

```json
{
  "status": "ok",
  "service": "CopilotProxyServer",
  "version": "1.0.0"
}
```

---

### Model List

```
GET /v1/models
```

Returns all available Copilot models. Available models depend on your Copilot subscription.

---

### OpenAI Chat Completions

```
POST /v1/chat/completions
POST /chat/completions
```

Fully compatible with the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat). Requests are forwarded directly to the Copilot backend.

**Example (non-streaming):**

```bash
curl -X POST http://localhost:6628/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "max_tokens": 100
  }'
```

**Example (streaming):**

```bash
curl -X POST http://localhost:6628/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**Supported parameters:** `model`, `messages`, `temperature`, `top_p`, `max_tokens`, `stop`, `stream`, `tools`, `tool_choice`, `response_format`, `seed`, `n`, `frequency_penalty`, `presence_penalty`

---

### Anthropic Messages

```
POST /v1/messages
```

Compatible with the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages). Requests are automatically translated to OpenAI format, sent to Copilot, and responses are translated back to Anthropic format.

**Example (non-streaming):**

```bash
curl -X POST http://localhost:6628/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

**Example (streaming):**

```bash
curl -X POST http://localhost:6628/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 200,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Explain quicksort briefly."}
    ]
  }'
```

**Supported parameters:** `model`, `messages`, `max_tokens`, `system`, `temperature`, `top_p`, `top_k`, `stream`, `stop_sequences`, `tools`, `tool_choice`, `thinking`, `metadata`

**Supported content types:** Text, Image (base64), Tool Use, Tool Result, Thinking blocks

---

### Anthropic Token Counting

```
POST /v1/messages/count_tokens
```

Estimate the token count for a request.

---

### Gemini generateContent

```
POST /v1beta/models/{model}:generateContent
```

Compatible with the [Google Gemini API](https://ai.google.dev/api/generate-content). Non-streaming.

**Example:**

```bash
curl -X POST http://localhost:6628/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Hello!"}]
      }
    ],
    "generationConfig": {
      "maxOutputTokens": 100,
      "temperature": 0.7
    }
  }'
```

**Supported parameters:** `contents`, `systemInstruction`, `generationConfig` (`temperature`, `topP`, `topK`, `maxOutputTokens`, `stopSequences`), `tools` (function calling), `toolConfig`

---

### Gemini streamGenerateContent

```
POST /v1beta/models/{model}:streamGenerateContent
```

Streaming version of generateContent, returns SSE format.

---

### Gemini countTokens

```
POST /v1beta/models/{model}:countTokens
```

Estimate token count for a Gemini-format request.

---

### Dashboard

```
GET /dashboard
```

Web-based usage analytics dashboard. Protected by Basic Auth (configure via `DASHBOARD_USER` and `DASHBOARD_PASS`).

Features:
- Total requests, tokens, and active IPs overview
- Time series charts for usage trends
- Top IPs and models by token usage
- Filterable by time period (1h, 6h, 24h, 7d, 30d)

## Integration Examples

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:6628
export ANTHROPIC_AUTH_TOKEN=YOUR_API_KEY
export ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:6628/v1",
    api_key="YOUR_API_KEY",
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### OpenAI SDK (Node.js)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:6628/v1",
  apiKey: "YOUR_API_KEY",
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
```

### Anthropic SDK (Python)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:6628",
    api_key="YOUR_API_KEY",
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

### curl (Gemini format)

```bash
curl -X POST http://localhost:6628/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]
  }'
```

## Available Models

Models are passed directly to the Copilot backend. Use `GET /v1/models` to see all available models for your subscription. Common models include:

- `gpt-4o` / `gpt-4o-mini`
- `claude-sonnet-4-20250514` / `claude-3.5-sonnet`
- `gemini-2.0-flash`
- `o1` / `o3-mini`

## Architecture

```
Client Request (OpenAI / Anthropic / Gemini format)
    │
    ▼
CopilotProxyServer (Hono, port 6628)
    │  ← API Key authentication
    │  ← Rate limiting
    │  ← Usage logging (SQLite)
    │
    ├── OpenAI format    → Forward directly
    ├── Anthropic format → Translate to OpenAI → Response back to Anthropic
    └── Gemini format    → Translate to OpenAI → Response back to Gemini
    │
    ▼
GitHub Copilot API (api.githubcopilot.com)
```

## Token Lifecycle

1. **GitHub OAuth Token** (`ghu_...`) — Obtained via Device Flow. Long-lived, valid until manually revoked.
2. **Copilot Internal Token** — Short-lived, automatically obtained from `api.github.com/copilot_internal/v2/token`. The server refreshes it automatically based on the `refresh_in` field.

No manual token management is needed after initial setup.

## License

MIT
