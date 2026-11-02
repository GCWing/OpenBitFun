# Git scene presentation

Follow the Web UI guide. Repository state and operation routing stay in `tools/git`;
keep workspace identity explicit and use `gitSceneStore` for history/branch navigation.

For working-copy empty states, clean/unpublished commits, conflict visibility,
and repository identity, run from the repository root:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/git/views/WorkingCopyView.test.tsx
pnpm run check:web
```

These DOM fixtures use mocked host calls. They do not establish live SSH or Peer behavior.
For refresh or state ownership changes, also follow `src/web-ui/src/tools/git/AGENTS.md`.
