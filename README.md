# Dsh Reader

本地电子书阅读器（Windows 桌面端）。当前为**第一阶段：页面结构与交互设计**，书籍格式先支持 **EPUB**。

## 运行

```bash
npm install          # 首次
npm run dev          # 开发模式（Vite HMR + Electron）
npm run build        # 打包到 out/
npm run preview      # 运行打包后的产物
```

### ⚠️ 关于启动方式（本机实测结论）

**Electron 的可执行文件位于非 ASCII 路径时无法启动**：如果项目在 `D:\桌面\...` 这类路径下，
`node_modules/electron/dist/electron.exe` 的浏览器进程会在 `app ready` 之前直接崩溃（`0xC0000005`），
与 Electron 版本、`--no-sandbox`、`--disable-gpu`、启动方式（Node / PowerShell / explorer）均无关。
把整个 dist 复制到纯 ASCII 路径后即可正常运行。

因此 `npm run dev` / `npm run preview` 走的是 `scripts/dev.mjs` 启动器：

1. 检测 `node_modules/electron/dist` 是否为纯 ASCII 路径；
2. 若不是，则把 Electron 运行时复制到 `%LOCALAPPDATA%\DshReader\runtime\electron-<版本>`（首次一次，约 250 MB）；
3. 通过 `ELECTRON_EXEC_PATH` / `ELECTRON_OVERRIDE_DIST_PATH` 让 electron-vite 使用该副本。

**更彻底的做法是把项目整体放到纯 ASCII 路径**（例如 `D:\DshReader`）：启动器会自动跳过复制，
也不再有这层绕行。注：目录联接（junction）无效，加载器仍会解析到真实路径，必须用真实副本。

另外本机需要 `--noSandbox`（Chromium 沙箱无法初始化），启动器已内置。

### 浏览器预览模式（不启动 Electron 看界面）

```bash
npm run build:web
npm run preview:web   # 打开 http://127.0.0.1:5199
```

## 打包

```bash
npm run dist              # 免安装文件夹版（推荐）：release/DshReader-<版本>-portable/
npm run dist:installer    # 安装版（NSIS）：release/DshReader-<版本>-setup.exe
```

**免安装文件夹版**（默认）产出一个自包含目录，双击其中的 `DshReader.exe` 即可运行：

```
release/DshReader-0.1.0-portable/
    DshReader.exe        ← 双击打开
    使用说明.txt
    books/               ← 书籍副本（导入时自动复制到这里）
    resources/  locales/  *.dll ...
```

- 整个文件夹压缩后就能发给别人，对方解压双击即可用，不需要安装、不需要任何运行环境
- 数据（阅读进度、统计、设置）存在 `%APPDATA%\Dsh Reader`，所以分享出去的包是干净书库
- 想彻底绿色化（连数据也放文件夹里）的话说一声，加个开关即可

> 安装版会装到 `%LOCALAPPDATA%\Programs\Dsh Reader`；安装包未做代码签名，SmartScreen 可能提示「未知发布者」。
> 实测打包后的应用放在**中文路径下也能正常启动**（开发模式才有非 ASCII 路径的限制，见上一节）。

图标由 `scripts/make-icon.py` 生成（Pillow），产物为 `build/icon.ico` / `build/icon.png`。

## 书架分组规则

**书名以文件名为准**（EPUB 内部的 `dc:title` 常常所有卷都写成同一个名字，无法区分卷号）。
内部书名会保留在详情面板里对照显示。文件名不可读时（UUID、纯数字、过短）自动回退到内部书名。

卷号与系列从书名推导：

| 书名 | 卷号 | 归组系列 |
|---|---|---|
| `安达与岛村 1` | 1 | 安达与岛村 |
| `安达与岛村11` | 11 | 安达与岛村 |
| `安达与岛村 10 试读版` | 10 | 安达与岛村 |
| `安达与岛村-第八卷-迷糊轻小说` | 8 | 安达与岛村 |
| `安达与岛村-短篇-迷糊轻小说` | — | 单册书籍 |
| `1984` | — | 单册书籍 |

