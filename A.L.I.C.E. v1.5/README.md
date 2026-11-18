# Local Assistant

This project includes a local instruction-following assistant with coding help. Chat inference runs through [Ollama](https://ollama.com/) and a model installed on this computer. The desktop GUI does not send prompts to a hosted model and does not execute generated code.

The default model is `qwen2.5:3b`. This workspace already has it installed. Ollama must be installed and running before using the assistant. If the model is not installed on another computer, run:

```sh
ollama pull qwen2.5:3b
```

You can install a code-specialized model and select it in the GUI as well:

```sh
ollama pull qwen2.5-coder:3b
```

The current Qwen 3B variants are listed under the Qwen Research License. Review the model's license before redistributing the app or using it commercially.

## Open the desktop assistant

Double-click [`LocalAssistant.desktop`](./LocalAssistant.desktop), or run:

```sh
./scripts/launch-local-assistant.sh
```

The launcher starts Ollama if needed and opens [`local_assistant_gui.py`](./local_assistant_gui.py). Choose an installed model and use **Coding** mode for code-focused answers. The desktop conversation stays in memory and is cleared when you start a new chat or close the app.

You can also run the GUI directly after starting Ollama:

```sh
python3 local_assistant_gui.py
```

## Local web assistant

The web chat uses the same Ollama model through the model worker. Copy `.env.example` to `.env`, make sure PostgreSQL, Azurite, and Ollama are running, then start the API, worker, and web development tasks in VS Code. The default settings are:

```env
MODEL_INFERENCE_BACKEND=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
```

Conversation history is sent to the local model with the latest user message. The assistant can explain, write, and review code, but generated code is not executed and may be incorrect.

## Separate scratch-model training

[`app.py`](./app.py) and [`local_model.py`](./local_model.py) are a separate educational experiment: a tiny byte-level Transformer initialized from random weights. Run `python3 app.py` to open its training GUI and select a `.txt`/`.md` corpus or source-code folder.

That training workflow does **not** fine-tune the Ollama LLM and does not produce an instruction-following coding model. It trains the small scratch model to continue text. Its default checkpoint is `~/.local-model/tiny-transformer.pt`; corpora must exceed 128 bytes and are limited to 100 MiB.

## Requirements

- Ollama with a local model for assistant chat.
- Python 3 and Tkinter for the desktop GUI.
- Python 3.10 or newer and PyTorch 2.0 or newer only for the optional scratch-model trainer and Python worker bridge.
- Node.js and npm for the web application, API, and worker.

The local Ollama API uses a 4,096-token context by default to keep memory usage bounded. Larger models and longer contexts require more memory and can run slowly on CPU-only computers.
