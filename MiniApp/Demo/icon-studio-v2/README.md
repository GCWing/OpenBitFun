# 图标工坊 / Icon Studio V2.0.2

从单色位图开始，描摹像素轮廓、编辑矢量节点，再绘制适合应用内使用的 SVG 图标。
这是独立的 V2.0.2 小应用，保留原有「轻抠」工具。无需网络、模型、账号或 Node Worker。

## 运行与安装

从仓库根目录执行：

```sh
node MiniApp/Demo/icon-studio-v2/source/build.mjs
python3 MiniApp/Demo/icon-studio-v2/source/package.py
```

- 独立版本：打开 `output/miniapps/icon-studio-v2.0.2.html`，无需启动服务。
- Mini App：在 OpenBitFun 的「导入小应用」菜单中导入
  `output/miniapps/icon-studio-v2.0.2.bfminiapp`，审阅权限后确认。
- 也可「从文件夹导入」本目录（含 `meta.json` 的目录）。

源码和 HTML 不会自动注册到 Mini App 列表。本次生成安装包，不直接改写用户的应用数据。
版本名称、工程 release 与 package.json 为 `2.0.2`；`meta.json.version` 是宿主管理的整数内容修订，
不是语义版本号，不能用字符串 `2.0.2` 替换。

## 从图片开始

1. 上传、拖入或粘贴 PNG、JPG、WebP，自动生成一个新的矢量图层。
2. 自动选择透明 Alpha 或背景差分，追踪外轮廓与内部镂空，合并成 evenodd 复合路径。
3. 用对比阈值、轮廓简化、平滑、最小区域调整描摹，再点击「描摹为新图层」。
   重新描摹会新增图层，保留已编辑的路径，方便比较或撤销。
4. 按 A 拖动节点；选中节点后可调整贝塞尔手柄、输入坐标、插入／删除、平滑／尖角转换。

描摹按最长边 512px 采样，保留原图宽高比并映射到 24×24 画布。
输入限制为 20 MiB、1600 万像素、单边 8192px；超限明确报错，不覆盖当前矢量画布。
支持简单背景的单色图标；复杂照片、多色分层和自动中线骨架识别不在本版本范围。
轮廓描摹不会把图像理解为“首页”“下载”，也不会伪装成经过设计师规范化的线框图标。
降低简化可以保留更多细节，提高最小区域可以过滤小噪点。

## 绘制与编辑

- V：选择／拖动图层；A：节点与曲线手柄；双击路径插入节点。
- P：钢笔逐点绘制，拖动创建贝塞尔手柄，点击起点闭合，Enter 完成。
- B：自由绘制；L：直线；R：矩形；O：椭圆。按 Shift 绘制正方形／正圆。
- Esc：取消当前绘制／拖动；Delete 删除节点或图层；方向键微调，Shift + 方向键按 1px 移动。
- 默认 0.5px 吸附，可改成 1px 或关闭；拖动时按 Alt 临时关闭吸附。
- Cmd/Ctrl + Z 撤销，Cmd/Ctrl + Shift + Z 或 Ctrl + Y 重做，Cmd/Ctrl + D 复制图层。
- 图层支持命名、隐藏、前后排序、复制、删除、位置／尺寸、居中与适配安全区。
- 每层可选择填充／描边、描边宽度、端点和转角。描摹层默认填充；绘制层默认 2px 圆头圆角描边。
- 提供首页与下载的可编辑几何起点，以及 16／20／24／32px 的常规与反色实际尺寸预览。

画布缩放仅放大编辑视图。它不增加 SVG 本身的像素尺寸。
安全区为 20×20（画布内 2px 留白），适配操作还会预留半个描边宽度以免裁切。
控制点范围用于保守边界估算；曲线的实际光学重心仍需在小尺寸下检查。

## 导出与保存

SVG 使用标准 `viewBox="0 0 24 24"`、`currentColor`、无位图、无背景、无脚本、无编辑网格与手柄。
外部应用通过 CSS 的 `color` 统一控制颜色。导出包含用户名称作为 `aria-label`；
如果应用把图标当作纯装饰，应由组件设置合适的 `aria-hidden`，并在按钮上提供可访问名称。

可保存／导入 `.icon.json` 工程，保留所有矢量节点、手柄、图层和样式。
参考位图只在当前页面内存中存在，不嵌入 SVG、不进入自动保存或工程文件；重开后需要重新导入参考图。
自动保存使用宿主 `app.storage`，独立版使用页面 LocalStorage；保存不可用时明确提示导出工程。
未知 schemaVersion、无效坐标或损坏工程会保留原记录及当前画布，并给出错误，不清空用户数据。
支持至多 512 个图层、20000 个工程节点；复杂描摹会明确提示降低复杂度。

仅申请 `{user-selected}` 写权限，以宿主文件选择器选定的路径保存 SVG／工程。
不读工作区、不执行命令、不联网；输入来自当前页面的文件选择器、拖拽或粘贴。
未宣称已安装到宿主。远程工作区、远程控制、Peer Device Mode、Detached Dispatch
未做端到端验证；本地算法测试不代表这些宿主均提供图片选择、存储或保存能力。

## 设计依据

- [Lucide design principles](https://lucide.dev/contribute/icons/design-principles)：
  24px 基准、2px 描边、圆头圆角、清晰留白、像素对齐、低复杂度与小尺寸光学检查。
  本工具使用可调整参数；不声称任意自动描摹都符合 Lucide 的完整设计规则。
- [W3C SVG paths](https://www.w3.org/TR/SVG2/paths.html)：节点、复合路径和三次贝塞尔曲线。
- [W3C SVG painting](https://www.w3.org/TR/SVG2/painting.html)：currentColor 与 evenodd 镂空。

## 验证

```sh
node --test MiniApp/Demo/icon-studio-v2/tests/*.test.mjs
pnpm run theme:color-audit:all
```

验证几何与描摹、旧工程缺省字段、安全导出、操作历史，以及导入真实测试图后导出 SVG 的链路。
遵循用户要求，不使用 Computer Use 或浏览器控制验证。DOM 模拟检查不等同于实际宿主的视觉验收。

## English

An offline vector icon editor with raster silhouette tracing, editable compound paths and Bézier handles,
pen/freehand/geometric drawing, undo/redo, half-pixel snapping and actual-size previews.
Build the standalone HTML and `.bfminiapp` package with the commands above, then use OpenBitFun's importer.
Export clean `currentColor` SVGs or round-trip the editable `.icon.json` project.
Raster tracing preserves silhouettes and holes; centerline reconstruction and semantic icon recognition are not provided.
