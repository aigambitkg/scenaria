"""
Minimal agent loop with Scenaria tools for ANY OpenAI-compatible endpoint:
OpenAI, Azure OpenAI, Mistral, Groq, Together, OpenRouter, vLLM, LM Studio, Ollama …

    pip install openai
    scenaria serve                       # in the project folder (another terminal)
    export OPENAI_BASE_URL=http://localhost:11434/v1  OPENAI_API_KEY=ollama  MODEL=llama3.3   # e.g. Ollama
    python examples/openai_compatible_agent.py "Plan a 3-step onboarding email sequence"
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "clients", "python"))

from openai import OpenAI  # noqa: E402
from scenaria_client import ScenariaClient  # noqa: E402

MODEL = os.environ.get("MODEL", "gpt-5")
client = OpenAI()  # reads OPENAI_BASE_URL / OPENAI_API_KEY
sc = ScenariaClient(agent="openai-compatible-agent", model=MODEL)

SYSTEM = (
    "You are a careful assistant. Use the scenaria_* tools: start a mission for the task, "
    "record every decision between approaches with scenaria_decide (all options, chosen, rationale, confidence), "
    "and save progress with scenaria_checkpoint after each step. If you notice a mistake, use scenaria_rewind."
)

messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": " ".join(sys.argv[1:]) or "Plan a small product launch."}]
tools = sc.tool_schemas("openai")

for _ in range(12):
    reply = client.chat.completions.create(model=MODEL, messages=messages, tools=tools)
    msg = reply.choices[0].message
    messages.append(msg.model_dump(exclude_none=True))
    if not msg.tool_calls:
        print(msg.content)
        break
    for call in msg.tool_calls:
        result = sc.run_tool_call(call.function.name, call.function.arguments)
        print(f"· {call.function.name} → {result.splitlines()[0]}")
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})

print("\nOpen the map: scenaria ui")