- 支持 `第X卷 / 第X册 / Vol.N / 结尾数字（含无空格、小数、全角标点）/ 结尾中文数字`，以及站点与版本尾缀（迷糊轻小说、电击文库、贴吧版、试读版…）
- 同系列 ≥ 2 本才会出现独立的系列分组，只有一本时归入「单册书籍」
- **模糊归组**：标题去掉数字与标点后互为前缀的书会自动归到一起，解决「文件名里没有卷号」的情况，分组标题上会标注「模糊匹配」
- **手动合集**：书库右键 →「归入合集…」，或进入多选模式后批量归入；手动合集优先于自动识别，分组标题上会标注「手动合集」
- 书名、卷号、归组在**每次启动时按当前规则重算**，所以规则改进后旧书库会自动更新，无需重新导入

**阅读进度分两个口径**：

| 位置 | 含义 | 算法 |
|---|---|---|
| 阅读器底栏 | **本章进度**（可按住拖动定位） | 当前章节内的滚动/翻页位置 |
| 阅读器底栏右侧、主页 | **全书进度** | （已读章节字数 + 当前章字数 × 章内位置）÷ 全书字数 |

早期版本按「章节序号」存的百分比会在启动时**自动改写**成按阅读位置的整书进度。

打开没有阅读记录的书时，会跳过封面 / 制作 / 版权 / 目录 / 彩插等前置页，直接进正文第一章。

此模式下 `window.api` 由 `src/renderer/src/lib/mock-api.ts` 顶替，使用内存示例数据，**不写磁盘、不代表真实同步行为**，仅用于界面评审。支持 `?preview=nobooks|dark|paged` 预览空书库 / 深色主题 / 翻页模式，`?cal=heatmap` 直接打开热力图。

## 已实现

| 模块 | 状态 |
|---|---|
| 本地书库：导入（对话框 / 文件夹 / 拖拽）、封面提取与主色、系列与卷号归组、排序、删除与隐藏 | ✅ |
| 书库浏览：**搜索**（书名 / 作者 / 系列）、侧边栏系列二级菜单（带展开动画）、**多选批量管理**（工具栏按钮，合集 / 隐藏 / 移出 / 删除） | ✅ |
| 书籍分组：卷号解析 → 模糊前缀归组 → **手动合集**（三级兜底，分组上标注来源） | ✅ |
| 书籍详情：点击封面从底部飞入详情面板（封面、进度、阅读时间、格式、总字数、状态、简介、文件名对照） | ✅ |
| EPUB 解析：`container.xml` → OPF → 元数据 / 简介 / 封面 / spine / 目录（nav 与 ncx 双通道）/ 每章字数 | ✅ |
| 阅读器：目录抽屉、排版设置、正文净化与图片改写、章节导航、**正文内链跳转**、进度按阅读位置记忆 | ✅ |
| 翻页模式：点击页面左右两侧、滚轮翻页、翻页动效、**按窗口宽度自动单栏 / 双栏**（实时跟随窗口缩放） | ✅ |
| 阅读进度：底栏**本章进度条（可拖动）**、全书进度、主页整书进度 | ✅ |
| 阅读统计：前台心跳计时、四张统计卡、阅读日历 ⇄ 阅读热力图、阅读历史列表、全部/按月/按年筛选 | ✅ |
| 每日阅读目标：可设目标分钟数，「今日阅读」环按它计算，卡片显示当前书封面与封面色渐变 | ✅ |
| 外观自定义：主题色（预设 + 取色器）、应用背景图、阅读器背景图（选图后自动复制进数据目录） | ✅ |
| 页面切换飞入飞出动效、弹窗底部飞入飞出、侧边栏系列展开动画（关闭窗口降频以免动画掉帧） | ✅ |
| 数据持久化：`%APPDATA%\Dsh Reader` 下的 JSON（原子写入），退出前强制落盘 | ✅ |
| 设置：阅读偏好（带实时预览）、数据目录、界面主题（浅色/深色） | ✅ |
| 网盘同步：状态机 + 同步状态弹窗 + 冲突弹窗（界面完成，引擎待接入） | 🚧 M5 |

