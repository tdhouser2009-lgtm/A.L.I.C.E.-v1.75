"""Command-line bridge between the TypeScript model worker and A.L.I.C.E.'s PyTorch model core.

Every command prints JSON. ``train`` streams one JSON object per line (progress events, then a
final ``done`` or ``error`` event). ``serve`` keeps models loaded and answers JSON-line requests on
stdin so chat replies do not pay PyTorch start-up time on every message.

    python model_bridge.py init --out m.pt [--config '{"blockSize":256}'] [--seed 1]
    python model_bridge.py train --out new.pt --corpus data.txt --steps 200 [--base old.pt] [--config '{}']
    python model_bridge.py evaluate --checkpoint m.pt --dataset held_out.txt
    python model_bridge.py info --checkpoint m.pt
    python model_bridge.py serve
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path
from typing import Any

from alice.chat import Turn, messages_to_turns, respond
from local_model import (
    checkpoint_step,
    config_from_public,
    config_to_public,
    create_random_model,
    evaluate_model,
    load_model,
    parameter_count,
    save_model,
    train_on_bytes,
)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def command_init(args: argparse.Namespace) -> None:
    config = config_from_public(json.loads(args.config or "{}"))
    model = create_random_model(config, seed=args.seed)
    save_model(model, Path(args.out))
    emit({"event": "done", "config": config_to_public(config), "parameters": parameter_count(model)})


def command_train(args: argparse.Namespace) -> None:
    out = Path(args.out)
    if out.exists():
        raise ValueError("The output checkpoint already exists; learning never overwrites a checkpoint.")
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.base:
        shutil.copyfile(args.base, out)
    config = config_from_public(json.loads(args.config or "{}")) if not args.base else None
    corpus = Path(args.corpus).read_bytes()
    every = max(1, args.steps // 50)

    def progress(step: int, loss: float) -> None:
        if step == 1 or step % every == 0 or step == args.steps:
            emit({"event": "progress", "step": step, "loss": loss})

    try:
        loss = train_on_bytes(corpus, out, steps=args.steps, batch_size=args.batch_size, config=config, progress=progress)
    except BaseException:
        out.unlink(missing_ok=True)
        raise
    model = load_model(out)
    emit({"event": "done", "loss": loss, "config": config_to_public(model.config), "totalSteps": checkpoint_step(out)})


def command_evaluate(args: argparse.Namespace) -> None:
    model = load_model(Path(args.checkpoint))
    emit({"event": "done", **evaluate_model(model, Path(args.dataset).read_bytes())})


def command_info(args: argparse.Namespace) -> None:
    path = Path(args.checkpoint)
    model = load_model(path)
    emit({"event": "done", "config": config_to_public(model.config), "parameters": parameter_count(model), "totalSteps": checkpoint_step(path)})


def command_serve(_args: argparse.Namespace) -> None:
    cache: dict[str, tuple[float, Any]] = {}
    emit({"event": "ready"})
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("op") != "generate":
                raise ValueError("Unsupported operation.")
            path = Path(request["checkpoint"])
            mtime = path.stat().st_mtime
            cached = cache.get(str(path))
            if cached is None or cached[0] != mtime:
                if len(cache) >= 4:
                    cache.pop(next(iter(cache)))
                cache[str(path)] = (mtime, load_model(path))
            model = cache[str(path)][1]
            messages = request.get("messages", [])
            if not messages or messages[-1].get("role") != "user":
                raise ValueError("The last message must come from the user.")
            history: list[Turn] = messages_to_turns(messages[:-1])
            text = respond(
                model,
                history,
                messages[-1]["content"],
                max_new_tokens=int(request.get("maxNewTokens", 240)),
                temperature=float(request.get("temperature", 0.8)),
            )
            emit({"id": request_id, "ok": True, "text": text})
        except Exception as error:  # noqa: BLE001 - reported to the worker
            emit({"id": request_id, "ok": False, "error": str(error)})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--out", required=True)
    init.add_argument("--config")
    init.add_argument("--seed", type=int)
    train = commands.add_parser("train")
    train.add_argument("--out", required=True)
    train.add_argument("--corpus", required=True)
    train.add_argument("--steps", type=int, required=True)
    train.add_argument("--base")
    train.add_argument("--config")
    train.add_argument("--batch-size", type=int, default=16)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--checkpoint", required=True)
    evaluate.add_argument("--dataset", required=True)
    info = commands.add_parser("info")
    info.add_argument("--checkpoint", required=True)
    commands.add_parser("serve")
    args = parser.parse_args(argv)
    handlers = {"init": command_init, "train": command_train, "evaluate": command_evaluate, "info": command_info, "serve": command_serve}
    try:
        handlers[args.command](args)
    except Exception as error:  # noqa: BLE001 - surfaced as a JSON error event
        emit({"event": "error", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
