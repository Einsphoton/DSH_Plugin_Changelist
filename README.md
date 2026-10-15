# @local/dsh-changelist — 工作区改动置顶摘要

在 DSH 会话标题栏**右上角**加一个「置顶摘要」小胶囊：显示当前工作区**相对远端分支**的改动数（如 `3 个文件 +12 −4`）；点它弹出一个**小浮窗**，列出哪些文件改了、状态、逐文件增删行数，点文件即可看**代码 diff**。

## 它做什么

- **会话头部胶囊（常驻）**：会话标题栏右上角的小胶囊，带状态点与 `N 个文件 +增 −删`。
  - 状态点：有改动 = 琥珀色，工作区干净 = 绿色，出错/非仓库 = 红色，加载中 = 灰色；hover 显示 `分支 → 基准 · +增 −删`。
  - 点击开/关浮窗，并顺手刷新一次状态。
- **浮动摘要（点击展开）**：挂在 `shell.overlay` 层的小卡片，不挤压布局。
  - 头部：`分支 → 基准`、`↑领先 ↓落后`、`+增/−删`，以及 **刷新 / 拉取远端 / 自动换行 / 关闭**。
  - 头部下方**始终显示被检查的目录绝对路径**，所以「不是 git 工作区」这类结论永远能对上具体是哪个文件夹。
  - 文件清单：状态字母（M 修改 / A 新增 / D 删除 / R 重命名 / C 复制 / T 类型变化）、路径、逐文件行数；重命名的 hover 提示显示 `旧路径 → 新路径`。
  - 代码对比：点文件即在下方显示 `git diff` 统一对比，`+`/`-`/`@@` 分别着色。
  - 按 **Esc** 或点 **✕** 关闭。
  - 位置**锚定在胶囊正下方**（点击时实测胶囊位置），窗口下方空间不足时自动翻到胶囊上方；量不到位置时回落到样式表默认的右上角。
  - 若 Host 知道多个工作区/会话目录，浮窗顶部会出现目录下拉框用于切换；**出错或干净时它也照常显示**，不会让你卡在错的项目上。
  - 目录不是 git 工作区时，除了「该目录不在 git 工作区内」，还会把 **git 自己的原话**（例如 `fatal: not a git repository …`）和「可执行 `git init`」的提示一起显示出来。
  - 与**旧版 Host 半边**兼容：会话形态被拒（400/403/404）时自动用该会话的工作目录（`dir`）重试一次，而不是直接报错。
- **相对远端**：默认以当前分支的 upstream（如 `origin/main`）为基准，把 **已提交 + 已暂存 + 未暂存 + 未跟踪** 的改动一次性列出来。
  - 基准解析顺序：`@{upstream}` → 远端默认分支（`refs/remotes/<remote>/HEAD`）→ 任意远端跟踪分支 → 退回 `HEAD`（仅未提交改动，并在浮窗里说明原因）。
- **目标即当前会话**：胶囊优先使用所在会话（`sessionId`），工作目录由 Host 从会话解析——**当前会话永远优先于浏览器里记住的目录**；会话不在 Host 的活动列表里时也会按 `sessionId` 直接定位，所以不会跑去看错项目。
- **拉取远端**：`拉取远端` 执行一次 `git fetch`（唯一会联网的操作，永不弹出凭据提示）；其余命令全部只读。

## 安装

桌面版 profile 由 Electron 独占管理，`dsh plugin` CLI 会拒绝操作它，因此请用 GUI 安装：

1. 左侧栏打开 **Plugins** 页面。
2. 点 **Add plugin**，在输入框里填**本插件的绝对路径**：

   ```
   C:\Users\renjiangfeng\Documents\AI Project\DSH_Changelist\dsh-changelist
   ```

3. 点 **Install**（已装过则跳过）。本 profile 已挂载 `dsh-hmr`，安装完成后组合会**热重载**，无需重启应用。
4. 打开任意会话，标题栏右上角会出现改动胶囊。

### 改了代码之后怎么生效（重要）

本 profile 的 HMR **模块监听根是 `[]`**（`dsh-hmr` 只在给出 `profileContext` 时以 `root: []` 启用，即只监听显式配置、不监听源码模块），而浏览器半边是由 Host 在**组合时刻**读取并缓存后按 `?rev=` 提供的（响应头是 immutable）。因此**改了 `index.js` 或 `client.js` 后，刷新页面并不会加载新代码**：

