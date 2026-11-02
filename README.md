# @dsh-external/dsh-mermaid

把会话里的 ` ```mermaid ` 代码块**直接渲染成图**的 DSH Web 客户端插件。图表上方保留一条工具条：`查看源码 / 查看图示` 切换、`复制源码`。

开源插件，通过 GitHub 安装（见下方「安装」）。

---

## 它解决什么

DSH 的全局指令要求"复杂逻辑必须图示化"，默认形式是 ```mermaid 代码块；但 Web 客户端把每个围栏都交给 `CodeBlock` 渲染，**围栏语言不会进入 DOM**（不认识的语言统一显示为本地化的"代码块"标题），所以 mermaid 一直只是一段带复制按钮的代码。

真实 DOM（两种代码块变体都是这个骨架）：

```html
<div class="…_block… md-code-block …_card…" data-code-wrap="true">
  <div class="…_bannerWrap…">
    <div class="…_header…" data-code-block-banner="true">
      <span class="…_language…">代码块</span>   <!-- 语言名在这里是本地化兜底文案 -->
    </div>
    <div class="…_actions…">…换行 / 复制…</div>
  </div>
  <div class="…_content…" data-code-block-content="true">
    <pre class="…_plain…"><code>flowchart TD …</code></pre>
  </div>
</div>
```

`.md-code-block` 与 `[data-code-block-banner]` 是字面量（非 CSS Module 哈希），可以稳定选择。

---

## 工作原理

1. **识别**：对每个 `.md-code-block`，沿 React fiber 向上找到带 `{code, lang}` 的那个 fiber（就是 `CodeBlock` 自己），`lang === 'mermaid' | 'mmd'` 即命中。没有 fiber 时退回启发式：未被 Shiki 高亮的 `<pre>` 且首行是 `flowchart`/`sequenceDiagram`/… 等图类型关键字。
2. **等稳定**：回复流式输出时，`CodeBlock` 的 `streaming` prop 会**冻结在 true**（稳定态复用了流式期渲染的 DOM），所以是否结束要看**最外层**声明了布尔 `streaming` 的祖先 fiber。另外源码变化后要再等 300ms 才画，避免画出半张图。
3. **渲染**：在代码块**后面**插入一个自己的 `div`（下一个兄弟节点），用 `display:none` 把原代码块藏起来。React 不认识这个节点，因此不会与它冲突；撤掉这个 div 就完全恢复原状。
4. **懒加载 mermaid**：3.57MB 的 mermaid UMD 不在这份 bundle 里，而是放在本包的 `lib/client.mermaid.js`，由宿主按 chunk 路由 `/plugins/@dsh-external/dsh-mermaid/client.mermaid.js?rev=<包 rev>` 按需提供（rev 从 `window.__DSH_BOOT__` 里读自己的那一行）。取不到时回退到 jsDelivr。
5. **降级**：图语法错误时保留源码，并在图位置显示 mermaid 的解析错误；工具条按钮变为"重试图示"。

---

## 放大查看（2026-10-28）

聊天列宽 ~750px，节点一多字就很小，投屏/讲图时看不清。工具条因此多了一个 `放大`：点它、或**直接点图**，都会打开全屏查看器。

| 操作 | 效果 |
|---|---|
| **单击**（图内任意处） | **关闭**（最快的一条路；拖动/点链接除外） |
| 滚轮 | 以光标为中心缩放（10%–800%） |
| 拖动 | 平移画布 |
| `+` / `-` / `0` | 放大 / 缩小 / 适应 |
| `Esc` 或左上角 `✕ 关闭` | 关闭 |
| 顶部按钮 | `✕ 关闭` `标题` `−` `百分比` `+` `适应` `1:1` |

实现要点：

