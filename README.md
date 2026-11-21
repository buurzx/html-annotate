# html-annotate

Review local HTML with a coding agent. Select text or a block in your browser, send a batch of comments, and let the agent edit the original file. The annotation tools are injected into the served page, not written into your HTML.

## Install once

```sh
npx --yes skills add buurzx/html-annotate --skill html-annotate --global --agent codex cursor claude-code --yes
```

The global install is shared across projects. Codex, Cursor and hosts such as omp can discover the skill in `~/.agents/skills`; the installer also links it for Claude Code. Node.js with `npx` is needed only for installation. The local server needs Python 3.9+ on a POSIX system, with no pip dependencies.

## Use

1. In the project with your HTML, ask your agent: **“Open `mockup.html` for annotation with html-annotate.”**
2. Visit the local URL. Press **Alt+A** or **комм.**, select a block, enter a comment, and save the draft. Press **Отправить новые** to send your drafts to the agent.
3. The agent reads the batch, edits the source and marks the processed revisions fixed. Reload the page to see the HTML changes.

Comments stay in the project's `.annotate/` directory. Serve trusted static pages only. The server binds to `127.0.0.1`; one review instance is intended for one page. See [SKILL.md](SKILL.md) for the protocol and multi-project setup.

## Tests

```sh
python3 -B -m unittest discover -s tests -v
```

[MIT license](LICENSE).
