from __future__ import annotations

import httpx

from .config import ModelScopeSettings


class ModelScopeNotConfiguredError(RuntimeError):
    pass


class ModelScopeClient:
    def __init__(self, settings: ModelScopeSettings) -> None:
        self.settings = settings

    async def chat(self, messages: list[dict[str, str]]) -> str:
        if not self.settings.api_key:
            raise ModelScopeNotConfiguredError(
                "ModelScope API key is not configured. Set MODELSCOPE_API_KEY or MODELSCOPE_ACCESS_TOKEN."
            )

        payload = {
            "model": self.settings.model,
            "messages": messages,
            "temperature": 0.1,
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=self.settings.timeout_seconds) as client:
            response = await client.post(f"{self.settings.api_base}/chat/completions", json=payload, headers=headers)

        if response.status_code >= 400:
            detail = response.text[:600]
            raise RuntimeError(f"ModelScope request failed with HTTP {response.status_code}: {detail}")

        data = response.json()
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("ModelScope response did not contain chat content.") from exc
