# CopilotProxyServer

A standalone proxy server that exposes GitHub Copilot's LLM capabilities through multiple standard API formats. Supports **Chat Completions**, **Messages**, and **Gemini-style** compatible endpoints — allowing you to use Copilot-provided models with your existing tools and SDKs.

Run on any server (including headless machines without GUI) via Docker — no VS Code required.

## Features

- **Multi-format API support** — Chat Completions (`/v1/chat/completions`), Messages (`/v1/messages`), and Gemini-style (`/v1/models/{model}:...`) endpoints
- **Automatic format translation** — Messages and Gemini-style requests are transparently converted to the Copilot wire format
- **Streaming support** — Full SSE streaming for all API formats
- **Token management** — Automatic Copilot token refresh, no manual intervention needed
- **Usage tracking** — Built-in SQLite database records every model request: outcome (including failures and cancellations), latency, first token, and token usage per model
- **Dashboard** — Analytics dashboard with llm-proxy's design and metrics, behind a sign-in page
- **Rate limiting** — Optional per-request rate limiting
- **API key authentication** — Optional API key protection with timing-safe comparison
- **Docker ready** — Multi-stage Dockerfile with health checks

## Prerequisites

- **Node.js** >= 22.5.0
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

**Use the pre-built image (recommended):**

```bash
docker run -d \
  --name copilot-proxy \
  -p 6628:6628 \
  -e GITHUB_TOKEN=ghu_xxxx \
  -e API_KEY=your-api-key \
  -v copilot-data:/app/data \
  ghcr.io/yeaft/copilot-proxy-server:latest
```

**Or build from source:**

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
| `DASHBOARD_USER` | `admin` | Dashboard sign-in username |
| `DASHBOARD_PASS` | `admin` | Dashboard sign-in password (change it if the port is reachable from other machines) |
| `DATA_DIR` | `~/.local/share/copilot-proxy` | Directory for storing tokens and usage database |

## Authentication

When `API_KEY` is set, all API endpoints (except health check `GET /`) require authentication:

```bash
# Via Authorization header
curl -H "Authorization: Bearer YOUR_API_KEY" ...

# Via x-api-key header
curl -H "x-api-key: YOUR_API_KEY" ...

# Via Google SDK-style header (Gemini REST methods only)
curl -H "x-goog-api-key: YOUR_API_KEY" ...
```

If `API_KEY` is not set, no client authentication is required (suitable for local or internal network use).

## API Endpoints

For every model request (Copilot and direct DeepSeek), the proxy waits up to 120 seconds for upstream HTTP response headers. If no headers arrive, it cancels that attempt and returns HTTP `504` with error code `upstream_headers_timeout`. The proxy does not retry; clients decide whether to retry. Once upstream headers arrive, this timeout no longer applies to the response body or SSE stream.

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

### Chat Completions

```
POST /v1/chat/completions
POST /chat/completions
```

Standard Chat Completions endpoint (latest OpenAI spec). Models that Copilot serves on `/chat/completions` (Gemini, GPT-4.x, …) are forwarded as-is. Models that Copilot serves only on `/responses` (GPT-5.x/6.x, Codex, Grok, MAI-1.1) are bridged transparently, so clients keep using the Chat Completions contract for every model.

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

**Supported parameters:** `model`, `messages` (`system`/`developer`/`user`/`assistant`/`tool`; text, `image_url`, `file` parts), `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `stream`, `stream_options.include_usage`, `tools` (`function` and `custom`), `tool_choice` (incl. named and `allowed_tools`), `parallel_tool_calls`, `response_format` (`text`/`json_object`/`json_schema`), `reasoning_effort` (`none` … `max`), `verbosity`, `logprobs`, `top_logprobs`, `prompt_cache_key`, `prompt_cache_options`, `prompt_cache_retention`, `safety_identifier`, `metadata`, `user`, `seed`, `n`, `frequency_penalty`, `presence_penalty`

#### Responses-only models (GPT-5.x/6.x, Codex, Grok, MAI-1.1)

These are bridged to Copilot's `/responses` endpoint and back:

- **Tool calling** — function and custom (grammar) tools, parallel calls, tool results, and `finish_reason: "tool_calls"`, streamed with the standard `index`/`id`/`arguments` deltas.
- **Reasoning** — the reasoning summary is returned as `reasoning_text`. The reasoning state is returned as `reasoning_opaque` (Copilot's Chat Completions extension, the same fields Gemini uses). Echo `reasoning_opaque` back on the assistant message so the model keeps its reasoning across tool-calling turns. Values from other models are ignored, so switching models mid-conversation is safe.
- **Finish reasons and usage** — truncation returns `finish_reason: "length"` and content filtering returns `"content_filter"`. Usage includes `cached_tokens`, `cache_write_tokens` and `reasoning_tokens`. With `stream_options.include_usage`, usage arrives in a final chunk with empty `choices`. Without it, usage is attached to the finish chunk. Streams end with `data: [DONE]`. A stream that fails upstream ends with an `{"error": …}` chunk instead.
- **Rejected with HTTP 400** (the Responses API cannot honour them): `n` > 1, audio input/output, `web_search_options`, `moderation`, and the deprecated `functions`/`function_call`.
- **Ignored** (no Responses equivalent; best-effort hints): `stop`, `seed`, `logit_bias`, `frequency_penalty`, `presence_penalty`, `prediction`, `service_tier`, `store`.

---

### Messages

```
POST /v1/messages
```

Messages-style endpoint. Requests are automatically translated to the Copilot wire format and responses are translated back.

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

### Token Counting (Messages)

```
POST /v1/messages/count_tokens
```

Estimate the token count for a Messages-style request.

---

### Gemini-style generateContent

```
POST /v1/models/{model}:generateContent
```

Gemini-style content generation endpoint (non-streaming). Use the stable `/v1` API for new integrations; `/v1beta` remains available for all three Gemini methods as a compatibility alias. Use a model available to your Copilot account (see `GET /v1/models`). The proxy translates these requests to Copilot Chat Completions; it does not forward to Google's Gemini API. Function declarations support `parametersJsonSchema` and legacy `parameters` (use one or the other). Google-only features (such as Search grounding and Files/Live APIs) are not supported.

**Example:**

```bash
curl -X POST http://localhost:6628/v1/models/gemini-4-carbon:generateContent \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: YOUR_API_KEY" \
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