- 较轻的做法：**Plugins 页面里把本 bundle 关掉再打开**（会写 profile patch → 触发重组 → 重新挂载该行）。
- 可靠的做法：**重启 DSH 应用**（会话记录保留，重开后从历史里继续这个对话即可）。

判断运行中的 Host 到底加载了哪一版：看 `.diagnostics/host.log` 有没有新的 `mounted` 行。

卸载：同一页面里 uninstall 该 bundle 即可。

## 配置

`config` 是**整体替换**（不是深合并），在 profile 的 `cordis.patch.yml` 里按 `id` 覆盖：

```yaml
- id: changelist
  name: '@local/dsh-changelist'
  config:
    gitPath: git
    timeoutMs: 20000
    fetchTimeoutMs: 120000
    maxFiles: 500
    maxDiffBytes: 524288
    contextLines: 3
    base: null          # 强制指定基准，如 origin/main
    allowedPaths: []    # 额外允许检查的目录（见「安全」）
    diagnostics: true   # 写入 <插件目录>/.diagnostics/host.log
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `gitPath` | `git` | git 可执行文件 |
| `timeoutMs` | `20000` | 单条 git 命令超时 |
| `fetchTimeoutMs` | `120000` | `拉取远端` 的超时 |
| `maxFiles` | `500` | 一次最多返回的文件数（总数仍完整统计） |
| `maxDiffBytes` | `524288` | 单个文件对比的字节上限，超出按行截断 |
| `contextLines` | `3` | 对比上下文行数 |
| `base` | `null` | 强制基准 ref；`null` 表示自动解析 upstream |
| `allowedPaths` | `[]` | 目录白名单之外的额外目录 |
| `diagnostics` | `true` | 是否写活动日志（见下） |
| `diagnosticsPath` | `null` | 覆盖日志路径；`null` = `<插件目录>/.diagnostics/host.log` |
| `diagnosticsMaxBytes` | `262144` | 超过则只保留最后 200 行 |

### 活动日志（诊断用）

本部署里 Host 不落普通日志、浏览器控制台也拿不到，所以插件把**活动日志**写在 `<插件目录>/.diagnostics/host.log`（已在 `.gitignore` 中）：

- `{"event":"mounted"}` / `{"event":"unmounted"}`：Host 半边是否（重新）挂载 —— 这也用来判断运行中的 Host 到底加载了哪一版代码；
- `{"event":"route","route":"state","status":200,"ok":true,"files":3,"sessionId":"...","ms":4}`：浏览器半边**真的调用了**路由，以及结果；`targets` 行还会带上候选目录的数量与前几项。

所以排查时分三种情况一目了然：**没有日志** = Host 没加载到这一版代码；**只有 mounted、没有 route** = 浏览器半边没调用（槽位/渲染问题）；**有 route 且 `ok:false`** = 调到了但 git 侧失败（日志里带原因）。写日志失败绝不影响任何响应（有测试覆盖）。

### 与 `git status` 的计数差异

文件数是**逐文件**统计的：`git status` 会把一个整目录的新文件折叠成一条记录（`?? some/dir/`），而本面板把里面的文件逐个列出。实测在一个 78 文件的项目里：`git status --porcelain` 报 77 条，其中把 `packages/web/src/components/markdown/` 折叠成了 1 条；面板展开成它的 2 个文件 → 77 − 1 + 2 = 78。两者描述的是同一批改动。

### 性能

单次 `state` 请求约 **0.45 秒**（78 文件、7 条 git 命令 + 22 个未跟踪文件的读取）；`diff` 只读一个文件。面板是手动刷新（打开浮窗/点刷新/点拉取远端），不做轮询。

`拉取远端` 是本插件唯一联网的命令。作者所处的受限沙箱无法执行 `git fetch`（其传输需要 shell，被沙箱拒绝），因此该分支只覆盖了「失败时把 git 的消息原样带回、且不影响清单」这一契约；正常情况下它会执行 `git fetch --quiet <remote>`。

## 安全设计

- 路由注册在 **Connection 的 `/api` 取数围栏内**（`ctx.connection.fetch.register`），因此继承浏览器的鉴权与 Host/Origin 策略，不需要自己实现认证。
- `sessionId` 形态由 **Host 自己**从会话头解析工作目录（`ctx.sessions.get(id).header.cwd`），客户端无法借它指向任意目录；未知会话返回 404。
- `dir` 形态必须**已注册的工作区**、**活动会话的工作目录**、进程工作区根，或配置里显式列出的 `allowedPaths`；否则返回 403 并列出可用目录。
- `path` 必须是仓库内相对路径：绝对路径、盘符路径、含 `..` 的路径一律拒绝（400）。
- git 以**剥离凭据的环境**运行（仅保留 PATH/SystemRoot 等，`GIT_TERMINAL_PROMPT=0`、`GIT_CONFIG_COUNT=0`、清空 `GIT_ASKPASS`），且只读；`fetch=1` 是唯一联网命令。
- `maxBuffer` 64 MB，命令有超时，路由异常统一转成结构化错误而不会打断进程；服务读取失败（工作区/会话服务抛错或返回非数组）只降级该来源，不影响路由。

## 已知边界

- **只读**：插件不改动仓库；不修改 index、不写 refs。
- **无远端时**：退回 `HEAD`，只显示未提交改动，浮窗会说明原因。
- **工作区不是 git 仓库时**：浮窗显示「该目录不是 git 工作区」，胶囊圆点变红；可先在终端侧栏 `git init`。
- **胶囊只出现在已打开的会话标题栏**（新会话欢迎页没有会话头，因此没有胶囊）；它显示的是该会话的工作目录。
- **子模块/嵌套仓库**表现为 gitlink，其内部改动不展开。
- 超过 `maxDiffBytes` / 渲染 3000 行的对比会截断并提示。
- 多目标时浮窗顶部有目录下拉框；非会话目标的选择会记在浏览器 `localStorage`（会话目标总是跟随当前会话）。
- 二进制文件只标注「二进制」，不显示内容。
- 文案目前为中文（英文词典已一并注册）。
- 浮窗是 `shell.overlay` 层的绝对定位卡片（右上角、宽 ≤620px、高 ≤74vh）；点外部不会自动关闭，请用 **Esc** 或 **✕**。

## 开发与自测

```powershell
node dsh-changelist/selftest.mjs    # 数据层：真实 git 仓库 + 真实远端跟踪分支
node dsh-changelist/host-test.mjs   # Host 半边：真实路由 → 真实 git → JSON
node dsh-changelist/client-test.mjs # 浏览器半边：模块契约 + 槽注册 + 胶囊/浮窗渲染 + 交互

