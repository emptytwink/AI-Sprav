from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    def load_dotenv() -> bool:
        return False


class OllamaError(RuntimeError):
    pass


class OllamaClient:
    def __init__(self) -> None:
        load_dotenv()
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
        self.model = os.getenv("OLLAMA_MODEL", "qwen3:8b")
        self.timeout = int(os.getenv("AI_OLLAMA_TIMEOUT") or os.getenv("OLLAMA_TIMEOUT_SECONDS", "1200"))
        self.num_predict = int(os.getenv("AI_NUM_PREDICT", "8192"))

    def chat_json(self, system_prompt: str, user_prompt: str, debug_dir: Path | None = None) -> Dict[str, Any]:
        if requests is None:
            raise OllamaError("Не установлен пакет requests. Установите зависимости из requirements.txt.")

        url = f"{self.base_url}/api/chat"
        full_user_prompt = "/no_think\n" + user_prompt
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": full_user_prompt},
            ],
            "stream": False,
            "format": "json",
            "think": False,
            "options": {
                "temperature": 0,
                "num_predict": self.num_predict,
            },
        }

        started = time.monotonic()
        print(
            "[AI/Ollama]",
            f"url={url}",
            f"model={self.model}",
            f"prompt_chars={len(system_prompt) + len(full_user_prompt)}",
            f"timeout={self.timeout}",
            f"num_predict={self.num_predict}",
        )

        try:
            response = requests.post(url, json=payload, timeout=self.timeout)
        except requests.Timeout as exc:
            raise OllamaError(
                f"Ollama не успела ответить за {self.timeout} секунд. "
                "Увеличьте AI_OLLAMA_TIMEOUT или уменьшите объём документов."
            ) from exc
        except requests.RequestException as exc:
            raise OllamaError(
                "Не удалось подключиться к Ollama. Проверьте, что Ollama запущена "
                "и доступна по адресу OLLAMA_BASE_URL."
            ) from exc

        elapsed = time.monotonic() - started
        if response.status_code == 404:
            self._save_raw(debug_dir, response.text, "ollama_raw_response.txt")
            raise OllamaError(f"Модель Ollama не найдена: {self.model}")
        if not response.ok:
            self._save_raw(debug_dir, response.text, "ollama_raw_response.txt")
            raise OllamaError(f"Ollama вернула ошибку HTTP {response.status_code}: {response.text[:300]}")

        try:
            data = response.json()
        except ValueError as exc:
            self._save_raw(debug_dir, response.text, "ollama_raw_response.txt")
            raise OllamaError("Ollama вернула не JSON-ответ.") from exc

        self._save_raw(debug_dir, data, "ollama_raw_response.json")
        print(
            "[AI/Ollama]",
            f"elapsed={elapsed:.1f}s",
            f"done_reason={data.get('done_reason')}",
        )

        message = data.get("message") or {}
        content = message.get("content") or ""
        thinking = message.get("thinking") or ""
        if not content and thinking:
            raise OllamaError(
                "Ollama вернула thinking без финального JSON. "
                "Увеличьте AI_NUM_PREDICT или проверьте think=false."
            )
        if not content:
            raise OllamaError("Ollama вернула пустой ответ.")

        try:
            result = json.loads(content)
        except ValueError as exc:
            self._save_raw(debug_dir, content, "ollama_invalid_content.txt")
            raise OllamaError("Ответ Ollama не является валидным JSON. Сырой ответ сохранён в job-папке.") from exc

        if not isinstance(result, dict):
            raise OllamaError("Ответ Ollama должен быть JSON-объектом.")
        return result

    @staticmethod
    def _save_raw(debug_dir: Path | None, payload: Any, name: str) -> None:
        if not debug_dir:
            return
        debug_dir.mkdir(parents=True, exist_ok=True)
        path = debug_dir / name
        if isinstance(payload, (dict, list)):
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            path.write_text(str(payload), encoding="utf-8")