## 尚未实现

- 网盘同步引擎（百度网盘登录窗口、进度与书籍文件的上传下载、冲突检测）
- 除 EPUB 外的格式：TXT / PDF / CBZ / MOBI / AZW3
- 标签模块、书签笔记、全文搜索、手机端

> v2 的完整待办清单（含实测发现的隐患、优先级建议）见 [docs/v2-plan.md](docs/v2-plan.md)。

## 目录结构

```
src/
  main/        主进程：窗口、自定义 dsh:// 协议、IPC、数据层、EPUB 解析、统计聚合
    store.ts      JSON 持久化（settings / library / progress / sessions）
    epub.ts       EPUB 解析与正文净化
    library.ts    导入、分组、缓存解压
    stats.ts      统计与日历聚合
    sync.ts       同步服务占位（M5 落地）
  preload/     contextBridge 暴露的 window.api
  renderer/    React 界面（页面 / 组件 / 状态 / 样式）
  shared/      跨进程共享类型
scripts/
  make-samples.mjs   生成示例 EPUB
  epub-check.mjs     EPUB 解析链路自检（不依赖 Electron）
  backend-check.mjs  后端集成自检（electron 模块用桩替换）
  electron-stub.ts   测试用 electron 桩
  dev.mjs            启动器：处理「Electron 在非 ASCII 路径无法启动」
  serve-web.mjs      浏览器预览的静态服务器
  shot-web.mjs       Edge 无头截图验收
  screenshot.mjs     Electron 内截图（环境支持时使用）
```

## 自检

```bash
npm run check        # 类型检查 + EPUB 解析 + 后端集成（一条命令跑完）
npm run typecheck    # 主进程 + 渲染进程类型检查
npm run check:epub   # 解析示例 EPUB，校验元数据/封面/目录/正文净化
npm run check:backend # 用桩替换 electron，在纯 Node 下跑导入→阅读→计时→统计→重启读回
npm run shot:web     # 逐页截图到 shots/
npm run shot         # 在 Electron 内逐页截图（需 ASCII 路径运行时）
```

## 数据位置

**书籍文件放在应用根目录的 `books/`**，导入时会从原位置复制一份过去（原文件不动）：

| 运行方式 | `books/` 位置 |
|---|---|
| 免安装版 | 免安装 exe 所在目录旁边的 `books/`（不是解压出来的临时目录） |
| 安装版 | 安装目录下的 `books/` |
| `npm run dev` | 项目根目录下的 `books/` |

> 这样书库文件看得见、摸得着，整个文件夹拷走就是完整的书库。
> 若应用目录不可写（例如装到 `Program Files`），会自动回退到数据目录下的 `books/`。
> 老版本存在数据目录里的书籍副本会在首次启动时**自动迁移**过来；迁移只删除「应用自己复制的那份」，绝不碰你的原始文件。

其余数据在 `%APPDATA%\Dsh Reader`：

```
settings.json  library.json  progress.json  sessions.json
covers/        抽取的封面
cache/         按需解压的书籍内容
assets/        自定义背景图
```

> 如果你希望改成「只引用原路径不复制」，告诉我，加一个开关即可。

## 开发用环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DATA_DIR` | 覆盖数据目录（截图 / 测试用） |
| `DSH_IMPORT` | 启动时导入指定 EPUB，分号分隔 |
| `DSH_SEED_STATS` | 写入示例阅读统计（仅开发） |
| `DSH_SHOT_DIR` / `DSH_SHOT_LIST` | Electron 内逐页截图 |
| `DSH_LOG_FILE` | 主进程日志写入文件 |