# 需要真实 Cordis 框架（可选，验证插件生命周期契约）
node dsh-changelist/extract-from-asar.mjs "C:\Users\renjiangfeng\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" ".changelist-test/cordis"
node dsh-changelist/integration-test.mjs ".changelist-test/cordis/node_modules/@deepseek-ai/cordis"
```

三个自包含套件共 159 项断言；再加上真实 Cordis 的 15 项共 **174 项**，全部通过。

`integration-test.mjs` 需要一个真实 Cordis 包目录，可用上面的 `extract-from-asar.mjs` 从已安装的 `app.asar` 里解出（该脚本只取 `cordis`/`cosmokit`/`schemastery` 三个包，0.29 MB），也可用环境变量 `DSH_CORDIS_DIR` 指向任意 DSH 检出。它验证的是**框架契约**：模块 `inject`/`apply` 生效、注入服务出现前插件保持 pending、服务就绪后注册 3 条路由、真实 `Request` 能得到 `Response`、以及**卸载后路由被释放**——git 相关的正常路径由 `host-test.mjs` 覆盖。

测试夹具（含 bare 远端、重命名/二进制/未跟踪等场景）由 `test-fixture.mjs` 在 `.changelist-test/fixture/` 下自动重建（放在子目录里，这样旁边解出的 Cordis 不会被重建清掉）。

> 说明：本仓库的测试在受限沙箱里运行，该沙箱禁止子进程使用管道 stdin/out（`spawn git EPERM`），因此测试把 stdout/stderr 重定向到文件。插件本身在 DSH Host 进程内使用普通管道，这是测试夹具与生产实现的唯一差异。

## 验证状态

已实测（174 项断言，全部通过，无需 DSH 运行）：

| 范围 | 覆盖 |
|---|---|
| 数据层（26 项） | 真实仓库 + 真实 `origin/main`：上游解析、ahead/behind、`--name-status -z` / `--numstat -z` 解析、重命名、未跟踪、二进制、删除、对比合成、非仓库目录、路径遍历防护 |
| Host 半边（62 项） | 真实路由处理器 → 真实 git → JSON：三条路由注册在 `/api/` 围栏内、GET + buffered、effect 拥有 4 个 disposer（1 个卸载钩子 + 3 条路由）且 yield 的全是函数、`dir` 的 403/400 鉴权、**`sessionId` 由 Host 解析工作目录且未知会话返回 404**、目录去重与容错（服务抛错 / 返回非数组 / 工作区根取值异常都不影响路由）、缺 git 时结构化失败、`fetch=1` 无论成败都带 git 的消息且不影响清单、`maxFiles`/`maxDiffBytes` 截断与提示；**活动日志**（挂载/卸载/每次路由命中与结果，诊断路径不可写时也不影响响应） |
| 浏览器半边（71 项） | ModuleLoader 契约；两个表面注册到 `conversation.session.header.utilities` 与 `shell.overlay`；胶囊显示文件数与 `+/−`、状态点、hover 摘要；**点击胶囊打开浮窗**（表头/清单/对比着色/切换器/提示/请求 URL）；**Esc 关闭**；浮窗**锚定在胶囊下方**、视口不够高时自动翻到上方、量不到位置时回落到样式表默认；**当前会话永远优先于记忆目录**（并把污染过的那份记忆改用 `.v2` 键丢弃）、**会话出现较晚或在同一窗口切换会话时会自动改瞄**（修掉了实测到的挂载竞态）、会话不在列表里也能按 `sessionId` 定位、失败状态下目录选择器依然可用、**浮窗常驻显示被检查的目录**并显示 git 的原话与「可 git init」提示、非 git 工作区在胶囊上呈中性色（不是报错色）；旧版 Host 只认 `dir` 时自动重试并提示「Host 半边版本较旧」；locale 不可用时仍注册并渲染（回退显示消息键） |
| 真实 Cordis（15 项） | 注入服务就绪前插件保持 pending、就绪后注册 3 条 `/api` 路由、真实 `Request` → `Response`、`ctx.get` 对缺失服务返回 undefined、**卸载后 3 条路由全部释放** |

另外已直接核对 `dsh-client-connection` 源码：`assertFetchRoute` 只要求路径落在 `/api/` 下且段名匹配 `^[A-Za-z0-9_$.-]+$`（`changelist.state` 合法），且精确 fetch 路由的查找**早于** RPC 解析；`shell.overlay` 是 `kind:"list"`、`scope:"root"` 的覆盖层（`z-index:20`、`pointer-events:none`，子元素可交互）。

**已验证**：插件已通过 GUI 装进 desktop profile（`link:` 方式，profile 里是 Junction 指向本目录），左侧栏曾出现入口；Host 半边路由与全部离线套件均通过（140 项）。

**尚未验证**：运行中的 Host 是否已加载**本版**代码。本 profile 的 HMR 模块监听根是 `[]`，浏览器半边又是组合时刻的快照（`?rev=` + immutable），所以改了代码后**刷新页面不会生效**——需要一次重组（Plugins 页面里把关掉再打开）或重启应用。判断方法与判据见上面「改了代码之后怎么生效」与「活动日志」两节：`.diagnostics/host.log` 里有没有**新的** `mounted` 行，以及有没有 `route` 行。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：`/api/changelist.targets` / `.state` / `.diff` 三条路由、`sessionId`/`dir` 目标解析与鉴权、带超时与剥离环境的 git runner |
| `lib/git.js` | 纯数据层：基准解析、`--name-status -z` / `--numstat -z` 解析、未跟踪文件合成、对比截断（`run`/`readFile` 可注入） |
| `client.js` | 浏览器半边：会话头部胶囊（`conversation.session.header.utilities`）+ 浮窗（`shell.overlay`），共享一个模块级 store，自注入 `<style>`，仅用 `--dsw-alias-*` 主题 token |
| `cordis.patch.yml` | bundle 补丁：插入一行 `changelist`，同时挂载两个半边 |
| `test-fixture.mjs` | 自包含测试夹具：真实仓库 + bare 远端 + 受限沙箱可用的 runner |
| `selftest.mjs` / `host-test.mjs` / `client-test.mjs` | 三个自包含验证套件（数据层 / Host / 浏览器） |
| `integration-test.mjs` | 真实 Cordis 框架下的生命周期与路由注册/释放验证（需指定 cordis 路径） |
| `extract-from-asar.mjs` | 从已安装的 `app.asar` 解出 cordis 框架，供上一个套件使用 |