- **控件全部靠左，右上角留空**。桌面端的窗口按钮（最小化/最大化/关闭）是**系统原生**的、永远压在所有页面内容之上；查看器如果把"自己的关闭键"也放在右上角，实际点中的会是窗口的 ✕ —— 这个 bug 真发生过，把整个桌面端关了。所以工具条右侧用一个 `flex` 撑开的空位封死这个区域。
- **顶部让出标题栏高度**：桌面壳在 `<html>` 上挂 `data-windows-titlebar` 并用 `--dsh-windows-titlebar-height` 公布高度，查看器用 `padding-top = 该高度 + 6px`，让工具条落在原生窗口按钮下方（全屏时 `data-fullscreen` → 按 0 处理）。这和壳自己的全屏层是同一条约定。
- 查看器的 `position/top/right/bottom/left/z-index/display` 是**内联**写死的，不依赖样式表。样式表缺失、过期、或被宿主 CSS 盖掉时，它仍然铺满视口 —— 否则就会掉回文档流、堆到整页最底下（这个 bug 真发生过，见下表最后一行）。
- 查看器是 **body 级的独立节点**，里面放的是 SVG 的**克隆**，所以永远不会和 React 争抢 transcript 里的 DOM。
- 尺寸取自 SVG 的 `viewBox`，克隆体显式写上 `width/height`，因此 `100%` 就是"真实像素大小"，`适应` 按窗口算。
- 打开时锁 `body` 滚动、记住并恢复焦点；图块被 React 重建时只关掉**属于它自己**的查看器（`viewerEntry` 比对），不会误关别的图。
- 点图打开前会比对 pointerdown/up 位移（>4px 视为拖动），所以横向拖看宽图不会误弹查看器；查看器内的单击关闭用同一套位移判断，**拖完不会误关**。
- 图未渲染成功时 `放大` 按钮是禁用态（`applyMode` 里统一控制）。

---

## 安装

### 桌面端 App（推荐，普通用户用这个）

1. 打开左侧栏最下方的 **插件**
2. 点 **安装**，粘贴下面这行（这就是安装地址，不是命令）：

   ```
   https://github.com/zach-bworld/dsh-mermaid
   ```

   也接受这几种写法，效果一样：
   - `github:zach-bworld/dsh-mermaid`
   - `git@github.com:zach-bworld/dsh-mermaid.git`
   - 本地目录绝对路径（先 clone 下来）

3. 安装完成后在列表里**启用**它
4. **刷新页面**（Ctrl+R）或重开窗口

> 为什么不用命令行：桌面端的 profile 由 App 独占管理，在 PowerShell 里执行 `dsh plugin --profile desktop add …` 会报
> `profile "desktop" is managed exclusively by the Electron application`。这是设计如此，不是你的问题。

### 命令行 / Web 端

```bash
dsh plugin --profile web add github:zach-bworld/dsh-mermaid
```

`web` 换成你自己的 profile 名即可（常见：`web`、`tui`、`headless`）。
装完刷新页面。

### 装指定版本

```bash
dsh plugin --profile web add github:zach-bworld/dsh-mermaid#v1.0.0
```

### 卸载

在 App 的插件页移除；或命令行：

```bash
dsh plugin --profile web remove @…/dsh-mermaid
```

### 装不上怎么办

| 现象 | 原因 / 处理 |
| --- | --- |
| 命令行报 `managed exclusively` | 桌面端请走 App 内的插件页 |
| 装完没反应 | 客户端 bundle 需要刷新页面才加载 |
| 提示找不到包 | 检查拼写：`github:zach-bworld/dsh-mermaid`（冒号、斜杠都是必需的） |
## 开发 / 本地构建

只有改源码时才需要（普通安装可跳过）：

```bash
node build.mjs     # src/client.js -> lib/client.js；lib/client.mermaid.js 缺失时从 CDN 下载
```

仓库里已提交构建产物（`lib/`），所以**安装时不需要构建**。

## 验证方法

无头 Chrome + CDP 驱动真实页面（脚本在 `<你的 DSH 目录>`）：

```powershell
# 起一个带 token 的实例
dsh --profile web --port 19399 --no-open

# 无头浏览器 + 远程调试
chrome.exe --headless=new --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<dir> about:blank

node cdp.mjs nav 'http://127.0.0.1:19399/?token=<token>' 8000
node cdp.mjs eval "JSON.stringify(window.__DSH_BOOT__.entries.filter(e=>/mermaid/.test(e.id)))"
node cdp.mjs shot out.png
```

桌面端（19387）需要签名 cookie：`node mint-cookie.mjs 127.0.0.1:19387 7` 生成 `cookie-params.json`，再用 `node cdp.mjs raw Network.setCookie @cookie-params.json` 注入。

页面里可用 `window.__dshMermaid`（`scan` / `schedule` / `tracked` / `ensureMermaid`）手动驱动扫描。

---

## 故障排查（2026-10-16 / 10-19 实战）

线上出现过三类事故，根因和处理如下，改动已落在 `src/client.js`：

