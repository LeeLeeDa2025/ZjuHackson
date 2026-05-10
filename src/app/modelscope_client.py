from __future__ import annotations

import asyncio

import httpx

from .config import ModelScopeSettings


class ModelScopeNotConfiguredError(RuntimeError):
    pass


class ModelScopeClient:
    def __init__(self, settings: ModelScopeSettings) -> None:
        self.settings = settings

    async def chat(self, messages: list[dict[str, str]], json_mode: bool = True) -> str:
        if not self.settings.api_key:
            raise ModelScopeNotConfiguredError(
                "ModelScope API key is not configured. Set MODELSCOPE_API_KEY or MODELSCOPE_ACCESS_TOKEN."
            )

        payload: dict = {
            "model": self.settings.model,
            "messages": messages,
            "temperature": 0.1,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
        }

        last_error: Exception | None = None
        for attempt in range(self.settings.max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=self.settings.timeout_seconds) as client:
                    response = await client.post(f"{self.settings.api_base}/chat/completions", json=payload, headers=headers)
            except httpx.TimeoutException as exc:
                last_error = RuntimeError(f"ModelScope request timed out after {self.settings.timeout_seconds:g}s")
            except httpx.HTTPError as exc:
                last_error = RuntimeError(f"ModelScope request failed: {exc}")
            else:
                if response.status_code < 400:
                    data = response.json()
                    try:
                        return data["choices"][0]["message"]["content"]
                    except (KeyError, IndexError, TypeError) as exc:
                        raise RuntimeError("ModelScope response did not contain chat content.") from exc

                detail = response.text[:600]
                last_error = RuntimeError(f"ModelScope request failed with HTTP {response.status_code}: {detail}")
                if response.status_code not in {408, 429, 500, 502, 503, 504}:
                    break

            if attempt < self.settings.max_retries:
                await asyncio.sleep(1.2 * (attempt + 1))

        raise last_error or RuntimeError("ModelScope request failed.")
