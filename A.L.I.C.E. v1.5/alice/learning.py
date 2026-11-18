"""Continual learning primitives: candidate training, held-out comparison, and corpus building.

Learning never updates the active weights in place. Each update copies the active checkpoint to a
new candidate file, trains the copy, and compares both on the same held-out conversations. The
caller decides whether to promote; the old checkpoint stays on disk so it can be restored.
"""

from __future__ import annotations

import hashlib
import random
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

from alice.chat import Turn, turns_to_corpus

HOLDOUT_FRACTION = 0.15
MIN_TURNS_FOR_HOLDOUT = 20


@dataclass(frozen=True)
class LabeledTurn:
    """A stored exchange with the user's feedback."""

    user: str
    assistant: str
    rating: str | None = None  # "up", "down", or None
    correction: str | None = None

    def training_turn(self) -> Turn | None:
        """The text A.L.I.C.E. should learn from, or ``None`` when the turn must be skipped.

        A correction always wins. A thumbs-down reply without a correction is never learned.
        """
        if self.correction and self.correction.strip():
            return Turn(self.user, self.correction)
        if self.rating == "down":
            return None
        return Turn(self.user, self.assistant)


def is_holdout(turn: Turn, fraction: float = HOLDOUT_FRACTION) -> bool:
    """Stable train/held-out assignment: the same turn is always on the same side."""
    digest = hashlib.sha256(f"{turn.user}\x00{turn.assistant}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 2**32 < fraction


def split_turns(turns: Iterable[Turn], fraction: float = HOLDOUT_FRACTION) -> tuple[list[Turn], list[Turn]]:
    train: list[Turn] = []
    holdout: list[Turn] = []
    for turn in turns:
        (holdout if is_holdout(turn, fraction) else train).append(turn)
    return train, holdout


def build_learning_corpus(
    new_turns: Sequence[LabeledTurn],
    replay_turns: Sequence[LabeledTurn] = (),
    *,
    replay_ratio: float = 2.0,
    seed: int = 0,
) -> tuple[bytes, bytes, dict[str, int]]:
    """Training corpus (new turns + a replay sample of older ones) and a held-out corpus.

    Replaying older turns reduces forgetting. Thumbs-up turns are included twice so the model
    leans toward answers the user liked.
    """
    rng = random.Random(seed)
    usable_new = [t for t in (item.training_turn() for item in new_turns) if t is not None]
    liked = {(item.user, item.correction or item.assistant) for item in new_turns if item.rating == "up"}
    usable_old = [t for t in (item.training_turn() for item in replay_turns) if t is not None]

    new_train, new_holdout = split_turns(usable_new)
    old_train, old_holdout = split_turns(usable_old)
    if len(usable_new) + len(usable_old) < MIN_TURNS_FOR_HOLDOUT:
        # Too little data to set any aside: learn from everything; the caller then compares
        # checkpoints on the training text and records that it did so.
        new_train, new_holdout = usable_new, []
        old_train, old_holdout = usable_old, []
    replay = rng.sample(old_train, min(len(old_train), int(len(new_train) * replay_ratio)))
    train = list(new_train)
    train.extend(turn for turn in new_train if (turn.user, turn.assistant) in liked)
    train.extend(replay)
    rng.shuffle(train)
    holdout = new_holdout + old_holdout
    stats = {
        "newTurns": len(usable_new),
        "skippedTurns": len(new_turns) - len(usable_new),
        "replayTurns": len(replay),
        "trainTurns": len(train),
        "holdoutTurns": len(holdout),
    }
    return turns_to_corpus(train), turns_to_corpus(holdout), stats


def train_candidate(
    base_checkpoint: Path,
    candidate_checkpoint: Path,
    corpus: bytes,
    *,
    steps: int,
    batch_size: int = 16,
    learning_rate: float = 3e-4,
    progress: Callable[[int, float], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> float:
    """Copy ``base_checkpoint`` to ``candidate_checkpoint`` and train the copy on ``corpus``."""
    from local_model import train_on_bytes

    if not base_checkpoint.exists():
        raise ValueError(f"Base checkpoint {base_checkpoint} does not exist.")
    if candidate_checkpoint.exists():
        raise ValueError(f"Candidate checkpoint {candidate_checkpoint} already exists.")
    candidate_checkpoint.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(base_checkpoint, candidate_checkpoint)
    try:
        return train_on_bytes(
            corpus,
            candidate_checkpoint,
            steps=steps,
            batch_size=batch_size,
            learning_rate=learning_rate,
            progress=progress,
            should_stop=should_stop,
        )
    except BaseException:
        candidate_checkpoint.unlink(missing_ok=True)
        raise


def compare_checkpoints(active: Path, candidate: Path, holdout: bytes) -> dict[str, dict[str, float]]:
    """Evaluate both checkpoints on the same held-out bytes (lower loss is better)."""
    from local_model import evaluate_model, load_model

    return {
        "active": evaluate_model(load_model(active), holdout),
        "candidate": evaluate_model(load_model(candidate), holdout),
    }


def should_promote(comparison: dict[str, dict[str, float]], tolerance: float = 0.0) -> bool:
    """Promote only when the candidate is at least as good as the active model on held-out data."""
    return comparison["candidate"]["loss"] <= comparison["active"]["loss"] * (1.0 + tolerance)


def warm_start_corpus() -> bytes:
    """The optional bootstrap corpus shipped with the app (self-written, public to use)."""
    return (Path(__file__).parent / "data" / "warm_start.txt").read_bytes()
