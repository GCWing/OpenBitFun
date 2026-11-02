# 轻抠 / Background Remover

给图标、Logo 去掉纯色或近似纯色背景，下载真正带 Alpha 通道的透明 PNG。
所有像素处理都在当前打开页面的设备上完成；不上传图片，不加载模型，不需要网络、账号或 Node Worker。

## 使用

在仓库根目录运行：

```sh
node MiniApp/Demo/background-remover/source/build.mjs
```

打开仓库根目录下生成的 `output/miniapps/background-remover.html` 即可离线使用，无需启动服务器。

1. 点击上传、拖入或粘贴一张 PNG、JPG、WebP 图片。
2. 自动读取图片边缘的主要背景颜色，并显示抠图结果。棋盘格代表真实透明。
3. 背景未去干净时，在原图上点击背景取色，或调整颜色容差和边缘柔化。
4. 点击「下载透明 PNG」，保留原图像素尺寸。对比底色只改变预览。

默认只移除与图片四边连通的背景，保留主体内部同色区域。
需要去掉字母、镂空区域内的背景时，取消勾选该选项；这也可能移除主体内部的同色内容。
对已有透明边缘的图片，自动模式先保留原图，手动取色后可继续处理。

最大输入为 30 MiB、1600 万像素，单边不超过 8192 像素；超限会明确提示，不会自动缩图。
适合简单背景；复杂照片、已经烘焙进图片的棋盘格、与背景相连的同色主体无法可靠分离。
容差过大可能清空图片，此时禁用导出并提示调整设置。

## OpenBitFun MiniApp

**源码文件夹和独立 HTML 不会自动出现在应用列表里，需要先导入。**

在 OpenBitFun 中打开 Mini Apps，点击「导入小应用」→「从文件夹导入」，
选择本目录 `MiniApp/Demo/background-remover`（含 `meta.json` 的目录，不是 `source` 子目录）。
客户端会完成安装、编译并更新应用列表；无需把它改成内置应用，也无需重新构建客户端。

也可以在构建后生成安装包：

```sh
python3 MiniApp/Demo/background-remover/source/package.py
```

然后在「导入小应用」菜单中导入 `output/miniapps/background-remover.bfminiapp`，
查看权限并确认。安装包不会发布到市场。

本目录同时包含标准 `meta.json`、`source/index.html`、`source/style.css`、`source/ui.js`、
`source/worker.js` 和空的 `source/esm_dependencies.json`。
宿主应通过标准 MiniApp 创建／导入流程读取这些源码并编译；不要把独立 HTML 复制为 `compiled.html`。
本次交付未调用宿主 `InitMiniApp` / `FinalizeMiniApp`，未安装到用户的 Mini App 列表。

仅申请 `{user-selected}` 写权限，用于 `app.dialog.save` 选择位置后保存 PNG。
图片输入来自页面文件选择器、拖拽或粘贴，不读取工作区、宿主路径或任意目录。
在 OpenBitFun 中保存使用 `app.fs.writeFile`；独立 HTML 使用页面下载。
不支持文件保存的宿主会显示明确提示。
随宿主切换明暗主题和中英文；独立版也提供语言和主题切换。

## 开发与验证

```sh
node MiniApp/Demo/background-remover/source/build.mjs
node --test MiniApp/Demo/background-remover/tests/*.test.mjs
pnpm run theme:color-audit:all
```

编辑 `source/ui/*.js` 后重新构建，`source/ui.js` 为生成入口。
算法测试覆盖背景识别、边缘连通、封闭区域、既有透明度、柔化和去色边、取消处理。
未使用浏览器控制或 Computer Use 验证界面。

远程场景：本应用不调用工作区、Agent Runtime 或命令执行接口，像素处理不依赖宿主文件系统。
远程工作区、远程控制、Peer Device Mode 和 Detached Dispatch 均未做端到端验证；
不据本地算法测试宣称这些宿主支持图片上传、保存或独立运行界面。

## English

Build using the command above, then open `output/miniapps/background-remover.html` from the repository root locally.
Upload, drop, or paste an icon, pick its background color if necessary, adjust tolerance and edge softness,
and download a transparent PNG at the original resolution. Processing stays on the viewing device.
Edge-connected removal preserves enclosed foreground regions; disable it to remove matching colors inside holes.
This tool targets solid or near-solid backgrounds rather than complex photographic segmentation.
