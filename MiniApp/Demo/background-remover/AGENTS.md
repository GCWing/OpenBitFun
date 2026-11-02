# Background Remover MiniApp

Run the focused checks from the repository root:

```sh
node MiniApp/Demo/background-remover/source/build.mjs
python3 MiniApp/Demo/background-remover/source/package.py
node --test MiniApp/Demo/background-remover/tests/*.test.mjs
```

After UI or color changes, also run `pnpm run theme:color-audit:all`.
Edit `source/ui/*.js`, then rebuild the generated `source/ui.js` bundle.
The standalone HTML is generated under repository-level ignored `output/miniapps/`, separate from host-owned `compiled.html`.
Do not use Computer Use or browser control for verification unless the user asks.
