# Integration examples

Scenaria is vendor-neutral. All paths below use the same 13 tools (`scenaria tools` lists them).

| You use … | Connect via | Start here |
|---|---|---|
| Claude Code | MCP + hooks (automatic capture) | `scenaria init --for claude` |
| Cursor, VS Code / Copilot, Gemini CLI, Codex | MCP | `scenaria init --for cursor,vscode,gemini,codex` |
| Windsurf, Cline, Zed, other MCP clients | MCP (global config) | `scenaria init --for windsurf` / `--for generic` prints the snippet |
| OpenAI, Azure OpenAI, Mistral, Ollama, vLLM, LM Studio, Groq, OpenRouter | Function calling + HTTP | [`openai_compatible_agent.py`](openai_compatible_agent.py) |
| Anthropic API, Gemini API | Function calling + HTTP | `scenaria tools --format anthropic` / `--format gemini` |
| LangChain, LlamaIndex, CrewAI, AutoGen, custom Python | Python client | [`../clients/python/scenaria_client.py`](../clients/python/scenaria_client.py) |
| n8n, Make, Zapier, Power Automate | HTTP | [n8n below](#n8n--make--any-http-tool) |
| Aider, Open Interpreter, shell agents | CLI | `scenaria call scenaria_checkpoint '{"title":"…"}'` |
| Agents without any tool support | File watcher | `scenaria watch` |

## HTTP API

```bash
scenaria serve                                   # local: http://127.0.0.1:4477
scenaria serve --host 0.0.0.0 --token "$TOKEN"   # team server
```

```bash
curl -s http://127.0.0.1:4477/api/v1/tools?format=openai           # schemas
curl -s -X POST http://127.0.0.1:4477/api/v1/tools/scenaria_decide \
  -H 'content-type: application/json' -H 'x-scenaria: 1' \
  -H 'x-scenaria-agent: n8n' -H 'x-scenaria-model: gpt-5' \
  -d '{"question":"Which channel?","options":["Email","Slack"],"chosen":"Slack","rationale":"Team lives in Slack","confidence":0.7}'
```

Response: `{"ok": true, "text": "<compact text for the LLM>", "data": {…node…}}`.
OpenAI-style calls can send `{"arguments": "<json string>"}` unchanged.

Headers: `x-scenaria-agent`, `x-scenaria-model`, `x-scenaria-user` (attribution), `authorization: Bearer <token>` (team server).
Without a token, every POST needs `x-scenaria: 1`, which protects against cross-site requests.

## n8n / Make / any HTTP tool

1. Run `scenaria serve --host 0.0.0.0 --token <secret>` on the machine that holds the project folder.
2. In n8n, add an **HTTP Request** node: method `POST`, URL `http://<host>:4477/api/v1/tools/scenaria_checkpoint`,
   header `Authorization: Bearer <secret>`, header `x-scenaria-agent: n8n`, JSON body `{"title": "{{$json.step}}", "outputs": ["{{$json.result}}"]}`.
3. For an AI Agent node, register the tools from `GET /api/v1/tools?format=openai` as HTTP tools.

> Note: file snapshots always capture the project folder on the machine running `scenaria serve`. Workflows that produce no files still get the full decision tree, verification and audit protocol.

## Shell agents

```bash
scenaria call scenaria_start_mission '{"title":"Refactor auth","goal":"Replace sessions with JWT"}' --agent aider --model gpt-5
scenaria call scenaria_decide '{"question":"Library?","options":["jose","jsonwebtoken"],"chosen":"jose"}'
scenaria call scenaria_rewind '{"id":"n4","lesson":"jsonwebtoken lacks EdDSA"}'
```

## Verifier for any LLM

[`../templates/rules/verifier-prompt.md`](../templates/rules/verifier-prompt.md) is a system prompt for a second model that checks the run. You can pair models, e.g. one vendor builds and another verifies.
