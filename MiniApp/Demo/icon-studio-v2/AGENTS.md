# Icon Studio V2.0.2

From the repository root:

```sh
node MiniApp/Demo/icon-studio-v2/source/build.mjs
python3 MiniApp/Demo/icon-studio-v2/source/package.py
node --test MiniApp/Demo/icon-studio-v2/tests/*.test.mjs
```

After UI/color changes run `pnpm run theme:color-audit:all`.
Edit `source/ui/*.js`, then regenerate `source/ui.js`. Deliverables go under
ignored `output/miniapps/`. Do not write host-managed `compiled.html` or install
by modifying user data. Use the host importer for the generated `.bfminiapp`.
Do not use Computer Use or browser control for verification unless requested.