**Translated parameters:** `contents`, `systemInstruction`, `generationConfig` (`temperature`, `topP`, `maxOutputTokens`, `stopSequences`, `candidateCount`), function declarations, and basic function calling modes. For Gemini 4 and Gemini 3.8 Flash, `generationConfig.thinkingConfig.thinkingLevel` maps to Copilot `reasoning_effort` (including `XHIGH` for Neon and Hydrogen). Availability depends on your Copilot account. Thinking budgets and thought summaries are not translated. The upstream model may limit some of these parameters.

**Images in function results:** `functionResponse.parts[].inlineData` can carry canonical base64 PNG, JPEG, GIF, or WebP images. The proxy preserves `functionResponse.response` as the tool result and sends structurally checked attachments as user image input after the tool results. Each candidate is limited to 10 MiB of decoded bytes, with a 32 MiB validation budget per request (length-eligible candidates are charged even when invalid). The proxy checks container framing and required image structures, but does not decompress images or verify pixel data. Invalid and over-budget attachments and `fileData` references are ignored; the proxy does not fetch images. Image support depends on the upstream model. The local `countTokens` estimate adds 256 tokens per translated image, regardless of its base64 length; it does not predict upstream image billing.

**Google Gen AI JavaScript SDK (`@google/genai`):**

```js
import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({
  apiKey: process.env.PROXY_API_KEY, // Your proxy's API_KEY, not a Google key.
  apiVersion: "v1",
  httpOptions: { baseUrl: "http://localhost:6628" },
});
const result = await client.models.generateContent({
  model: "gemini-4-carbon",
  contents: "Hello!",
});
console.log(result.text);
```

Set `baseUrl` to the proxy URL without appending `/v1`. SDK versions that already default to stable `v1` can omit `apiVersion`. For model discovery, `GET /v1/models` returns the OpenAI-style catalog; the Gemini model-list API is not implemented.

---

### Gemini-style streamGenerateContent

```
POST /v1/models/{model}:streamGenerateContent?alt=sse
```

Streaming version of generateContent, returns SSE format.

---

### Gemini-style countTokens

```
POST /v1/models/{model}:countTokens
```

Estimate token count locally for a Gemini-style request. This is not Google’s tokenizer result.

---

### Dashboard

```
GET /dashboard
```

Analytics dashboard with the same design and metrics as llm-proxy. Sign in with `DASHBOARD_USER` / `DASHBOARD_PASS`; the session lasts 30 days.

Features:
- Requests, success rate, latency (P50/P95/P99/average), time to first token, output speed, and tokens, with per-model comparison, trends, and a sortable table
- Outcomes (completed, HTTP errors, timeouts, stream errors, incomplete streams, cancellations, rejected requests) and endpoints
- Token usage and input cache hit rate
- 1H to 30D or a custom range up to 31 days, model filter, bucket size, live refresh, light/dark theme

`GET /dashboard/api/metrics?from=<ms>&to=<ms>[&model=<id>][&step=<ms>]` returns the report as JSON, in the same shape as llm-proxy's `/api/metrics`. Reports are built on a worker thread, so large ranges do not stall proxied requests.

Only metadata is stored, never prompts or responses. Rows from before outcome tracking count as completed. Output speed excludes reasoning tokens and needs rows that record them, so it has no history from earlier versions.

## Integration Examples

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:6628
export ANTHROPIC_AUTH_TOKEN=YOUR_API_KEY
export ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### Chat Completions SDK (Python)

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

### Chat Completions SDK (Node.js)

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

### Messages SDK (Python)

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

### Gemini-style (curl)

```bash
curl -X POST http://localhost:6628/v1/models/gemini-4-carbon:generateContent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]
  }'
```

## Available Models

Models are passed directly to the Copilot backend. Use `GET /v1/models` to see all available models for your subscription. The available models depend on your GitHub Copilot plan.

## Architecture

```
Client Request (Chat Completions / Messages / Gemini-style format)
    │
    ▼
CopilotProxyServer (Hono, port 6628)
    │  ← API Key authentication
    │  ← Rate limiting
    │  ← Usage logging (SQLite)
    │
    ├── Chat Completions format  → Forward directly
    ├── Messages format          → Translate → Response back to Messages format
    └── Gemini-style format      → Translate → Response back to Gemini-style format
    │
    ▼
GitHub Copilot API
```

## Token Lifecycle

1. **GitHub OAuth Token** (`ghu_...`) — Obtained via Device Flow. Long-lived, valid until manually revoked.
2. **Copilot Internal Token** — Short-lived, automatically refreshed by the server based on the `refresh_in` field.

No manual token management is needed after initial setup.

## License

MIT
