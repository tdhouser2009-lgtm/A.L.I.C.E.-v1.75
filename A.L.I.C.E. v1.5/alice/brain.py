"""Everything the standalone app needs: local memory, chat with the own model, and learning.

Data lives in ``~/.alice`` by default (override with the ``ALICE_HOME`` environment variable):
``alice.db`` (conversations, feedback, settings, version history) and ``models/*.pt``.
Nothing leaves the computer unless the user exports a bundle or turns on sync.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import threading
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from alice import __version__
from alice.chat import Turn, respond
from alice.learning import (
    LabeledTurn,
    build_learning_corpus,
    compare_checkpoints,
    should_promote,
    train_candidate,
    warm_start_corpus,
)
from alice.store import Store

BUNDLE_FORMAT = 1
MAX_BUNDLE_BYTES = 512 * 1024 * 1024
Progress = Callable[[int, int, float], None]


def default_home() -> Path:
    return Path(os.environ.get("ALICE_HOME", Path.home() / ".alice")).expanduser()


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


class LearningBusy(RuntimeError):
    pass


class AliceBrain:
    def __init__(self, home: Path | None = None, *, model_config: Any = None) -> None:
        self.home = home or default_home()
        self.model_config = model_config
        self.models_dir = self.home / "models"
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.store = Store(self.home / "alice.db")
        self._model: Any = None
        self._model_id: str | None = None
        self._model_lock = threading.RLock()
        self._learning = threading.Lock()

    # ───── Model versions ─────

    def checkpoint_path(self, checkpoint_id: str) -> Path:
        record = self.store.checkpoint(checkpoint_id)
        if record is None:
            raise ValueError(f"Unknown model version {checkpoint_id}.")
        return self.models_dir / record["file_name"]

    def ensure_model(self, seed: int | None = None) -> dict[str, Any]:
        """Create the very first, untrained model on first launch."""
        active = self.store.active_checkpoint()
        if active is not None and (self.models_dir / active["file_name"]).exists():
            return active
        from local_model import ModelConfig, create_random_model, save_model

        checkpoint_id = f"alice-{_stamp()}-untrained"
        save_model(create_random_model(self.model_config or ModelConfig(), seed=seed), self.models_dir / f"{checkpoint_id}.pt")
        self.store.add_checkpoint(checkpoint_id, f"{checkpoint_id}.pt", parent_id=None, source="initial", status="active",
                                  note="Randomly initialized; produces gibberish until it learns.")
        return self.store.active_checkpoint()  # type: ignore[return-value]

    def model(self) -> Any:
        """The active model, loaded once and reloaded after promotion or rollback."""
        with self._model_lock:
            active = self.ensure_model()
            if self._model is None or self._model_id != active["id"]:
                from local_model import load_model

                self._model = load_model(self.models_dir / active["file_name"])
                self._model_id = active["id"]
            return self._model

    def promote(self, checkpoint_id: str) -> None:
        record = self.store.checkpoint(checkpoint_id)
        if record is None:
            raise ValueError("Unknown model version.")
        if record["status"] == "active":
            return
        self.store.activate(checkpoint_id)

    def rollback(self, checkpoint_id: str) -> None:
        """Make an earlier version active again (the current one is kept as retired)."""
        record = self.store.checkpoint(checkpoint_id)
        if record is None or record["activated_at"] is None:
            raise ValueError("Only a version that was active before can be restored.")
        self.store.activate(checkpoint_id)

    def reject(self, checkpoint_id: str) -> None:
        record = self.store.checkpoint(checkpoint_id)
        if record is None or record["status"] != "candidate":
            raise ValueError("Only a candidate version can be rejected.")
        self.store.set_checkpoint_status(checkpoint_id, "rejected")

    # ───── Chat ─────

    def reply(self, conversation_id: str, user_message: str, **generation: Any) -> tuple[str, str]:
        history = [Turn(row["user_text"], row["correction"] or row["assistant_text"]) for row in self.store.conversation(conversation_id)]
        with self._model_lock:
            text = respond(self.model(), history, user_message, **generation)
        consent = bool(self.store.get_setting("learning_enabled"))
        turn_id = self.store.add_turn(conversation_id, user_message, text, consent=consent)
        return turn_id, text

    def unlearned_count(self) -> int:
        return len(self.store.turns(consented_only=True, unlearned_only=True))

    # ───── Learning ─────

    def learn(self, *, steps: int | None = None, progress: Progress | None = None, force: bool = False) -> dict[str, Any]:
        """Train a candidate on new consented turns and promote it if held-out loss does not get worse."""
        if not self._learning.acquire(blocking=False):
            raise LearningBusy("A learning run is already in progress.")
        try:
            new_rows = self.store.turns(consented_only=True, unlearned_only=True)
            if not new_rows and not force:
                return {"status": "skipped", "reason": "No new consented conversation turns to learn from."}
            old_rows = [row for row in self.store.turns(consented_only=True) if row["learned_in"] is not None]
            to_labeled = lambda rows: [LabeledTurn(r["user_text"], r["assistant_text"], r["rating"], r["correction"]) for r in rows]
            corpus, holdout, stats = build_learning_corpus(to_labeled(new_rows), to_labeled(old_rows))
            if not corpus:
                self.store.mark_learned([row["id"] for row in new_rows], "skipped")
                return {"status": "skipped", "reason": "Every new turn was rated down without a correction.", "stats": stats}
            return self._train_and_decide(corpus, holdout, source="learning", steps=steps, progress=progress,
                                          stats=stats, learned_ids=[row["id"] for row in new_rows])
        finally:
            self._learning.release()

    def warm_start(self, *, steps: int = 400, progress: Progress | None = None) -> dict[str, Any]:
        """Optional: teach basic conversation from the bundled starter corpus (user-initiated only)."""
        if not self._learning.acquire(blocking=False):
            raise LearningBusy("A learning run is already in progress.")
        try:
            corpus = warm_start_corpus()
            return self._train_and_decide(corpus, corpus, source="warm-start", steps=steps, progress=progress,
                                          stats={"bytes": len(corpus)}, learned_ids=[], always_promote=True)
        finally:
            self._learning.release()

    def _train_and_decide(self, corpus: bytes, holdout: bytes, *, source: str, steps: int | None,
                          progress: Progress | None, stats: dict[str, int], learned_ids: list[str],
                          always_promote: bool = False) -> dict[str, Any]:
        active = self.ensure_model()
        steps = int(steps or self.store.get_setting("learning_steps") or 150)
        run_id = str(uuid.uuid4())
        candidate_id = f"alice-{_stamp()}-{source}-{run_id[:6]}"
        candidate_path = self.models_dir / f"{candidate_id}.pt"
        self.store.start_run(run_id, active["id"], steps, stats)
        try:
            loss = train_candidate(self.models_dir / active["file_name"], candidate_path, corpus, steps=steps,
                                   progress=(lambda step, value: progress(step, steps, value)) if progress else None)
            # With too little held-out data, compare on the training text and say so in the run record.
            comparison = compare_checkpoints(self.models_dir / active["file_name"], candidate_path, holdout or corpus)
            comparison["heldOut"] = {"bytes": float(len(holdout)), "usedTrainingText": float(not holdout)}
            self.store.add_checkpoint(candidate_id, candidate_path.name, parent_id=active["id"], source=source,
                                      status="candidate", note=f"Trained {steps} steps; final training loss {loss:.3f}.")
            self.store.set_checkpoint_status(candidate_id, "candidate", comparison["candidate"]["loss"])
            better = should_promote(comparison)
            if always_promote or (better and self.store.get_setting("auto_promote")):
                self.store.activate(candidate_id)
                decision = "promoted"
            else:
                decision = "kept-for-review" if better else "not-better"
            self.store.mark_learned(learned_ids, run_id)
            self.store.finish_run(run_id, status="completed", candidate_id=candidate_id, comparison=comparison, decision=decision)
            return {"status": "completed", "runId": run_id, "candidateId": candidate_id, "decision": decision,
                    "comparison": comparison, "stats": stats}
        except Exception as error:  # noqa: BLE001 - recorded for the user, then re-raised
            self.store.finish_run(run_id, status="failed", error=str(error))
            raise

    # ───── Export / import ─────

    def export_bundle(self, destination: Path, *, include_model: bool = True, include_conversations: bool = True) -> Path:
        """Write a portable .alice zip with the active model and/or consented conversations."""
        active = self.ensure_model()
        turns = [
            {"user": r["user_text"], "assistant": r["assistant_text"], "rating": r["rating"], "correction": r["correction"]}
            for r in self.store.turns(consented_only=True)
        ] if include_conversations else []
        manifest = {"format": BUNDLE_FORMAT, "app": "A.L.I.C.E.", "version": __version__, "createdAt": _stamp(),
                    "checkpointId": active["id"] if include_model else None, "turns": len(turns)}
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps(manifest, indent=2))
            if include_model:
                bundle.write(self.models_dir / active["file_name"], "model.pt")
            if include_conversations:
                bundle.writestr("conversations.jsonl", "".join(json.dumps(t) + "\n" for t in turns))
        return destination

    def import_bundle(self, source: Path) -> dict[str, Any]:
        """Import a bundle. Its model becomes a candidate (never active automatically)."""
        from local_model import load_model

        if source.stat().st_size > MAX_BUNDLE_BYTES:
            raise ValueError("The bundle is too large.")
        result: dict[str, Any] = {"checkpointId": None, "turns": 0}
        with zipfile.ZipFile(source) as bundle:
            names = set(bundle.namelist())
            if "manifest.json" not in names:
                raise ValueError("This file is not an A.L.I.C.E. bundle.")
            manifest = json.loads(bundle.read("manifest.json"))
            if manifest.get("format") != BUNDLE_FORMAT:
                raise ValueError("Unsupported bundle format.")
            if "model.pt" in names:
                active = self.ensure_model()
                checkpoint_id = f"alice-{_stamp()}-import-{uuid.uuid4().hex[:6]}"
                target = self.models_dir / f"{checkpoint_id}.pt"
                with bundle.open("model.pt") as data, open(target, "wb") as out:
                    shutil.copyfileobj(data, out)
                try:
                    load_model(target)  # validates the file with weights_only loading
                except ValueError:
                    target.unlink(missing_ok=True)
                    raise
                self.store.add_checkpoint(checkpoint_id, target.name, parent_id=active["id"], source="import",
                                          status="candidate", note=f"Imported from {source.name}.")
                result["checkpointId"] = checkpoint_id
            if "conversations.jsonl" in names:
                conversation_id = f"import-{uuid.uuid4()}"
                consent = bool(self.store.get_setting("learning_enabled"))
                for line in io.TextIOWrapper(bundle.open("conversations.jsonl"), encoding="utf-8"):
                    if not line.strip():
                        continue
                    item = json.loads(line)
                    if not isinstance(item.get("user"), str) or not isinstance(item.get("assistant"), str):
                        continue
                    turn_id = self.store.add_turn(conversation_id, item["user"][:12000], item["assistant"][:12000], consent=consent, source="import")
                    if item.get("rating") in ("up", "down") or item.get("correction"):
                        self.store.rate_turn(turn_id, item.get("rating"), item.get("correction"))
                    result["turns"] += 1
        return result

    # ───── Optional sync with a self-hosted A.L.I.C.E. API (off by default) ─────

    def _sync_request(self, path: str, *, data: bytes | None = None, accept: str = "application/json") -> tuple[bytes, dict[str, str]]:
        if not self.store.get_setting("sync_enabled"):
            raise PermissionError("Sync is turned off. Enable it in Settings first.")
        base = str(self.store.get_setting("sync_url") or "").rstrip("/")
        token = str(self.store.get_setting("sync_token") or "")
        if not base.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise ValueError("Use an https:// sync address (plain http is only allowed for localhost).")
        request = urllib.request.Request(
            f"{base}{path}", data=data, method="POST" if data is not None else "GET",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": accept},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read(), dict(response.headers)

    def sync_push(self) -> int:
        """Share consented, not-yet-shared turns with the sync server."""
        rows = self.store.turns(consented_only=True, unshared_only=True)
        labeled = [LabeledTurn(r["user_text"], r["assistant_text"], r["rating"], r["correction"]) for r in rows]
        turns = [{"user": t.user, "assistant": t.assistant} for t in (item.training_turn() for item in labeled) if t]
        if turns:
            install_id = self.store.get_setting("install_id") or str(uuid.uuid4())
            self.store.set_setting("install_id", install_id)
            self._sync_request("/api/sync/contributions", data=json.dumps({"installId": install_id, "turns": turns}).encode("utf-8"))
        self.store.mark_shared([r["id"] for r in rows])
        return len(turns)

    def sync_pull(self) -> str | None:
        """Download the server's latest promoted model as a candidate version."""
        from local_model import load_model

        try:
            body, headers = self._sync_request("/api/sync/checkpoint", accept="application/octet-stream")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise
        if len(body) > MAX_BUNDLE_BYTES:
            raise ValueError("The downloaded model is too large.")
        active = self.ensure_model()
        checkpoint_id = f"alice-{_stamp()}-sync-{uuid.uuid4().hex[:6]}"
        target = self.models_dir / f"{checkpoint_id}.pt"
        target.write_bytes(body)
        try:
            load_model(target)
        except ValueError:
            target.unlink(missing_ok=True)
            raise
        remote = {k.lower(): v for k, v in headers.items()}.get("x-checkpoint-id", "unknown")
        self.store.add_checkpoint(checkpoint_id, target.name, parent_id=active["id"], source="sync",
                                  status="candidate", note=f"Pulled from sync server (remote version {remote}).")
        return checkpoint_id

    # ───── Status ─────

    def status(self) -> dict[str, Any]:
        from local_model import parameter_count

        active = self.ensure_model()
        model = self.model()
        return {
            "active": active,
            "parameters": parameter_count(model),
            "config": model.config,
            "turns": len(self.store.turns()),
            "unlearned": self.unlearned_count(),
            "learningEnabled": bool(self.store.get_setting("learning_enabled")),
        }
