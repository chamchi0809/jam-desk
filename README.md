<img width="686" height="512" alt="image" src="https://github.com/user-attachments/assets/86ea04da-56fc-4bbb-9603-9f022be846f0" />

# Jam Desk — Infinite Canvas for VS Code and your AI agents

[Marketplace Link](https://marketplace.visualstudio.com/items?itemName=chamchi.jam-desk)

An infinite canvas for running **terminals and coding agents side by side**.
Spawn shell terminals as cards, run Claude Code / Codex / Gemini CLI in each,
and arrange them spatially.

## Quick start

1. Install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=chamchi.jam-desk).
2. Run **“Jam Desk: Open Canvas”** (command palette or editor tab bar button).
3. Hit the **Claude** or **Codex** toolbar button to open a terminal with the
   agent already running (or add a plain terminal and launch it yourself).
4. Add more terminals, notes, and file cards — group them into regions, and
   tile them with the 2-split / 3-split / 2×2 layout buttons.

## Terminals & coding agents

- **Real terminals** — each card is a full PTY shell (node-pty + xterm.js),
  spawned in your workspace folder. TUI agents work.
- **Many agents, one surface** — no more digging through terminal tabs;
  zoom out to watch all agents, zoom in to drive one.
- **Live agent status** — auto-detects Claude Code / Codex per terminal and
  shows the session title plus an animated idle / working / waiting badge
  on the card title and minimap.
- **Shift+Enter just works** — converted to `\` + Enter, so it inserts a
  newline in Claude Code instead of submitting.
- **Terminal scroll** — the wheel scrolls output over a terminal card,
  zooms the canvas elsewhere.
- **Theme-aware** — follows your VS Code terminal colors and font.

## Organize around your agents

- **Notes** — free-text cards for prompts, plans, and TODOs.
- **File cards** — point at workspace files; open them in the editor.
- **Regions** — labeled, colored groups that move and resize as a unit.
- **Canvas mechanics** — smooth zoom, inertia panning, snapping with
  alignment guides, marquee selection, minimap, auto-layout, undo/redo.
- **Persistence** — auto-saved per workspace; JSON export / import.

## Shortcuts

| Action                          | Shortcut / control                           |
| ------------------------------- | -------------------------------------------- |
| Add terminal / note / file card | toolbar, or right-click                      |
| Launch Claude Code / Codex      | toolbar (one-click terminal + agent)         |
| Zoom                            | mouse wheel, ⌘/Ctrl + scroll                 |
| Pan                             | trackpad, right/middle-drag, or hold `Space` |
| Fit to screen                   | `Shift+1`                                    |
| Group into region               | toolbar ▢                                    |
| Auto-layout                     | toolbar ▦                                    |
| Tile 2-split / 3-split / 2×2    | toolbar (tiles selection, else all cards)    |
| Undo / redo                     | `⌘/Ctrl+Z` / `⌘/Ctrl+Shift+Z`                |

## Development

```bash
npm install
npm run watch   # rebuild on change
```

Press `F5` to launch an Extension Development Host, then run
**“Jam Desk: Open Canvas”**.

## Credits

Canvas mechanics inspired by the
[Cate IDE](https://github.com/0-AI-UG/cate). Licensed under MIT.