| 现象 | 真实原因 | 现在的处理 |
|---|---|---|
| `Cannot set properties of undefined (setting 'style')` | 图里 `linkStyle` 的下标 ≥ 边数（下标从 0 开始）。mermaid 在 `FlowDB.updateLink` 里抛错 | 报错翻译成「linkStyle 的下标超过了图的边数…」 |
| `Cannot read properties of null (reading 'firstChild')` | **不是这张图的问题**。mermaid 的 flowchart 渲染器有模块级全局状态，上一张图在 draw 中途抛错会把它弄脏，并发渲染的邻居于是也失败，而且报的是邻居自己的怪错误 | 渲染**串行化** + 失败后**自动重试一次**，故障不再扩散 |
| `Parse error on line N … got 'SQE'` | 源码语法错。最常见：边标签 `-->\|文字\|` 里混进了方括号（`-->\|不可归属]\|`），其次节点文字里有裸的半角括号 `( )` | 提示里直接给出**出错行原文 + 原因**，例如「边标签只能写成 `-->\|文字\|`，中间不能出现方括号 `[ ]`」 |
| 点「放大」后，查看器变成一块普通内容**堆在页面最底部** | HMR 换插件代码时上一代 `<style>` 还在 `<head>`，旧 `ensureStyles()` 看到元素就 return → 新增的 `.dsh-mermaid-zoom*` 规则一条没进 → 没有 `position:fixed` | `ensureStyles()` 按 `data-revision` **整表重写**；查看器定位/铺满改用**内联样式**兜底 |
| 点查看器右上角的关闭键，**整个桌面端被关掉** | 桌面端的窗口按钮是**系统原生**的（永远在最上层），查看器的 ✕ 也摆在右上角、几乎重合 → 点到的是窗口的 ✕ | 控件全部左移、右上角用 spacer 留空；顶部让出 `--dsh-windows-titlebar-height`；并支持**单击图内任意处关闭**，不必再去追 ✕ |
| 页面底部残留一个 mermaid 报错 SVG | `render()` 只在成功路径清理临时容器 | `dropTempContainers()` + 失败时 `removeStrayErrorArtifacts()`；`install()` 时还会扫一遍上一代遗留的容器 |

**写 mermaid 时的三条自查**（比看报错快得多）：

1. 边标签只有一种合法写法 `-->|文字|`，里面**不要**出现 `[ ] { } ( )`。
2. 节点文字里只要有半角括号/尖括号/引号，就把整段用双引号包起来：`A["文字(说明)"]`。
3. `linkStyle a,b,c` 的下标从 0 数起，必须 < 图的边数。

另外两点：

- **渲染 id 带实例随机前缀**（`dsh-mm-<run>-<n>`）。HMR 会留下旧实例继续跑，两代实例的计数器都从 1 开始会让 mermaid 的临时容器 id 撞车（`aNt()` 会按 id 删掉对方的容器，于是 `firstChild` 报空）。
- **不要重开这个坑**：一开始想用「等流式结束再画」来避开半张图，但 `CodeBlock` 自己的 `streaming` prop 在稳定态会**冻结在 true**（React 复用了流式期的 DOM），必须看最外层祖先 fiber 的实时值。
- **样式表必须按版本覆盖重写，不能"有就跳过"**。2026-10-28 的事故就是这么来的：HMR 换了插件代码，上一代的 `<style>` 还在 `<head>`，旧 `ensureStyles()` 见到元素直接 return，于是新加的 `.dsh-mermaid-zoom*` 一条都没进 —— 查看器没有 `position:fixed`，退化成普通块排到整页最底部。现在 `ensureStyles()` 用 `data-revision` 判断并整表重写，且查看器的定位改由内联样式兜底。

复现与验证脚本：`<你的 DSH 目录>`（干净页面对照，含 `parse-fix.html`）与 `<你的 DSH 目录>`（真实页面探针）。

---

## 已知限制

- 标签页隐藏时 mermaid 的首次布局可能取不到尺寸，切回前台会自动重画（扫描由 DOM 变更触发）。
- 代码块变体（`CodeToolbar`）的语言标题对未知语言显示"代码块"，所以**不能**靠标题识别 mermaid，只能靠 fiber / 内容启发式。
- 插件依赖 `__reactFiber$` 这一 React 内部约定；React 大版本升级后需回归。降级路径（内容启发式）仍然可用。
- 未做虚拟滚动适配：超长会话里所有图都是常驻 DOM，与客户端自身的渲染策略一致。
