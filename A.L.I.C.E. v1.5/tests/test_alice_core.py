import json
import tempfile
import unittest
import zipfile
from pathlib import Path

try:
    import torch  # noqa: F401

    from alice.brain import AliceBrain
    from local_model import ModelConfig
except ModuleNotFoundError as error:
    if error.name != "torch":
        raise
    AliceBrain = None  # type: ignore[assignment,misc]

from alice.chat import Turn, build_prompt, format_turn, messages_to_turns, turns_to_corpus
from alice.learning import LabeledTurn, build_learning_corpus, is_holdout, should_promote

TINY = None if AliceBrain is None else ModelConfig(block_size=32, n_layer=1, n_head=2, n_embd=16)


class ChatFormatTests(unittest.TestCase):
    def test_turn_format_collapses_blank_lines(self) -> None:
        text = format_turn(Turn("hi\n\nthere", "hello"))
        self.assertEqual(text, "User: hi\nthere\nAlice: hello\n\n")

    def test_prompt_ends_with_open_assistant_line_and_respects_budget(self) -> None:
        history = [Turn(f"question {i}", "answer " * 20) for i in range(50)]
        prompt = build_prompt(history, "latest?", max_bytes=400)
        self.assertTrue(prompt.endswith("User: latest?\nAlice: "))
        self.assertLessEqual(len(prompt.encode()), 400)
        self.assertIn("question 49", prompt)

    def test_messages_pair_into_turns(self) -> None:
        turns = messages_to_turns([
            {"role": "system", "content": "x"},
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
            {"role": "user", "content": "c"},
        ])
        self.assertEqual(turns, [Turn("a", "b")])


class LearningCorpusTests(unittest.TestCase):
    def test_corrections_win_and_downvotes_are_skipped(self) -> None:
        turns = [
            LabeledTurn("q1", "bad", rating="down"),
            LabeledTurn("q2", "wrong", rating="down", correction="right"),
            LabeledTurn("q3", "fine"),
        ]
        corpus, holdout, stats = build_learning_corpus(turns)
        text = (corpus + holdout).decode()
        self.assertNotIn("bad", text)
        self.assertNotIn("wrong", text)
        self.assertIn("Alice: right", text)
        self.assertEqual(stats["skippedTurns"], 1)

    def test_holdout_assignment_is_stable(self) -> None:
        turn = Turn("same", "turn")
        self.assertEqual(is_holdout(turn), is_holdout(Turn("same", "turn")))

    def test_promotion_requires_no_regression(self) -> None:
        self.assertTrue(should_promote({"active": {"loss": 2.0}, "candidate": {"loss": 1.9}}))
        self.assertFalse(should_promote({"active": {"loss": 2.0}, "candidate": {"loss": 2.1}}))

    def test_corpus_is_bytes_in_transcript_format(self) -> None:
        self.assertEqual(turns_to_corpus([Turn("a", "b")]), b"User: a\nAlice: b\n\n")


@unittest.skipIf(AliceBrain is None, "Install PyTorch to test the model.")
class BrainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.brain = AliceBrain(Path(self.directory.name), model_config=TINY)

    def tearDown(self) -> None:
        self.brain.store.close()
        self.directory.cleanup()

    def test_first_launch_creates_an_untrained_active_model(self) -> None:
        active = self.brain.ensure_model(seed=1)
        self.assertEqual(active["status"], "active")
        self.assertEqual(active["source"], "initial")
        self.assertTrue((self.brain.models_dir / active["file_name"]).exists())

    def test_chat_without_consent_is_not_learned(self) -> None:
        self.brain.reply("c1", "hello", max_new_tokens=8)
        self.assertEqual(self.brain.unlearned_count(), 0)
        self.assertEqual(self.brain.learn(steps=2)["status"], "skipped")

    def test_learning_from_use_creates_candidate_and_supports_rollback(self) -> None:
        self.brain.store.set_setting("learning_enabled", True)
        initial = self.brain.ensure_model(seed=2)
        for i in range(6):
            turn_id, _ = self.brain.reply("c1", f"what is {i} plus {i}?", max_new_tokens=8)
            self.brain.store.rate_turn(turn_id, "down", correction=f"{i} plus {i} is {2 * i}.")
        result = self.brain.learn(steps=3)
        self.assertEqual(result["status"], "completed")
        self.assertIn(result["decision"], {"promoted", "not-better", "kept-for-review"})
        self.assertEqual(self.brain.unlearned_count(), 0)
        candidate = self.brain.store.checkpoint(result["candidateId"])
        self.assertIsNotNone(candidate)
        self.assertIsNotNone(candidate["holdout_loss"])
        # The initial model file is never modified by learning.
        self.assertTrue((self.brain.models_dir / initial["file_name"]).exists())
        self.brain.promote(result["candidateId"])
        self.assertEqual(self.brain.store.active_checkpoint()["id"], result["candidateId"])
        self.brain.rollback(initial["id"])
        self.assertEqual(self.brain.store.active_checkpoint()["id"], initial["id"])

    def test_warm_start_is_promoted(self) -> None:
        self.brain.ensure_model(seed=3)
        result = self.brain.warm_start(steps=2)
        self.assertEqual(result["decision"], "promoted")
        self.assertEqual(self.brain.store.active_checkpoint()["source"], "warm-start")

    def test_export_import_round_trip_keeps_imported_model_as_candidate(self) -> None:
        self.brain.store.set_setting("learning_enabled", True)
        self.brain.reply("c1", "hi", max_new_tokens=4)
        bundle = self.brain.export_bundle(Path(self.directory.name) / "out.alice")
        with zipfile.ZipFile(bundle) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["turns"], 1)
            self.assertIn("model.pt", archive.namelist())
        with tempfile.TemporaryDirectory() as other_home:
            other = AliceBrain(Path(other_home), model_config=TINY)
            try:
                result = other.import_bundle(bundle)
                self.assertEqual(result["turns"], 1)
                self.assertEqual(other.store.checkpoint(result["checkpointId"])["status"], "candidate")
                self.assertNotEqual(other.store.active_checkpoint()["id"], result["checkpointId"])
            finally:
                other.store.close()

    def test_import_rejects_non_bundles(self) -> None:
        path = Path(self.directory.name) / "bad.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("hello.txt", "x")
        with self.assertRaises(ValueError):
            self.brain.import_bundle(path)

    def test_sync_is_off_by_default(self) -> None:
        with self.assertRaises(PermissionError):
            self.brain.sync_pull()


if __name__ == "__main__":
    unittest.main()
