"""A.L.I.C.E.'s own model: a byte-level decoder-only Transformer trained from random initialization.

The tokenizer is the 256 possible byte values, so any text in any language (and any new word the
model meets while learning from use) is representable without ever rebuilding a vocabulary.
"""

from __future__ import annotations

import math
import pickle
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

import torch
from torch import Tensor, nn
from torch.nn import functional as F

VOCAB_SIZE = 256
CHECKPOINT_FORMAT = 1
MAX_CORPUS_BYTES = 100 * 1024 * 1024
CORPUS_SUFFIXES = {".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json", ".java", ".c", ".h", ".cpp", ".rs", ".go"}


@dataclass(frozen=True)
class ModelConfig:
    block_size: int = 256
    n_layer: int = 4
    n_head: int = 4
    n_embd: int = 128

    def validate(self) -> None:
        if self.block_size < 8:
            raise ValueError("block_size must be at least 8.")
        if self.n_layer < 1:
            raise ValueError("n_layer must be at least 1.")
        if self.n_head < 1 or self.n_embd < 1:
            raise ValueError("n_head and n_embd must be positive.")
        if self.n_embd % self.n_head:
            raise ValueError("n_embd must be divisible by n_head.")


class CausalSelfAttention(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.n_head = config.n_head
        self.head_size = config.n_embd // config.n_head
        self.query_key_value = nn.Linear(config.n_embd, 3 * config.n_embd)
        self.projection = nn.Linear(config.n_embd, config.n_embd)

    def forward(self, inputs: Tensor) -> Tensor:
        batch_size, sequence_length, channels = inputs.shape
        query, key, value = self.query_key_value(inputs).split(channels, dim=2)
        query = query.view(batch_size, sequence_length, self.n_head, self.head_size).transpose(1, 2)
        key = key.view(batch_size, sequence_length, self.n_head, self.head_size).transpose(1, 2)
        value = value.view(batch_size, sequence_length, self.n_head, self.head_size).transpose(1, 2)
        weights = query @ key.transpose(-2, -1) / math.sqrt(self.head_size)
        causal_mask = torch.ones(
            sequence_length, sequence_length, device=inputs.device, dtype=torch.bool
        ).tril()
        weights = weights.masked_fill(~causal_mask, float("-inf"))
        attention = F.softmax(weights, dim=-1) @ value
        attention = attention.transpose(1, 2).contiguous().view(batch_size, sequence_length, channels)
        return self.projection(attention)


class TransformerBlock(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.attention_norm = nn.LayerNorm(config.n_embd)
        self.attention = CausalSelfAttention(config)
        self.mlp_norm = nn.LayerNorm(config.n_embd)
        self.mlp = nn.Sequential(
            nn.Linear(config.n_embd, 4 * config.n_embd),
            nn.GELU(),
            nn.Linear(4 * config.n_embd, config.n_embd),
        )

    def forward(self, inputs: Tensor) -> Tensor:
        inputs = inputs + self.attention(self.attention_norm(inputs))
        return inputs + self.mlp(self.mlp_norm(inputs))


class TinyLanguageModel(nn.Module):
    def __init__(self, config: ModelConfig = ModelConfig()) -> None:
        super().__init__()
        config.validate()
        self.config = config
        self.token_embedding = nn.Embedding(VOCAB_SIZE, config.n_embd)
        self.position_embedding = nn.Embedding(config.block_size, config.n_embd)
        self.blocks = nn.Sequential(*(TransformerBlock(config) for _ in range(config.n_layer)))
        self.final_norm = nn.LayerNorm(config.n_embd)
        self.language_head = nn.Linear(config.n_embd, VOCAB_SIZE)
        self.apply(self._initialize_weights)
        self.language_head.weight = self.token_embedding.weight

    @staticmethod
    def _initialize_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(self, tokens: Tensor, targets: Tensor | None = None) -> tuple[Tensor, Tensor | None]:
        _, sequence_length = tokens.shape
        if sequence_length > self.config.block_size:
            raise ValueError("Input is longer than the model's block size.")
        positions = torch.arange(sequence_length, device=tokens.device)
        hidden = self.token_embedding(tokens) + self.position_embedding(positions)
        logits = self.language_head(self.final_norm(self.blocks(hidden)))
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.reshape(-1, VOCAB_SIZE), targets.reshape(-1))
        return logits, loss

    @torch.inference_mode()
    def generate(
        self,
        prompt: str,
        max_new_tokens: int = 200,
        temperature: float = 0.8,
        *,
        top_k: int | None = None,
        stop: tuple[bytes, ...] = (),
        include_prompt: bool = True,
    ) -> str:
        """Continue ``prompt`` byte by byte.

        ``stop`` sequences end generation early (and are removed from the result). With
        ``include_prompt=False`` only the newly generated text is returned.
        """
        if not prompt:
            raise ValueError("Enter a prompt to continue.")
        if max_new_tokens < 0:
            raise ValueError("max_new_tokens cannot be negative.")
        if temperature <= 0:
            raise ValueError("temperature must be greater than zero.")
        prompt_bytes = prompt.encode("utf-8")
        output = torch.tensor(list(prompt_bytes), dtype=torch.long).unsqueeze(0)
        generated = bytearray()
        was_training = self.training
        self.eval()
        try:
            for _ in range(max_new_tokens):
                context = output[:, -self.config.block_size :]
                logits, _ = self(context)
                logits = logits[:, -1, :] / temperature
                if top_k is not None and 0 < top_k < VOCAB_SIZE:
                    threshold = torch.topk(logits, top_k).values[:, -1, None]
                    logits = logits.masked_fill(logits < threshold, float("-inf"))
                probabilities = F.softmax(logits, dim=-1)
                next_token = torch.multinomial(probabilities, num_samples=1)
                output = torch.cat((output, next_token), dim=1)
                generated.append(int(next_token))
                if stop and any(generated.endswith(sequence) for sequence in stop):
                    for sequence in stop:
                        if generated.endswith(sequence):
                            del generated[-len(sequence) :]
                            break
                    break
        finally:
            self.train(was_training)
        text = bytes(generated) if not include_prompt else prompt_bytes + bytes(generated)
        return text.decode("utf-8", errors="replace")


def parameter_count(model: nn.Module) -> int:
    # The language head shares the embedding weights; count shared tensors once.
    seen: set[int] = set()
    total = 0
    for parameter in model.parameters():
        if id(parameter) not in seen:
            seen.add(id(parameter))
            total += parameter.numel()
    return total


def create_random_model(config: ModelConfig = ModelConfig(), seed: int | None = None) -> TinyLanguageModel:
    if seed is not None:
        torch.manual_seed(seed)
    return TinyLanguageModel(config)


def load_model(checkpoint_path: Path) -> TinyLanguageModel:
    try:
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    except (OSError, RuntimeError, ValueError, EOFError, pickle.UnpicklingError) as error:
        raise ValueError(f"Could not load model checkpoint {checkpoint_path}: {error}") from error
    if not isinstance(checkpoint, dict) or checkpoint.get("format") != CHECKPOINT_FORMAT:
        raise ValueError("The selected file is not a supported local model checkpoint.")
    try:
        config = ModelConfig(**checkpoint["config"])
        model = TinyLanguageModel(config)
        model.load_state_dict(checkpoint["state_dict"])
    except (KeyError, TypeError, ValueError, RuntimeError) as error:
        raise ValueError(f"The model checkpoint is invalid: {error}") from error
    return model


def save_model(model: TinyLanguageModel, checkpoint_path: Path, step: int = 0) -> None:
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "format": CHECKPOINT_FORMAT,
            "config": asdict(model.config),
            "step": step,
            "state_dict": model.state_dict(),
        },
        checkpoint_path,
    )


