"""Conversation format shared by training and generation.

A.L.I.C.E. learns from transcripts written exactly the way she is prompted, so the format here is
the contract between what she reads while learning and what she is asked to continue in chat.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

USER_TAG = "User: "
ASSISTANT_TAG = "Alice: "
TURN_END = "\n\n"
STOP_SEQUENCES = (b"\nUser:", b"\n\n")
MAX_PROMPT_BYTES = 4096
EMPTY_REPLY = "…"


@dataclass(frozen=True)
class Turn:
    """One exchange: what the user said and the reply A.L.I.C.E. should learn from."""

    user: str
    assistant: str


def _clean(text: str) -> str:
    # Blank lines end a turn in the transcript format, so collapse them inside a message.
    lines = [line.rstrip() for line in text.strip().replace("\r\n", "\n").split("\n")]
    return "\n".join(line for line in lines if line)


def format_turn(turn: Turn) -> str:
    return f"{USER_TAG}{_clean(turn.user)}\n{ASSISTANT_TAG}{_clean(turn.assistant)}{TURN_END}"


def turns_to_corpus(turns: Iterable[Turn]) -> bytes:
    return "".join(format_turn(turn) for turn in turns if turn.user.strip() and turn.assistant.strip()).encode("utf-8")


def messages_to_turns(messages: Sequence[dict[str, str]]) -> list[Turn]:
    """Pair consecutive user/assistant messages (system messages are ignored)."""
    turns: list[Turn] = []
    pending_user: str | None = None
    for message in messages:
        role = message.get("role")
        content = message.get("content", "")
        if role == "user":
            pending_user = content
        elif role == "assistant" and pending_user is not None:
            turns.append(Turn(pending_user, content))
            pending_user = None
    return turns


def build_prompt(history: Sequence[Turn], user_message: str, max_bytes: int = MAX_PROMPT_BYTES) -> str:
    """Transcript of recent turns ending with an open ``Alice:`` line for the model to continue."""
    tail = f"{USER_TAG}{_clean(user_message)}\n{ASSISTANT_TAG}"
    pieces: list[str] = []
    budget = max_bytes - len(tail.encode("utf-8"))
    for turn in reversed(history):
        text = format_turn(turn)
        size = len(text.encode("utf-8"))
        if size > budget:
            break
        pieces.append(text)
        budget -= size
    return "".join(reversed(pieces)) + tail


def respond(
    model: object,
    history: Sequence[Turn],
    user_message: str,
    *,
    max_new_tokens: int = 240,
    temperature: float = 0.8,
    top_k: int | None = 40,
) -> str:
    """Generate A.L.I.C.E.'s reply with her own model. Untrained models produce noise; that is expected."""
    prompt = build_prompt(history, user_message)
    text = model.generate(  # type: ignore[attr-defined]
        prompt,
        max_new_tokens=max_new_tokens,
        temperature=temperature,
        top_k=top_k,
        stop=STOP_SEQUENCES,
        include_prompt=False,
    )
    reply = text.strip()
    return reply or EMPTY_REPLY
