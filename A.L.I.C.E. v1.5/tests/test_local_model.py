import tempfile
import unittest
from pathlib import Path

try:
    import torch

    from local_model import (
        ModelConfig,
        create_random_model,
        load_model,
        save_model,
        train_model,
    )
except ModuleNotFoundError as error:
    if error.name != "torch":
        raise
    ModelConfig = None  # type: ignore[assignment,misc]


@unittest.skipIf(ModelConfig is None, "Install project dependencies to test the model.")
class LocalModelTests(unittest.TestCase):
    def test_model_is_randomly_initialized_and_generates_prompt_continuation(self) -> None:
        config = ModelConfig(block_size=16, n_layer=1, n_head=2, n_embd=8)
        model = create_random_model(config, seed=123)
        output = model.generate("hello", max_new_tokens=4)

        self.assertTrue(output.startswith("hello"))
        self.assertGreaterEqual(len(output.encode("utf-8")), 5)

    def test_checkpoint_round_trip_preserves_configuration(self) -> None:
        config = ModelConfig(block_size=16, n_layer=1, n_head=2, n_embd=8)
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "model.pt"
            save_model(create_random_model(config, seed=1), checkpoint)
            loaded = load_model(checkpoint)

        self.assertEqual(loaded.config, config)

    def test_training_creates_a_checkpoint_from_local_corpus(self) -> None:
        config = ModelConfig(block_size=8, n_layer=1, n_head=2, n_embd=8)
        model = create_random_model(config, seed=7)
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            corpus = folder / "sample.txt"
            corpus.write_text("print('hello world')\n" * 4, encoding="utf-8")
            checkpoint = folder / "model.pt"
            initial_weights = model.token_embedding.weight.detach().clone()
            save_model(model, checkpoint)

            loss = train_model(corpus, checkpoint, steps=2, batch_size=2)
            trained_model = load_model(checkpoint)

        self.assertGreater(loss, 0)
        self.assertEqual(trained_model.config, config)
        self.assertFalse(torch.equal(initial_weights, trained_model.token_embedding.weight))

    def test_config_rejects_incompatible_attention_dimensions(self) -> None:
        with self.assertRaisesRegex(ValueError, "divisible"):
            ModelConfig(n_embd=10, n_head=3).validate()


if __name__ == "__main__":
    unittest.main()
