"""Tests for model_bridge.py, the Python side of the model worker."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

try:
    import torch  # noqa: F401
except ModuleNotFoundError:
    torch = None  # type: ignore[assignment]

TINY = json.dumps({"blockSize": 16, "layers": 1, "heads": 2, "embeddingSize": 16})


def run_bridge(*args: str, stdin: str | None = None) -> list[dict]:
    completed = subprocess.run(
        [sys.executable, str(ROOT / "model_bridge.py"), *args],
        input=stdin, capture_output=True, text=True, cwd=ROOT, timeout=120,
    )
    events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    if completed.returncode != 0 and not events:
        raise AssertionError(completed.stderr)
    return events


@unittest.skipIf(torch is None, "Install PyTorch to test the model bridge.")
class ModelBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_init_reports_config(self) -> None:
        events = run_bridge("init", "--out", str(self.root / "a.pt"), "--config", TINY, "--seed", "1")
        self.assertEqual(events[-1]["event"], "done")
        self.assertEqual(events[-1]["config"]["blockSize"], 16)
        self.assertTrue((self.root / "a.pt").exists())

    def test_train_from_base_never_overwrites_base_and_reports_real_config(self) -> None:
        base = self.root / "base.pt"
        run_bridge("init", "--out", str(base), "--config", TINY, "--seed", "1")
        before = base.read_bytes()
        corpus = self.root / "corpus.txt"
        corpus.write_text("User: hi\nAlice: hello\n\n" * 3)
        events = run_bridge("train", "--out", str(self.root / "cand.pt"), "--base", str(base), "--corpus", str(corpus), "--steps", "3", "--batch-size", "2")
        self.assertEqual(events[0]["event"], "progress")
        self.assertEqual(events[-1]["event"], "done")
        self.assertEqual(events[-1]["config"], {"blockSize": 16, "layers": 1, "heads": 2, "embeddingSize": 16})
        self.assertEqual(base.read_bytes(), before)

    def test_train_refuses_to_overwrite(self) -> None:
        out = self.root / "x.pt"
        run_bridge("init", "--out", str(out), "--config", TINY)
        corpus = self.root / "c.txt"
        corpus.write_text("abc" * 20)
        events = run_bridge("train", "--out", str(out), "--corpus", str(corpus), "--steps", "1")
        self.assertEqual(events[-1]["event"], "error")

    def test_evaluate_and_info(self) -> None:
        out = self.root / "m.pt"
        run_bridge("init", "--out", str(out), "--config", TINY, "--seed", "2")
        dataset = self.root / "d.txt"
        dataset.write_text("User: a\nAlice: b\n\n" * 4)
        result = run_bridge("evaluate", "--checkpoint", str(out), "--dataset", str(dataset))[-1]
        self.assertGreater(result["loss"], 0)
        self.assertGreater(result["perplexity"], 1)
        info = run_bridge("info", "--checkpoint", str(out))[-1]
        self.assertGreater(info["parameters"], 0)

    def test_serve_generates_replies_and_reports_errors(self) -> None:
        out = self.root / "m.pt"
        run_bridge("init", "--out", str(out), "--config", TINY, "--seed", "3")
        requests = "\n".join([
            json.dumps({"id": "1", "op": "generate", "checkpoint": str(out), "maxNewTokens": 5,
                        "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}, {"role": "user", "content": "again"}]}),
            json.dumps({"id": "2", "op": "generate", "checkpoint": str(out), "messages": []}),
        ]) + "\n"
        events = run_bridge("serve", stdin=requests)
        self.assertEqual(events[0]["event"], "ready")
        self.assertTrue(events[1]["ok"])
        self.assertIsInstance(events[1]["text"], str)
        self.assertFalse(events[2]["ok"])


if __name__ == "__main__":
    unittest.main()
