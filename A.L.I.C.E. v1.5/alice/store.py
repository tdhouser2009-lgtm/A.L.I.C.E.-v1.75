"""SQLite storage for the standalone app: conversations, feedback, settings, and model versions."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_text TEXT NOT NULL,
    assistant_text TEXT NOT NULL,
    rating TEXT CHECK (rating IN ('up', 'down')),
    correction TEXT,
    consent INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'chat',
    learned_in TEXT,
    shared_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_conversation_idx ON turns (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    parent_id TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'retired', 'rejected')),
    holdout_loss REAL,
    note TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT
);
CREATE TABLE IF NOT EXISTS learning_runs (
    id TEXT PRIMARY KEY,
    base_id TEXT NOT NULL,
    candidate_id TEXT,
    status TEXT NOT NULL,
    steps INTEGER NOT NULL,
    stats TEXT NOT NULL DEFAULT '{}',
    comparison TEXT,
    decision TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "consent_asked": False,
    "learning_enabled": False,
    "auto_learn_every": 8,
    "learning_steps": 150,
    "auto_promote": True,
    "sync_enabled": False,
    "sync_url": "",
    "sync_token": "",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.executescript(SCHEMA)
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _execute(self, sql: str, values: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self._lock:
            cursor = self._db.execute(sql, values)
            self._db.commit()
            return cursor

    def _all(self, sql: str, values: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._db.execute(sql, values).fetchall()]

    # Settings
    def get_setting(self, key: str) -> Any:
        rows = self._all("SELECT value FROM settings WHERE key = ?", (key,))
        return json.loads(rows[0]["value"]) if rows else DEFAULT_SETTINGS.get(key)

    def set_setting(self, key: str, value: Any) -> None:
        self._execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )

    # Conversations
    def add_turn(
        self, conversation_id: str, user_text: str, assistant_text: str, *, consent: bool, source: str = "chat"
    ) -> str:
        turn_id = str(uuid.uuid4())
        self._execute(
            "INSERT INTO turns (id, conversation_id, user_text, assistant_text, consent, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (turn_id, conversation_id, user_text, assistant_text, int(consent), source, now()),
        )
        return turn_id

    def rate_turn(self, turn_id: str, rating: str | None, correction: str | None = None) -> None:
        if rating not in (None, "up", "down"):
            raise ValueError("Rating must be 'up', 'down', or empty.")
        # A changed rating or correction means the turn should be learned again.
        self._execute(
            "UPDATE turns SET rating = ?, correction = COALESCE(?, correction), learned_in = NULL WHERE id = ?",
            (rating, correction, turn_id),
        )

    def set_consent_for_all(self, consent: bool) -> None:
        self._execute("UPDATE turns SET consent = ?", (int(consent),))

    def turns(self, *, consented_only: bool = False, unlearned_only: bool = False, unshared_only: bool = False) -> list[dict[str, Any]]:
        clauses = []
        if consented_only:
            clauses.append("consent = 1")
        if unlearned_only:
            clauses.append("learned_in IS NULL")
        if unshared_only:
            clauses.append("shared_at IS NULL")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self._all(f"SELECT * FROM turns {where} ORDER BY created_at")

    def conversation(self, conversation_id: str) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at", (conversation_id,))

    def mark_learned(self, turn_ids: list[str], run_id: str) -> None:
        with self._lock:
            self._db.executemany("UPDATE turns SET learned_in = ? WHERE id = ?", [(run_id, tid) for tid in turn_ids])
            self._db.commit()

    def mark_shared(self, turn_ids: list[str]) -> None:
        stamp = now()
        with self._lock:
            self._db.executemany("UPDATE turns SET shared_at = ? WHERE id = ?", [(stamp, tid) for tid in turn_ids])
            self._db.commit()

    def delete_all_conversations(self) -> None:
        self._execute("DELETE FROM turns")

    # Checkpoints
    def add_checkpoint(self, checkpoint_id: str, file_name: str, *, parent_id: str | None, source: str, status: str, note: str = "") -> None:
        self._execute(
            "INSERT INTO checkpoints (id, file_name, parent_id, source, status, note, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (checkpoint_id, file_name, parent_id, source, status, note, now(), now() if status == "active" else None),
        )

    def checkpoints(self) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM checkpoints ORDER BY created_at DESC, rowid DESC")

    def checkpoint(self, checkpoint_id: str) -> dict[str, Any] | None:
        rows = self._all("SELECT * FROM checkpoints WHERE id = ?", (checkpoint_id,))
        return rows[0] if rows else None

    def active_checkpoint(self) -> dict[str, Any] | None:
        rows = self._all("SELECT * FROM checkpoints WHERE status = 'active'")
        return rows[0] if rows else None

    def activate(self, checkpoint_id: str) -> None:
        with self._lock:
            self._db.execute("UPDATE checkpoints SET status = 'retired' WHERE status = 'active'")
            self._db.execute("UPDATE checkpoints SET status = 'active', activated_at = ? WHERE id = ?", (now(), checkpoint_id))
            self._db.commit()

    def set_checkpoint_status(self, checkpoint_id: str, status: str, holdout_loss: float | None = None) -> None:
        self._execute(
            "UPDATE checkpoints SET status = ?, holdout_loss = COALESCE(?, holdout_loss) WHERE id = ?",
            (status, holdout_loss, checkpoint_id),
        )

    # Learning runs
    def start_run(self, run_id: str, base_id: str, steps: int, stats: dict[str, int]) -> None:
        self._execute(
            "INSERT INTO learning_runs (id, base_id, status, steps, stats, started_at) VALUES (?, ?, 'running', ?, ?, ?)",
            (run_id, base_id, steps, json.dumps(stats), now()),
        )

    def finish_run(self, run_id: str, *, status: str, candidate_id: str | None = None, comparison: dict | None = None, decision: str | None = None, error: str | None = None) -> None:
        self._execute(
            "UPDATE learning_runs SET status = ?, candidate_id = ?, comparison = ?, decision = ?, error = ?, finished_at = ? WHERE id = ?",
            (status, candidate_id, json.dumps(comparison) if comparison else None, decision, error, now(), run_id),
        )

    def runs(self) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM learning_runs ORDER BY started_at DESC")
