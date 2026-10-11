"""
Scenaria Python client — zero dependencies (stdlib only).

Talks to `scenaria serve` (or `scenaria ui`) over HTTP, so any Python agent stack
can use Scenaria: OpenAI / Azure OpenAI / Mistral / Ollama / vLLM function calling,
Anthropic tool use, Gemini, LangChain, LlamaIndex, CrewAI, AutoGen, custom loops.

    from scenaria_client import ScenariaClient
    sc = ScenariaClient("http://127.0.0.1:4477", agent="my-agent", model="gpt-5")
    sc.start_mission("Quarterly report", goal="Draft the Q3 report for the board")
    sc.decide("Which data source?", ["CRM export", "Data warehouse"], chosen="Data warehouse",
              rationale="Single source of truth", confidence=0.8)
    sc.checkpoint("Revenue section drafted", outputs=["`report/revenue.md` written"])

Function calling (OpenAI-compatible):

    tools = sc.tool_schemas("openai")          # pass to chat.completions(tools=...)
    ...
    for call in message.tool_calls:
        result_text = sc.run_tool_call(call.function.name, call.function.arguments)
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from typing import Any, Iterable, Optional, Union

__all__ = ["ScenariaClient", "ScenariaError"]
__version__ = "0.3.0"


class ScenariaError(RuntimeError):
    pass


class ScenariaClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        agent: Optional[str] = None,
        model: Optional[str] = None,
        user: Optional[str] = None,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = (base_url or os.environ.get("SCENARIA_URL") or "http://127.0.0.1:4477").rstrip("/")
        self.token = token or os.environ.get("SCENARIA_TOKEN")
        self.agent = agent or os.environ.get("SCENARIA_AGENT") or "python-client"
        self.model = model or os.environ.get("SCENARIA_MODEL")
        self.user = user or os.environ.get("SCENARIA_USER")
        self.timeout = timeout

    # ------------------------------------------------------------------ transport
    def _request(self, method: str, path: str, body: Any = None) -> Any:
        headers = {"content-type": "application/json", "x-scenaria": "1", "x-scenaria-agent": self.agent}
        if self.model:
            headers["x-scenaria-model"] = self.model
        if self.user:
            headers["x-scenaria-user"] = self.user
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode("utf-8")).get("error")
            except Exception:  # noqa: BLE001
                detail = str(e)
            raise ScenariaError(f"HTTP {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            raise ScenariaError(f"Scenaria server not reachable at {self.base_url} ({e.reason}). Start it with: scenaria serve") from None
        except (socket.timeout, TimeoutError):
            raise ScenariaError(f"Scenaria server at {self.base_url} did not answer within {self.timeout}s") from None

    # ------------------------------------------------------------------ generic
    def health(self) -> dict:
        return self._request("GET", "/api/v1/health")

    def tool_schemas(self, fmt: str = "openai") -> list:
        """Tool definitions for: openai | openai-responses | anthropic | gemini | json | mcp."""
        return self._request("GET", f"/api/v1/tools?format={fmt}")

    def call(self, tool_name: str, args: Optional[dict] = None, **kwargs: Any) -> dict:
        """Run a tool. Returns {"ok": True, "text": <for the LLM>, "data": <structured>}."""
        payload = {**(args or {}), **kwargs}
        res = self._request("POST", f"/api/v1/tools/{tool_name}", payload)
        if not res.get("ok"):
            raise ScenariaError(res.get("error", "unknown error"))
        return res

    def run_tool_call(self, name: str, arguments: Union[str, dict, None]) -> str:
        """Execute an LLM tool call and return the text to send back as the tool result.
        Never raises: problems come back as "ERROR: …" so the model can correct itself."""
        try:
            args = json.loads(arguments) if isinstance(arguments, str) and arguments.strip() else (arguments or {})
            if not isinstance(args, dict):
                return "ERROR: tool arguments must be a JSON object"
            return self.call(name, args)["text"]
        except json.JSONDecodeError as e:
            return f"ERROR: arguments are not valid JSON ({e.msg})"
        except ScenariaError as e:
            return f"ERROR: {e}"

    def export(self) -> dict:
        return self._request("GET", "/api/v1/export")

    # ------------------------------------------------------------------ convenience
    def status(self) -> dict:
        return self.call("scenaria_status")["data"]

    def start_mission(self, title: Optional[str] = None, goal: Optional[str] = None, brief: Optional[str] = None, project_goal: Optional[str] = None) -> dict:
        """Start a task in the project's single tree (or set the main goal with project_goal)."""
        return self.call("scenaria_start_mission", _clean(title=title, goal=goal, brief=brief, projectGoal=project_goal))["data"]

    start_task = start_mission

    def decide(
        self,
        question: str,
        options: Iterable[Union[str, dict]],
        chosen: Union[str, int, None] = None,
        rationale: Optional[str] = None,
        assumptions: Optional[list] = None,
        confidence: Optional[float] = None,
        context: Optional[str] = None,
        serves_goal: Optional[str] = None,
        expected_outcome: Optional[str] = None,
    ) -> dict:
        return self.call(
            "scenaria_decide",
            _clean(question=question, options=list(options), chosen=chosen, rationale=rationale, assumptions=assumptions, confidence=confidence,
                   context=context, servesGoal=serves_goal, expectedOutcome=expected_outcome),
        )["data"]

    def checkpoint(
        self,
        title: str,
        outputs: Optional[list] = None,
        facts: Optional[list] = None,
        open_questions: Optional[list] = None,
        irreversible: Optional[list] = None,
        task_done: Optional[bool] = None,
        summary: Optional[str] = None,
    ) -> Optional[dict]:
        return self.call(
            "scenaria_checkpoint",
            _clean(title=title, outputs=outputs, facts=facts, openQuestions=open_questions, irreversible=irreversible, taskDone=task_done, summary=summary),
        )["data"]

    def recall(self, query: str, limit: Optional[int] = None) -> list:
        return self.call("scenaria_recall", _clean(query=query, limit=limit))["data"]

    def project_health(self) -> dict:
        """Deterministic quality check of the whole decision tree (no LLM)."""
        return self.call("scenaria_health")["data"]

    def context(self, node_id: Optional[str] = None) -> str:
        return self.call("scenaria_context", _clean(id=node_id))["data"]["markdown"]

    def rewind(self, node_id: str, lesson: Optional[str] = None, restore_files: bool = True) -> dict:
        return self.call("scenaria_rewind", _clean(id=node_id, lesson=lesson, restoreFiles=restore_files))["data"]

    def fork(self, decision_id: str, option: Union[str, int], lesson: Optional[str] = None) -> dict:
        return self.call("scenaria_fork", _clean(decisionId=decision_id, option=option, lesson=lesson))["data"]

    def verify(self, node_id: str, status: Optional[str] = None, notes: Optional[str] = None) -> dict:
        return self.call("scenaria_verify", _clean(id=node_id, status=status, notes=notes))["data"]

    def last_good(self, node_id: Optional[str] = None) -> Optional[dict]:
        return self.call("scenaria_last_good", _clean(id=node_id))["data"]


def _clean(**kw: Any) -> dict:
    return {k: v for k, v in kw.items() if v is not None}