def read_corpus(source: Path) -> bytes:
    if source.is_file():
        files = [source]
    elif source.is_dir():
        files = sorted(
            path
            for path in source.rglob("*")
            if path.is_file() and path.suffix.lower() in CORPUS_SUFFIXES
        )
    else:
        raise ValueError("Choose an existing text/code file or folder.")

    if not files:
        raise ValueError("No supported text or code files were found.")

    chunks: list[bytes] = []
    total = 0
    for path in files:
        try:
            file_size = path.stat().st_size
            if total + file_size > MAX_CORPUS_BYTES:
                raise ValueError("The selected corpus exceeds the 100 MiB limit.")
            chunk = path.read_bytes()
        except OSError as error:
            raise ValueError(f"Could not read corpus file {path}: {error}") from error
        total += len(chunk)
        if total > MAX_CORPUS_BYTES:
            raise ValueError("The selected corpus exceeds the 100 MiB limit.")
        chunks.append(chunk + b"\n")
    corpus = b"".join(chunks)
    if len(corpus) < 2:
        raise ValueError("The corpus must contain at least two bytes.")
    return corpus


def train_model(
    source: Path,
    checkpoint_path: Path,
    *,
    steps: int = 500,
    batch_size: int = 16,
    learning_rate: float = 3e-4,
    progress: Callable[[int, float], None] | None = None,
    config: ModelConfig | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> float:
    """Train on a corpus file or folder and save to ``checkpoint_path``.

    An existing checkpoint is continued; otherwise a new randomly initialized model with
    ``config`` (or the default configuration) is created.
    """
    return train_on_bytes(
        read_corpus(source),
        checkpoint_path,
        steps=steps,
        batch_size=batch_size,
        learning_rate=learning_rate,
        progress=progress,
        config=config,
        should_stop=should_stop,
    )


def train_on_bytes(
    corpus_data: bytes,
    checkpoint_path: Path,
    *,
    steps: int = 500,
    batch_size: int = 16,
    learning_rate: float = 3e-4,
    progress: Callable[[int, float], None] | None = None,
    config: ModelConfig | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> float:
    if steps < 1:
        raise ValueError("Training steps must be at least 1.")
    if batch_size < 1:
        raise ValueError("Batch size must be at least 1.")

    corpus_bytes = bytearray(corpus_data)
    if not corpus_bytes:
        raise ValueError("The corpus is empty.")
    corpus = torch.frombuffer(corpus_bytes, dtype=torch.uint8)
    previous_step = 0
    if checkpoint_path.exists():
        model = load_model(checkpoint_path)
        config = model.config
        previous_step = checkpoint_step(checkpoint_path)
    else:
        config = config or ModelConfig()
        model = create_random_model(config)

    if len(corpus) < 2:
        raise ValueError("The corpus must contain at least two bytes.")
    if len(corpus) <= config.block_size:
        # Small corpora (for example a handful of new conversation turns) are repeated so that
        # a full context window can be sampled. The model still only sees the user's own text.
        repeats = config.block_size // len(corpus) + 2
        corpus_bytes = bytearray(bytes(corpus_bytes) * repeats)
        corpus = torch.frombuffer(corpus_bytes, dtype=torch.uint8)

    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate)
    model.train()
    loss_value = math.nan
    completed = 0
    for step in range(1, steps + 1):
        if should_stop is not None and should_stop():
            break
        starts = torch.randint(0, len(corpus) - config.block_size, (batch_size,))
        inputs = torch.stack(
            [corpus[start : start + config.block_size] for start in starts]
        ).long()
        targets = torch.stack(
            [corpus[start + 1 : start + config.block_size + 1] for start in starts]
        ).long()
        _, loss = model(inputs, targets)
        if loss is None:
            raise RuntimeError("The model did not return a training loss.")
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        loss_value = float(loss.detach())
        completed = step
        if progress is not None:
            progress(step, loss_value)

    save_model(model, checkpoint_path, step=previous_step + completed)
    return loss_value


def checkpoint_step(checkpoint_path: Path) -> int:
    try:
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    except (OSError, RuntimeError, ValueError, EOFError, pickle.UnpicklingError):
        return 0
    step = checkpoint.get("step", 0) if isinstance(checkpoint, dict) else 0
    return int(step) if isinstance(step, int) else 0


@torch.inference_mode()
def evaluate_model(model: TinyLanguageModel, corpus_data: bytes, *, max_windows: int = 64) -> dict[str, float]:
    """Average next-byte loss over evenly spaced, deterministic windows of ``corpus_data``.

    Lower is better. The same data always yields the same windows, so two checkpoints can be
    compared fairly on a held-out set.
    """
    block_size = model.config.block_size
    if len(corpus_data) < 2:
        raise ValueError("The evaluation corpus must contain at least two bytes.")
    data = torch.tensor(list(corpus_data), dtype=torch.long)
    window = min(block_size, len(data) - 1)
    last_start = len(data) - window - 1
    count = max(1, min(max_windows, last_start + 1))
    starts = sorted({round(i * last_start / max(1, count - 1)) for i in range(count)}) if last_start > 0 else [0]
    was_training = model.training
    model.eval()
    total_loss = 0.0
    try:
        for start in starts:
            inputs = data[start : start + window].unsqueeze(0)
            targets = data[start + 1 : start + window + 1].unsqueeze(0)
            _, loss = model(inputs, targets)
            total_loss += float(loss) if loss is not None else math.nan
    finally:
        model.train(was_training)
    average = total_loss / len(starts)
    return {
        "loss": average,
        "perplexity": math.exp(min(average, 50.0)),
        "bytesEvaluated": float(len(starts) * window),
    }


def config_to_public(config: ModelConfig) -> dict[str, int]:
    """Configuration in the camelCase shape the API and web console use."""
    return {
        "blockSize": config.block_size,
        "layers": config.n_layer,
        "heads": config.n_head,
        "embeddingSize": config.n_embd,
    }


def config_from_public(values: dict[str, int] | None) -> ModelConfig:
    values = values or {}
    default = ModelConfig()
    config = ModelConfig(
        block_size=int(values.get("blockSize", default.block_size)),
        n_layer=int(values.get("layers", default.n_layer)),
        n_head=int(values.get("heads", default.n_head)),
        n_embd=int(values.get("embeddingSize", default.n_embd)),
    )
    config.validate()
    return config
