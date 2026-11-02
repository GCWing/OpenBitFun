# MiniApp 参考样例

这些目录是 `miniapp-dev` skill 自带的参考样例。

使用方式：

- 优先只读最贴近任务的一两个目录
- 看结构时先读 `meta.json`、`index.html`、`style.css`、`ui.js`
- 需要拆分范例时再看 `demo-git-graph/source/ui/*` 与 `source/styles/*`

源码感知与业务操作优先参考 `builtin-regex-playground/ui.js`：

- `observeBusinessState` 从当前实例读取输入、错误、匹配与选择，长内容显式标记截断。
- `updateInputs` 是 UI 和 Agent 共用的局部更新函数；省略字段不覆盖。
- `app.agent.expose()` 暴露 `set-input`、`apply-pattern`、`select-match`，返回结果状态。
- 示例：保留用户输入的测试文本，调用 `{ type: 'apply-pattern', id: 'email' }`，
  再调用 `{ type: 'set-input', input: { replacement: '[email]' } }` 得到替换预览。
  不修改源码、不重载，也不需要截图或模拟点击。
