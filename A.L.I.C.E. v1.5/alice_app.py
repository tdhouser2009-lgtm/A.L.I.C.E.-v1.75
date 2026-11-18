"""A.L.I.C.E. desktop app: chat with your own from-scratch model that learns as you use it.

Run ``python alice_app.py`` (or the packaged binary). ``--selftest`` checks the model and storage
without opening a window, which the build workflow uses to verify packaged binaries.
"""

from __future__ import annotations

import argparse
import sys
import threading
import tkinter as tk
import uuid
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk
from typing import Any, Callable

from alice import __version__
from alice.brain import AliceBrain, LearningBusy, default_home

APP_TITLE = "A.L.I.C.E."
CONSENT_TEXT = (
    "A.L.I.C.E. starts as a brand-new, untrained model. At first her replies will be gibberish; "
    "she improves by learning from your conversations and corrections.\n\n"
    "Allow A.L.I.C.E. to learn from your conversations on this computer?\n\n"
    "- Conversations and the model stay on this computer.\n"
    "- Nothing is shared unless you export a bundle or turn on sync.\n"
    "- You can change this any time in Settings."
)


class AliceApp:
    def __init__(self, root: tk.Tk, brain: AliceBrain) -> None:
        self.root = root
        self.brain = brain
        self.conversation_id = str(uuid.uuid4())
        self.last_turn_id: str | None = None
        self.busy = False
        self.status = tk.StringVar(value="Loading A.L.I.C.E.…")
        self.model_label = tk.StringVar(value="")
        self.root.title(APP_TITLE)
        self.root.geometry("980x720")
        self.root.minsize(720, 520)
        self._build_ui()
        self.root.after(50, self._startup)

    # ───── UI ─────

    def _build_ui(self) -> None:
        menu = tk.Menu(self.root)
        model_menu = tk.Menu(menu, tearoff=False)
        model_menu.add_command(label="Learn now", command=self.learn_now)
        model_menu.add_command(label="Model versions…", command=self.show_versions)
        model_menu.add_separator()
        model_menu.add_command(label="Warm start (optional starter lessons)…", command=self.warm_start)
        model_menu.add_separator()
        model_menu.add_command(label="Export model and conversations…", command=self.export_bundle)
        model_menu.add_command(label="Import bundle…", command=self.import_bundle)
        menu.add_cascade(label="Model", menu=model_menu)
        settings_menu = tk.Menu(menu, tearoff=False)
        settings_menu.add_command(label="Learning and privacy…", command=self.show_settings)
        settings_menu.add_command(label="Sync (optional)…", command=self.show_sync)
        menu.add_cascade(label="Settings", menu=settings_menu)
        help_menu = tk.Menu(menu, tearoff=False)
        help_menu.add_command(label="About", command=self.show_about)
        menu.add_cascade(label="Help", menu=help_menu)
        self.root.configure(menu=menu)

        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(1, weight=1)
        header = ttk.Frame(self.root, padding=(12, 10, 12, 6))
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(1, weight=1)
        ttk.Label(header, text=APP_TITLE, font=("TkDefaultFont", 16, "bold")).grid(row=0, column=0, sticky="w", padx=(0, 16))
        ttk.Label(header, textvariable=self.model_label).grid(row=0, column=1, sticky="w")
        self.new_chat_button = ttk.Button(header, text="New chat", command=self.new_chat)
        self.new_chat_button.grid(row=0, column=2)

        conversation = ttk.Frame(self.root, padding=(12, 0, 12, 6))
        conversation.grid(row=1, column=0, sticky="nsew")
        conversation.columnconfigure(0, weight=1)
        conversation.rowconfigure(0, weight=1)
        self.transcript = tk.Text(conversation, wrap=tk.WORD, state=tk.DISABLED, padx=10, pady=10)
        self.transcript.grid(row=0, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(conversation, orient=tk.VERTICAL, command=self.transcript.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.transcript.configure(yscrollcommand=scrollbar.set)
        self.transcript.tag_configure("speaker", font=("TkDefaultFont", 10, "bold"))
        self.transcript.tag_configure("user", foreground="#155e75")
        self.transcript.tag_configure("assistant", foreground="#1f2937")
        self.transcript.tag_configure("note", foreground="#6b7280")
        self.transcript.tag_configure("error", foreground="#b91c1c")

        feedback = ttk.Frame(self.root, padding=(12, 0, 12, 4))
        feedback.grid(row=2, column=0, sticky="ew")
        ttk.Label(feedback, text="Last reply:").grid(row=0, column=0, padx=(0, 6))
        self.up_button = ttk.Button(feedback, text="Good reply", command=lambda: self.rate("up"), state=tk.DISABLED)
        self.up_button.grid(row=0, column=1, padx=2)
        self.down_button = ttk.Button(feedback, text="Bad reply", command=lambda: self.rate("down"), state=tk.DISABLED)
        self.down_button.grid(row=0, column=2, padx=2)
        self.correct_button = ttk.Button(feedback, text="Teach the right answer...", command=self.correct, state=tk.DISABLED)
        self.correct_button.grid(row=0, column=3, padx=2)

        composer = ttk.LabelFrame(self.root, text="Message", padding=8)
        composer.grid(row=3, column=0, sticky="ew", padx=12, pady=(0, 8))
        composer.columnconfigure(0, weight=1)
        self.input = tk.Text(composer, height=4, wrap=tk.WORD)
        self.input.grid(row=0, column=0, columnspan=2, sticky="ew")
        self.input.bind("<Control-Return>", self._send_shortcut)
        ttk.Label(composer, text="Ctrl+Enter to send · Runs entirely on this computer.").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.send_button = ttk.Button(composer, text="Send", command=self.send_message)
        self.send_button.grid(row=1, column=1, sticky="e", padx=(8, 0), pady=(4, 0))
        ttk.Label(self.root, textvariable=self.status, anchor="w").grid(row=4, column=0, sticky="ew", padx=14, pady=(0, 9))

    def _append(self, speaker: str, text: str, tag: str) -> None:
        self.transcript.configure(state=tk.NORMAL)
        if speaker:
            self.transcript.insert(tk.END, f"{speaker}\n", ("speaker", tag))
        self.transcript.insert(tk.END, f"{text.strip()}\n\n", tag)
        self.transcript.configure(state=tk.DISABLED)
        self.transcript.see(tk.END)

    def _set_busy(self, busy: bool, status: str) -> None:
        self.busy = busy
        state = tk.DISABLED if busy else tk.NORMAL
        self.send_button.configure(state=state)
        self.new_chat_button.configure(state=state)
        self.status.set(status)

    def _feedback_state(self, enabled: bool) -> None:
        for button in (self.up_button, self.down_button, self.correct_button):
            button.configure(state=tk.NORMAL if enabled else tk.DISABLED)

    def _background(self, work: Callable[[], Any], done: Callable[[Any], None], status: str) -> None:
        self._set_busy(True, status)

        def run() -> None:
            try:
                result = work()
            except Exception as error:  # noqa: BLE001 - shown to the user
                self.root.after(0, self._failed, str(error))
            else:
                self.root.after(0, done, result)

        threading.Thread(target=run, daemon=True).start()

    def _failed(self, message: str) -> None:
        self._set_busy(False, "Something went wrong.")
        self._append("", message, "error")

    def _refresh_model_label(self) -> None:
        status = self.brain.status()
        active = status["active"]
        learning = "learning on" if status["learningEnabled"] else "learning off"
        self.model_label.set(
            f"Model {active['id']} · {status['parameters']:,} parameters · {status['turns']} turns stored · "
            f"{status['unlearned']} waiting to learn · {learning}"
        )

    # ───── Startup and consent ─────

    def _startup(self) -> None:
        def work() -> None:
            self.brain.ensure_model()
            self.brain.model()

        def done(_: Any) -> None:
            self._set_busy(False, "Ready.")
            self._refresh_model_label()
            if not self.brain.store.get_setting("consent_asked"):
                allow = messagebox.askyesno("Let A.L.I.C.E. learn?", CONSENT_TEXT, parent=self.root)
                self.brain.store.set_setting("consent_asked", True)
                self.brain.store.set_setting("learning_enabled", bool(allow))
                self._refresh_model_label()
            active = self.brain.store.active_checkpoint()
            if active and active["source"] == "initial":
                self._append("", "This model is untrained, so expect gibberish at first. Teach A.L.I.C.E. with Good/Bad feedback and "
                             "corrections, or use Model → Warm start for optional starter lessons.", "note")

        self._background(work, done, "Loading A.L.I.C.E.'s model…")

    # ───── Chat ─────

    def _send_shortcut(self, _event: tk.Event) -> str:
        self.send_message()
        return "break"

    def send_message(self) -> None:
        if self.busy:
            return
        prompt = self.input.get("1.0", tk.END).strip()
        if not prompt:
            return
        self._append("You", prompt, "user")
        self.input.delete("1.0", tk.END)
        self._feedback_state(False)
        conversation_id = self.conversation_id

        def done(result: tuple[str, str]) -> None:
            self.last_turn_id, text = result
            self._append("A.L.I.C.E.", text, "assistant")
            self._feedback_state(True)
            self._set_busy(False, "Reply generated locally by A.L.I.C.E.'s own model.")
            self._refresh_model_label()
            self._maybe_auto_learn()

        self._background(lambda: self.brain.reply(conversation_id, prompt), done, "A.L.I.C.E. is thinking…")

    def rate(self, rating: str) -> None:
        if self.last_turn_id:
            self.brain.store.rate_turn(self.last_turn_id, rating)
            self.status.set("Thanks — feedback saved." if rating == "up" else "Noted. Teach the right answer to help her learn.")

    def correct(self) -> None:
        if not self.last_turn_id:
            return
        answer = simpledialog.askstring("Teach A.L.I.C.E.", "What should A.L.I.C.E. have said?", parent=self.root)
        if answer and answer.strip():
            self.brain.store.rate_turn(self.last_turn_id, "down", answer.strip())
            self._append("You taught", answer, "note")
            self.status.set("Correction saved. A.L.I.C.E. will learn it in her next learning run.")

    def new_chat(self) -> None:
        if self.busy:
            return
        self.conversation_id = str(uuid.uuid4())
        self.last_turn_id = None
        self._feedback_state(False)
        self.transcript.configure(state=tk.NORMAL)
        self.transcript.delete("1.0", tk.END)
        self.transcript.configure(state=tk.DISABLED)
        self.status.set("New conversation.")

    # ───── Learning ─────

    def _maybe_auto_learn(self) -> None:
        every = int(self.brain.store.get_setting("auto_learn_every") or 0)
        if self.brain.store.get_setting("learning_enabled") and every > 0 and self.brain.unlearned_count() >= every:
            threading.Thread(target=self._quiet_learn, daemon=True).start()

    def _quiet_learn(self) -> None:
        try:
            result = self.brain.learn()
        except LearningBusy:
            return
        except Exception as error:  # noqa: BLE001
            self.root.after(0, self.status.set, f"Background learning failed: {error}")
            return
        self.root.after(0, self._learned, result)

    def _learned(self, result: dict[str, Any]) -> None:
        self._set_busy(False, self._describe_learning(result))
        self._refresh_model_label()

    @staticmethod
    def _describe_learning(result: dict[str, Any]) -> str:
        if result.get("status") == "skipped":
            return result.get("reason", "Nothing new to learn.")
        comparison = result["comparison"]
        before, after = comparison["active"]["loss"], comparison["candidate"]["loss"]
        verdict = {"promoted": "now active", "kept-for-review": "saved for review", "not-better": "not better, kept old model"}
        return f"Learned: held-out loss {before:.3f} → {after:.3f} ({verdict.get(result['decision'], result['decision'])})."

    def _progress(self, step: int, total: int, loss: float) -> None:
        self.root.after(0, self.status.set, f"Learning… step {step}/{total}, loss {loss:.3f}")

    def learn_now(self) -> None:
        if self.busy:
            return
        if not self.brain.store.get_setting("learning_enabled"):
            messagebox.showinfo(APP_TITLE, "Turn on learning in Settings → Learning and privacy first.", parent=self.root)
            return
        self._background(lambda: self.brain.learn(progress=self._progress), self._learned, "Learning…")

    def warm_start(self) -> None:
        if self.busy:
            return
        if not messagebox.askyesno(
            "Warm start",
            "Train A.L.I.C.E. on a small built-in set of starter conversations (written for this project) so she "
            "learns the basic shape of a reply. This is optional; your current model stays available to restore.",
            parent=self.root,
        ):
            return
        self._background(lambda: self.brain.warm_start(progress=self._progress), self._learned, "Warm start…")

    # ───── Versions ─────

    def show_versions(self) -> None:
        window = tk.Toplevel(self.root)
        window.title("Model versions")
        window.geometry("900x380")
        columns = ("status", "source", "loss", "created", "note")
        tree = ttk.Treeview(window, columns=columns, show="tree headings")
        tree.heading("#0", text="Version")
        for column, title, width in zip(columns, ("Status", "Source", "Held-out loss", "Created", "Note"), (80, 90, 100, 160, 300)):
            tree.heading(column, text=title)
            tree.column(column, width=width)
        tree.column("#0", width=260)
        tree.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        def load() -> None:
            tree.delete(*tree.get_children())
            for row in self.brain.store.checkpoints():
                loss = "" if row["holdout_loss"] is None else f"{row['holdout_loss']:.3f}"
                tree.insert("", tk.END, iid=row["id"], text=row["id"], values=(row["status"], row["source"], loss, row["created_at"], row["note"] or ""))

        def act(action: Callable[[str], None]) -> None:
            selected = tree.selection()
            if not selected:
                return
            try:
                action(selected[0])
            except ValueError as error:
                messagebox.showerror("Model versions", str(error), parent=window)
            load()
            self._refresh_model_label()

        buttons = ttk.Frame(window, padding=8)
        buttons.pack(fill=tk.X)
        ttk.Button(buttons, text="Make active (promote)", command=lambda: act(self.brain.promote)).pack(side=tk.LEFT)
        ttk.Button(buttons, text="Restore earlier version (rollback)", command=lambda: act(self.brain.rollback)).pack(side=tk.LEFT, padx=6)
        ttk.Button(buttons, text="Reject candidate", command=lambda: act(self.brain.reject)).pack(side=tk.LEFT)
        load()

    # ───── Export / import ─────

    def export_bundle(self) -> None:
        path = filedialog.asksaveasfilename(parent=self.root, defaultextension=".alice", filetypes=[("A.L.I.C.E. bundle", "*.alice")])
        if path:
            self._background(lambda: self.brain.export_bundle(Path(path)), lambda p: self._set_busy(False, f"Exported to {p}."), "Exporting…")

    def import_bundle(self) -> None:
        path = filedialog.askopenfilename(parent=self.root, filetypes=[("A.L.I.C.E. bundle", "*.alice *.zip")])
        if path:
            def done(result: dict[str, Any]) -> None:
                self._set_busy(False, f"Imported {result['turns']} turns" + (f" and model {result['checkpointId']} (as a candidate)." if result["checkpointId"] else "."))
                self._refresh_model_label()
            self._background(lambda: self.brain.import_bundle(Path(path)), done, "Importing…")

    # ───── Settings ─────

    def show_settings(self) -> None:
        store = self.brain.store
        window = tk.Toplevel(self.root)
        window.title("Learning and privacy")
        learning = tk.BooleanVar(value=bool(store.get_setting("learning_enabled")))
        auto_promote = tk.BooleanVar(value=bool(store.get_setting("auto_promote")))
        every = tk.IntVar(value=int(store.get_setting("auto_learn_every") or 0))
        steps = tk.IntVar(value=int(store.get_setting("learning_steps") or 150))
        frame = ttk.Frame(window, padding=12)
        frame.pack(fill=tk.BOTH, expand=True)
        ttk.Checkbutton(frame, text="Learn from my conversations on this computer", variable=learning).grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(frame, text="Learn automatically after this many new turns (0 = only when I click Learn now):").grid(row=1, column=0, sticky="w", pady=4)
        ttk.Spinbox(frame, from_=0, to=500, textvariable=every, width=6).grid(row=1, column=1, sticky="w")
        ttk.Label(frame, text="Training steps per learning run:").grid(row=2, column=0, sticky="w", pady=4)
        ttk.Spinbox(frame, from_=10, to=5000, textvariable=steps, width=6).grid(row=2, column=1, sticky="w")
        ttk.Checkbutton(frame, text="Automatically use a new version when it scores at least as well on held-out conversations", variable=auto_promote).grid(row=3, column=0, columnspan=2, sticky="w")
        ttk.Label(frame, text=f"Data folder: {self.brain.home}", foreground="#6b7280").grid(row=4, column=0, columnspan=2, sticky="w", pady=(8, 0))

        def save() -> None:
            store.set_setting("learning_enabled", learning.get())
            store.set_setting("auto_promote", auto_promote.get())
            store.set_setting("auto_learn_every", max(0, every.get()))
            store.set_setting("learning_steps", max(10, steps.get()))
            store.set_setting("consent_asked", True)
            self._refresh_model_label()
            window.destroy()

        def forget() -> None:
            if messagebox.askyesno("Delete conversations", "Delete every stored conversation? Model versions are kept.", parent=window):
                store.delete_all_conversations()
                self._refresh_model_label()

        buttons = ttk.Frame(frame)
        buttons.grid(row=5, column=0, columnspan=2, sticky="e", pady=(12, 0))
        ttk.Button(buttons, text="Delete all conversations…", command=forget).pack(side=tk.LEFT, padx=6)
        ttk.Button(buttons, text="Save", command=save).pack(side=tk.LEFT)

    def show_sync(self) -> None:
        store = self.brain.store
        window = tk.Toplevel(self.root)
        window.title("Sync (optional)")
        enabled = tk.BooleanVar(value=bool(store.get_setting("sync_enabled")))
        url = tk.StringVar(value=str(store.get_setting("sync_url") or ""))
        token = tk.StringVar(value=str(store.get_setting("sync_token") or ""))
        frame = ttk.Frame(window, padding=12)
        frame.pack(fill=tk.BOTH, expand=True)
        ttk.Label(frame, text="Sync is off by default. When on, you choose when to share consented turns or pull a model\n"
                              "from a self-hosted A.L.I.C.E. server (the web console's API with SYNC_ENABLED=true).", foreground="#6b7280").grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Checkbutton(frame, text="Enable sync", variable=enabled).grid(row=1, column=0, sticky="w", pady=6)
        ttk.Label(frame, text="Server address (https://…)").grid(row=2, column=0, sticky="w")
        ttk.Entry(frame, textvariable=url, width=50).grid(row=2, column=1, sticky="ew")
        ttk.Label(frame, text="Sync token").grid(row=3, column=0, sticky="w")
        ttk.Entry(frame, textvariable=token, width=50, show="*").grid(row=3, column=1, sticky="ew")

        def save() -> None:
            store.set_setting("sync_enabled", enabled.get())
            store.set_setting("sync_url", url.get().strip())
            store.set_setting("sync_token", token.get().strip())

        def push() -> None:
            save()
            self._background(self.brain.sync_push, lambda n: self._set_busy(False, f"Shared {n} consented turns."), "Sharing…")

        def pull() -> None:
            save()
            self._background(self.brain.sync_pull, lambda cid: self._set_busy(False, f"Downloaded model {cid} as a candidate; review it in Model versions." if cid else "The server has no promoted model yet."), "Downloading…")

        buttons = ttk.Frame(frame)
        buttons.grid(row=4, column=0, columnspan=2, sticky="e", pady=(12, 0))
        ttk.Button(buttons, text="Share my consented turns", command=push).pack(side=tk.LEFT)
        ttk.Button(buttons, text="Pull latest model", command=pull).pack(side=tk.LEFT, padx=6)
        ttk.Button(buttons, text="Save", command=lambda: (save(), window.destroy())).pack(side=tk.LEFT)

    def show_about(self) -> None:
        messagebox.showinfo(APP_TITLE, f"A.L.I.C.E. v{__version__}\nYour own from-scratch model that learns as you use it.\nData folder: {self.brain.home}", parent=self.root)


def selftest(home: Path) -> int:
    """Headless check used by CI: create a model, reply, learn a little, and export."""
    from local_model import ModelConfig

    brain = AliceBrain(home, model_config=ModelConfig(block_size=32, n_layer=1, n_head=2, n_embd=16))
    brain.store.set_setting("learning_enabled", True)
    turn_id, text = brain.reply("selftest", "hello", max_new_tokens=8)
    brain.store.rate_turn(turn_id, "down", "Hello! I am Alice.")
    result = brain.learn(steps=2)
    bundle = brain.export_bundle(home / "selftest.alice")
    print(f"selftest ok: reply={text!r} learning={result['decision']} bundle={bundle.name}")
    brain.store.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="A.L.I.C.E. desktop app")
    parser.add_argument("--home", type=Path, help="Data folder (default: ~/.alice or $ALICE_HOME)")
    parser.add_argument("--selftest", action="store_true", help="Run a headless check and exit")
    args = parser.parse_args(argv)
    if args.selftest:
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            return selftest(Path(directory))
    root = tk.Tk()
    AliceApp(root, AliceBrain(args.home or default_home()))
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
