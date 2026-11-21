---
name: html-annotate
description: Create or open a local HTML page with a live annotation overlay, let the user comment in the browser, and apply comments in batches. Use when the user asks to build an HTML page and review it through annotate, or to annotate an existing local HTML.
license: MIT
metadata:
  version: "0.4"
---

# HTML Annotate

Turn a local HTML page into a review loop: the user annotates in a real browser, comments land in a file, the agent edits the HTML, marks them fixed, and the page updates.

One server instance is intended for one project/page. For a different project, use a different `--port` and `--state-dir`; see **Multiple projects**.

## Install

From the **source checkout** (the directory containing this `SKILL.md`), install once for the current user:

```bash
npx --yes skills add ./ --skill html-annotate --global --agent codex cursor claude-code --yes
```

The [Skills CLI](https://skills.sh/) installs the skill and its bundled server, JavaScript and CSS without copying files by hand. Node.js with `npx` is needed for this install command; running the skill needs Python 3.9+ on a POSIX system, not Node.js. Installation does not start a service or change the project being reviewed. Do not run the installer from the already-installed skill directory.

These targets cover Codex, Cursor and Claude Code; tools that discover `~/.agents/skills` (including omp) use the same installed copy. For another Skills CLI agent, replace the names after `--agent`. When installing from a published Git repository, use its URL instead of `./`.

The agent host needs shell access to start the server and permission to edit the target HTML. The user's browser must be able to reach that server at `127.0.0.1`.

## Workflow

1. Create or locate the HTML under the project root. If it is diagram-heavy, build it with the `diagram-design` skill first. Do not add the overlay to the file.
2. Start the local server from the project root. In the commands below, set `SKILL_DIR` to the absolute directory containing the **loaded** `SKILL.md` (use the path supplied by the agent host). This is for the agent to resolve, not a variable the user must configure.

   ```bash
   python3 "$SKILL_DIR/scripts/annotate_server.py" \
     --root "$PWD" \
     --port 8765
   ```

   `--state-dir` defaults to `<root>/.annotate`. Use a different port if 8765 is busy.
3. Give the user the URL:

   ```text
   http://127.0.0.1:8765/path/to/page.html
   ```

   The server injects `annotate.js` and `annotate.css` into every HTML response. Opening the file directly (`file://`) does not inject the overlay.

4. Optional: watch the inbox in the agent session. In this harness, start a long-lived service:

   ```bash
   mkdir -p .annotate
   touch .annotate/annotations-inbox.jsonl
   echo READY
   tail -n 0 -F .annotate/annotations-inbox.jsonl
   ```

   Use `notify` matching `"event": *"sent"`. Also check the existing inbox after starting the watcher: `tail -n 0` only reports later writes. If the host has no background notifications, tell the user to ping the agent after sending; read the inbox on that turn. After an interruption, match backlog entries against the current `sent` revisions before acting on them.

5. Press `Alt+A` (or `комм.`), click a block or select text, write a comment, and save the draft. On a narrow screen the list stays hidden while choosing a target; **Список** returns to it. Press **Отправить новые** to deliver drafts. If delivery is not confirmed, retry from the overlay; do not assume the agent received them.

   Comments preserve spaces, tabs and line breaks. The limit is 4000 Unicode code points per comment; shorten an overlong comment before saving. If **Показать** cannot identify the target after an HTML edit, check the recorded quote and section instead of assuming the first matching block is correct.

6. Read the inbox. Each line is one batch:

   ```json
   {"event":"sent","received_at":"...","annotations":[{"id":"...","sentAt":"...","page":"/page.html","selector":"...","quote":"...","comment":"..."}]}
   ```

7. Apply the requested edits to the HTML. Resolve only the exact revisions you processed, copying each `id` and `sentAt` from the inbox batch:

   ```bash
   curl -fsS -X POST http://127.0.0.1:8765/__resolve \
     -H 'Content-Type: application/json' \
     -d '{"annotations":[{"id":"ID1","sentAt":"TIMESTAMP_FROM_INBOX"}]}'
   ```

   `409` means at least one revision is no longer pending; nothing in that resolve request was changed. Read the current state and review the newer text before resolving it.

8. The active overlay polls for status changes. Reload the page to see HTML edits. Before upgrading a running server, finish or export pending browser edits; restart the server and reload open tabs together.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/__annotations` | authoritative `{version, annotations, ...}` |
| `POST` | `/__annotations` | JSON `{version, annotations}`; `409` for stale snapshots or conflicting revisions, `400` for an overlong comment, `413` for over 500 items or 2 MiB |
| `POST` | `/__resolve` | JSON `{annotations: [{id, sentAt}, ...]}`; mark the matching pending revisions `fixed` together |
| `GET` | `/__inbox` | inbox lines as JSON |
| `GET` | `/annotate.js` | overlay script |
| `GET` | `/annotate.css` | overlay styles |

## Files

```text
<root>/.annotate/annotations.json          current state, written atomically
<root>/.annotate/annotations-inbox.jsonl   append-only queue of sent batches
```

A delivered `id + sentAt` identifies one immutable revision, even after deletion or restart. Edit the comment as a draft, then send with a fresh `sentAt`. Only `/__resolve` can mark a pending revision `fixed`. On a conflict, read the authoritative snapshot; never replay an old list with a newer `version`.

## Multiple projects

The overlay and API are **single-project**: `.annotate/annotations.json` is shared by every page served by that instance. For a different HTML/project:

```bash
python3 "$SKILL_DIR/scripts/annotate_server.py" \
  --root /path/to/other-project \
  --port 8766 \
  --state-dir /path/to/other-project/.annotate
```

Then open `http://127.0.0.1:8766/...`. Each agent/instance has its own inbox and watcher. Do not point two projects at the same state directory.

For multiple pages in one project, use one instance per page or add page filtering to `annotate.js` before sharing state.

## Rules

- Use the printed `127.0.0.1` URL. Serve only a directory of trusted HTML and assets: scripts in those pages share the overlay's origin. Do not put secrets under the served root.
- Never edit the HTML to insert the overlay; the server injects it.
- Do not delete `.annotate/` while the user is reviewing.
- Keep one instance per project/page; use distinct ports and state dirs.
- If the user asks for live app screens, add ordinary links to the app; this skill only annotates static HTML.
- No npm or pip dependencies at runtime; the server uses the Python standard library.
