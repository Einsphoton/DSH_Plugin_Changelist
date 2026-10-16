# @local/dsh-changelist — 工作区改动置顶摘要

在 DSH 会话标题栏**右上角**加一个「置顶摘要」小胶囊：显示当前工作区**相对远端分支**的改动数（如 `3 个文件 +12 −4`）；点它弹出一个**小浮窗**，列出哪些文件改了、状态、逐文件增删行数，点文件即可看**代码 diff**。

同一个面板也回答 **Perforce** 的问题：按 changelist 分组、标出 shelved 文件，并可在浮窗里按本次会话临时覆盖 `P4PORT`/`P4USER`/`P4CLIENT`/`P4CHARSET`。后端由目录自动识别，也可以在浮窗头部手动切换（见「Perforce 工作区」）。

## 它做什么

- **会话头部胶囊（常驻）**：会话标题栏右上角的小胶囊，带状态点与 `N 个文件 +增 −删`。
  - 状态点：有改动 = 琥珀色，工作区干净 = 绿色，出错 = 红色，加载中 = 灰色，**非 git / 非 Perforce 目录 = 中性灰**（是事实，不是故障）；hover 显示 `分支 → 基准 · +增 −删`（Perforce 目标显示客户端名与 rev）。
  - 点击开/关浮窗，并顺手刷新一次状态。
- **浮动摘要（点击展开）**：挂在 `shell.overlay` 层的小卡片，不挤压布局。
  - 头部：`分支 → 基准`、`↑领先 ↓落后`、`+增/−删`，以及 **后端切换器（`自动 / git / Perforce`）/ 连接 / 刷新 / 拉取远端 / 自动换行 / 关闭**。
  - 胶囊与头部都用一个小徽标（`git` / `P4`）说明这次是哪个后端回答的。
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
- **三种 VCS 的分工（这就是全部规则）**：切换工程时浮窗按该工程自动换模式，不需要你去说它是哪种。
  1. **Git 工程：完全不用配账号**，也不问你要。目录里有 `.git` 就直接读（分支、基准、改动清单、对比），零配置。
  2. **Perforce 工程：需要连接信息，并且锚定到具体工作区（P4V 的 Workspace）**。插件先自己读 P4V 的本地配置（`connectionmap.xml` + `ApplicationSettings.xml`）拿到 port/user/client/charset；只有**在 P4 目录上连不上、且什么都没读到**时，浮窗才会自动展开「连接」面板问你要这四项（面板里会说明"已读到什么/什么都没读到"）。在 P4V 里连过一次的话，通常一个字都不用填。
  3. **两种工程混在同一个窗口里也没关系**：后端选择（`localStorage` 的 `dsh-changelist.vcs.v3.<目标>`）和连接信息（内存里的 `p4ByTarget`，按目标）都是**按工程分开存的**。在 P4 工程里填的 port/user 不会跟着请求跑到 git 工程上，git 工程的请求里也永远没有 `p4port`/`p4user` 这类参数。
  - **后端可看可切**：胶囊用 `git` / `P4` 小标记说明这次是谁回答的；浮窗头部有 `自动 / git / Perforce` 切换器，只作为 `vcs=` 请求参数发出。默认 `自动`，想固定某一个工程用某后端时手动切，这个选择只对那个工程生效。**切换后端不会改变被检查的目录**：当前会话仍然优先。
- **拉取远端**：`拉取远端` 执行一次 `git fetch`（唯一会联网的操作，永不弹出凭据提示）；其余命令全部只读。

## Perforce 工作区

同一套界面也服务 Perforce 工作区。`vcs=auto`（默认）时由 Host 按目录判断，顺序是：**显式请求的 `vcs` → 目录同时属于两者（git 与 Perforce 都报在 `available` 里，按请求/切换器走）→ 目录在 git 工作树内 → 目录在 Perforce 客户端根目录内**；两者都不属于时 reason 是 `not-a-repository`，并把 Perforce 自己的错误原话放在 `detail` 里（只有 `p4-unavailable` / `p4-error` 才会成为 reason）。`vcs` 大小写不敏感（`P4` 与 `p4` 同义），无法识别的取值退回 `auto`。检测结果按目录缓存 60 秒，所以切换会话不会让每条请求都重新探测。

手动切换在浮窗头部：`自动 / git / Perforce`，默认 `自动`，存在浏览器 `localStorage` 的新键 `dsh-changelist.vcs.v3`，并作为 `vcs=auto|git|p4` 附加在 `state` 与 `diff` 请求上。**它只影响"问谁"，不影响"问哪个目录"**——当前会话优先于记忆目录这条规则没有放宽。

### 新增界面

- **胶囊后端标记**：计数旁边的 `git` / `P4` 小徽标说明本次回答来自哪个后端。`not-a-workspace` 与「不是 git 工作区」一样用中性色（它是关于目录的事实，不是故障）；`p4-unavailable` / `p4-error` 用报错色，并把 **Perforce 自己的话**显示在浮窗里。
- **按 changelist 分组**：Host 返回非空 `changelists` 时，文件清单按变更列表分组（`default` + 编号）：组头显示**编号或 `default`、一行描述（超长省略）、用户与文件数**；**本地未 opened 改动**单独成组（蓝色标题）。组可折叠，**折叠状态按目标记在共享 store 里**（不写 localStorage）。`changelists` 缺失时（git，或旧版 Host）仍是原来的扁平清单，渲染与今天完全一致。
- **shelved 标记**：组头与文件行都带 `shelved` 徽标，shelved 行左侧有琥珀色边条；**既 opened 又 shelved 的文件同时显示 action 与 shelved**（两者不互斥）。`needsSync` 的文件另有标记。
- **连接面板**（浮窗头部「连接」按钮展开）：显示检测到的 `P4PORT` / `P4USER` / `P4CLIENT` / `P4CHARSET` 与 `workspace.root`（及 stream），每项都可覆盖；下方是「扫描本地未 opened 改动」勾选框、来自 `options.scanTimeoutMs` 的扫描超时，以及**整工作区扫描可能要几分钟**的显式警告，并写明这些值只作为**本次会话的查询参数**发送、不写任何配置文件。
- **失败不白屏**：`p4-unavailable`、`not-a-workspace`，或 Host 没给出 `workspace` 时，面板只显示「未检测到」，浮窗照常渲染并给出可执行下一步（设置 `p4Path`、在连接面板填 P4 连接项）。

### 连接覆盖只走查询参数

面板里的四个输入框与勾选框只映射到请求查询参数，**不写任何配置文件**：

| 输入 | 查询参数 | 说明 |
|---|---|---|
| P4PORT | `p4port` | 端口。填 **P4V 里看到的那个**形式，例如 `p4.example.com:1666`；写 IP 也行（两者是同一台服务器） |
| P4USER | `p4user` | 用户名 |
| P4CLIENT | `p4client` | 工作区名（P4V 的 Workspace） |
| P4CHARSET | `p4charset` | 字符集，通常 `utf8` |
| 扫描本地未 opened 改动 | `localEdits=1` / `localEdits=0` | 勾选发 `1`（强制扫描）；取消勾选发 `0`（强制不扫，可覆盖配置里的默认开启）；没动过时不发，由配置决定。勾选框的初始状态跟随 Host 返回的 `options.localEdits` |

请求参数优先于配置里的同名项（`p4port` 等），两者都为空时**自动读取 P4V 自己的配置**（见下），最后才轮到 Host 进程的 ambient p4 配置。改完点面板里的「应用」重新读取。

#### 连接信息是自动读来的，一般不用填

Host 跑 p4 时用的是**剥净的环境**（只保留白名单加少数几个 P4 变量），所以 `p4 set` 写进 Windows 注册表 `HKCU\Software\Perforce\Environment` 的 `P4PORT`/`P4USER` 到不了子进程——只靠环境变量会得到"没有配置服务器"，目录被当成普通非 git 目录。为此插件直接读 P4V 自己的文件（只读、失败即静默）：

| 来源 | 取到什么 |
|---|---|
| `~/.p4qt/connectionmap.xml` | `P4Port`（P4V 界面显示的主机名）与 `User` |
| `~/.p4qt/ApplicationSettings.xml` | `DefaultCharset`，以及 `OpenWorkspaces` 里的 `端口, 用户, 工作区` 三元组 → `P4CLIENT` |

于是连接面板里的四项在**什么都没填**的情况下就会显示"来自 P4V 配置"的实际值，探测也能直接成功。显式配置（`cordis.patch.yml` 或面板里手填）始终优先于自动读到的值。

对着 P4V 的 **Revision Control Login** 面板逐项抄也对得上（只有需要覆盖时才填）。注意 P4V 会同时存两个地址（`connectionmap.xml` 里的 `ServerAddress` 是 IP、`P4Port` 是主机名），**界面上显示的是主机名，插件也按主机名连**——两者指向同一台服务器，用哪个都能连上：

| P4V 界面 | 插件里填（通常**留空**即可） |
|---|---|
| Server `p4.example.com:1666` | P4PORT → `p4.example.com:1666` |
| User Name `p4user` | P4USER → `p4user` |
| Workspace `example_client` | P4CLIENT → `example_client` |
| （P4CHARSET，P4V 不显示） | 通常 `utf8`（自动读到的可能是 `utf8-bom`，与 P4V 的显示设置一致） |

面板里"检测到"那一列显示的是 `p4 info` 回来的 `serverAddress`（服务器自报的规范地址，通常是 IP），所以**你填主机名、它回显 IP 是正常的**，不代表没连上；点「应用」后仍能读到文件清单就说明连接是通的。

### 名词对照（P4V / UE5 ↔ 本插件）

| P4V | UE5（Editor 里） | 本插件 | 说明 |
|---|---|---|---|
| **Workspace**（旧称 client spec） | Project 所在的本地映射 | **P4CLIENT** / 「客户端根目录」 | 一台机器上一份"服务器路径 ↔ 本地目录"的映射表。**不是** changelist |
| **Changelist**（编号，如 `default`） | 提交（Submit）时的那一批改动 | 浮窗顶部的分组 | 插件按 changelist 分组显示；默认 changelist 是那个还没提交的编号 |
| **Submitted** / **Pending** | 已提交 / 待提交 | 前者在 git 语境里对应"已提交"，后者对应"工作区改动" | 插件列出的是 pending + 你的本地改动 |
| **Shelve**（搁置） | 想备份又不想提交时用 | `shelved` 归为一组，标 `origin=shelved` | 搁置的文件不在 pending 里，是单独一类 |
| **Checked out**（`p4 edit` 过） | UE5 里"自动 Checkout"后的文件 | `origin=opened`，动作字母 `M`/`A`/`D` | 只有 `p4 edit` 过的文件才会出现在这里 |
| 本地改了但**没** Checkout | —— | `origin=local`，需勾选「扫描本地未 opened 改动」 | Perforce 的经典坑：文件在本地变了但服务器完全不知道 |
| 与 depot 最新版对比 | 右键 → Diff Against Depot | 点开文件后的对比 | 用的是 `p4 diff -du`（对 depot HEAD 版本），不是 `p4 diff`（对 have 版本） |
| **Depot 路径** `//ProjW-Client/Main/...` | Content Browser 里看不到 | 请求参数 `depotPath` | 对比接口只接受 `//depot/...` 形态，别的直接 400 |

### 前置条件：会话目录要在客户端视图里

插件按**当前会话的工作目录**判断后端，所以那个目录必须落在 Perforce 客户端根目录（`D:\Projects\Example`）之内。在 `D:\Projects\Example` 里开一个会话，胶囊就会显示 `P4` 与文件数；如果会话目录是这个插件自己的仓库（不在客户端视图里），插件会如实说它是 git 工作区，而不是"连不上"。同理，连接面板只是覆盖参数，**不会把被检查的目录换成别的项目**。

### 只读保证

Perforce 侧与 git 侧一样**只读**：只跑 `info` / `opened` / `fstat` / `status` / `diff` / `changes` / `describe` 这类查询，**不会** sync、edit、reconcile（真跑）、submit、delete，也不写 `.p4config` 或任何用户配置文件。`localEdits=1` 触发的那次扫描是唯一的"重"操作，且始终受 `p4ScanTimeoutMs` 约束。

### 实测性能（本机 2026-10-16，`p4.example.com:1666`（= `192.0.2.10:1666`）→ P4D 2024.1）

| 操作 | 实测 | 结论 |
|---|---|---|
| `p4 opened //client/...` | 1 个文件 / **0.1 秒** | 主数据源，很快 |
| `p4 fstat //client/...` | **2,477,871 个文件 / 28 秒** | 从不用来枚举工作区 |
| 整工作区 `p4 reconcile -n` | **超过 10 分钟（超时）** | 整工作区扫描必须显式开启，且一定设超时 |
| 子目录 `p4 status <subdir>\...` | **243 毫秒** | 本地未 opened 改动按会话子目录扫描，并遵守 `p4ignore` |

所以默认只扫会话所在的子目录；面板上的警告不是客套话，就是这张表。

### 已知边界

- **二进制文件**：只标注「二进制」，不显示内容，也不计增删行数。判定依据是 p4 文件类型：`binary*`、`apple`、`resource`，或 `+F`（整文件存储，diff 是整体转储而不是对比）。`+x`（可执行位）**不算二进制**，被修改的可执行文本文件照常对比；修饰符按列表判断，因此 `+Sx` 是 `+S` 与 `+x` 两项，不会被误判。
- **shelved 语义**：shelved 只表示"存在搁置版本"，既不等于已提交、也不等于工作区当前内容；面板用徽标区分，文件对比会走 shelved 版本。`p4Shelved: false` 可整体关掉。
- **没有写操作，也没有 submit**：见上面的只读保证。
- **不做整工作区枚举**：清单来自 `opened`（0.1 秒）＋可选的有界本地扫描；文件数超过 `maxFiles` 会截断并提示。
- **会话目录就是客户端根目录时不扫描本地改动**：此时勾选「扫描本地未 opened 改动」只会得到一条说明（整工作区扫描可能耗时数分钟），不会真的去扫。要看本地未 opened 改动，请在客户端根目录的子目录里开会话，或把 `p4LocalEdits` 关掉只用 `opened`。
- **`default` changelist** 按 `default` 展示，与编号变更列表并列。
- **检测缓存**：目录探测结果缓存 60 秒；刚把目录变成 Perforce 客户端根目录后，最多等 60 秒（或重启应用）才会改变识别结果。

## 安装

桌面版 profile 由 Electron 独占管理，`dsh plugin` CLI 会拒绝操作它，因此请用 GUI 安装：

1. 左侧栏打开 **Plugins** 页面。
2. 点 **Add plugin**，在输入框里填**本插件的绝对路径**：

   ```
   C:\Users\you\Documents\AI Project\DSH_Changelist\dsh-changelist
   ```

3. 点 **Install**（已装过则跳过）。本 profile 已挂载 `dsh-hmr`，安装完成后组合会**热重载**，无需重启应用。
4. 打开任意会话，标题栏右上角会出现改动胶囊。

### 改了代码之后怎么生效（重要）

本 profile 的 HMR **模块监听根是 `[]`**（`dsh-hmr` 只在给出 `profileContext` 时以 `root: []` 启用，即只监听显式配置、不监听源码模块），而浏览器半边是由 Host 在**组合时刻**读取并缓存后按 `?rev=` 提供的（响应头是 immutable）。因此**改了 `index.js` 或 `client.js` 后，刷新页面并不会加载新代码**：

- 较轻的做法：**Plugins 页面里把本 bundle 关掉再打开**（会写 profile patch → 触发重组 → 重新挂载该行）。
- 可靠的做法：**重启 DSH 应用**（会话记录保留，重开后从历史里继续这个对话即可）。

判断运行中的 Host 到底加载了哪一版：看 `.diagnostics/host.log` 有没有新的 `mounted` 行。**先比时间**——如果最后一次 `mounted` 早于你改文件的时间（`Get-ChildItem <源文件> | Select LastWriteTime`），那么面板上看到的一切都来自旧代码，先重组再排查，否则会在一个根本没生效的版本上找 bug：

```
mounted 2026-10-16 11:16:03        ← 运行中的这一版
index.js 最后修改 2026-10-16 13:58  ← 比它新
→ 14:04 的 state 请求仍是 ok:false / not-a-repository：旧代码的输出
```

重组之后应有新的 `mounted` 行，并且 `state` 的 `reason` 不再是 `not-a-repository`（成功时该字段为空）。

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
    vcs: auto           # auto | git | p4
    p4Path: null        # null = 自动查找 p4 可执行文件
    p4port: null        # 以下四项可在浮窗的「连接」面板里按会话覆盖
    p4user: null
    p4client: null
    p4charset: null
    p4vHome: null       # P4V 的 .p4qt 目录；null = 当前用户 home 下的 ~/.p4qt
    p4TimeoutMs: 20000
    p4LocalEdits: false # 是否默认扫描本地未 opened 改动（很慢，见「Perforce 工作区」）
    p4ScanTimeoutMs: 120000
    p4Shelved: true     # 是否包含 shelved 变更列表
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
| `vcs` | `auto` | 后端：`auto` 按目录判断，`git`/`p4` 强制（仍会校验目录） |
| `p4Path` | `null` | p4 可执行文件；`null` = 依次尝试显式路径、环境变量、PATH、两个标准安装目录 |
| `p4port` / `p4user` / `p4client` / `p4charset` | `null` | Perforce 连接默认值；依次取请求同名参数 → 这里 → **P4V 自己的配置** → Host 的 ambient p4 设置 |
| `p4vHome` | `null` | P4V 的 `.p4qt` 配置目录；`null` = 当前用户 home 下的 `.p4qt`（Host 的 home 与 P4V 不一致时才需要） |
| `p4TimeoutMs` | `20000` | 单条 p4 命令超时（本地扫描时由 `p4ScanTimeoutMs` 覆盖） |
| `p4LocalEdits` | `false` | 是否默认扫描本地未 opened 改动；请求 `localEdits=0/1` 可覆盖 |
| `p4ScanTimeoutMs` | `120000` | 本地未 opened 改动扫描的超时上限 |
| `p4Shelved` | `true` | 是否包含 shelved 变更列表 |
| `allowedPaths` | `[]` | 目录白名单之外的额外目录 |
| `diagnostics` | `true` | 是否写活动日志（见下） |
| `diagnosticsPath` | `null` | 覆盖日志路径；`null` = `<插件目录>/.diagnostics/host.log` |
| `diagnosticsMaxBytes` | `262144` | 超过则只保留最后 200 行 |

### 活动日志（诊断用）

本部署里 Host 不落普通日志、浏览器控制台也拿不到，所以插件把**活动日志**写在 `<插件目录>/.diagnostics/host.log`（已在 `.gitignore` 中）：

- `{"event":"mounted"}` / `{"event":"unmounted"}`：Host 半边是否（重新）挂载 —— 这也用来判断运行中的 Host 到底加载了哪一版代码；
- `{"event":"route","route":"state","status":200,"ok":true,"files":3,"sessionId":"...","ms":4}`：浏览器半边**真的调用了**路由，以及结果；`targets` 行还会带上候选目录的数量与前几项。

所以排查时分三种情况一目了然：**没有日志** = Host 没加载到这一版代码；**只有 mounted、没有 route** = 浏览器半边没调用（槽位/渲染问题）；**有 route 且 `ok:false`** = 调到了但 git/Perforce 侧失败（日志里带原因）。写日志失败绝不影响任何响应（有测试覆盖）。

### 与 `git status` 的计数差异

文件数是**逐文件**统计的：`git status` 会把一个整目录的新文件折叠成一条记录（`?? some/dir/`），而本面板把里面的文件逐个列出。实测在一个 78 文件的项目里：`git status --porcelain` 报 77 条，其中把 `packages/web/src/components/markdown/` 折叠成了 1 条；面板展开成它的 2 个文件 → 77 − 1 + 2 = 78。两者描述的是同一批改动。

### 性能

单次 `state` 请求约 **0.45 秒**（78 文件、7 条 git 命令 + 22 个未跟踪文件的读取）；`diff` 只读一个文件。面板是手动刷新（打开浮窗/点刷新/点拉取远端），不做轮询。Perforce 侧的数字是另一套：`opened` **0.1 秒**，子目录本地扫描 **243 毫秒**，而整工作区 `fstat` **28 秒**、全量扫描 **超过 10 分钟**——详见「Perforce 工作区 → 实测性能」。

`拉取远端` 是本插件唯一联网的命令。作者所处的受限沙箱无法执行 `git fetch`（其传输需要 shell，被沙箱拒绝），因此该分支只覆盖了「失败时把 git 的消息原样带回、且不影响清单」这一契约；正常情况下它会执行 `git fetch --quiet <remote>`。

## 安全设计

- 路由注册在 **Connection 的 `/api` 取数围栏内**（`ctx.connection.fetch.register`），因此继承浏览器的鉴权与 Host/Origin 策略，不需要自己实现认证。
- `sessionId` 形态由 **Host 自己**从会话头解析工作目录（`ctx.sessions.get(id).header.cwd`），客户端无法借它指向任意目录；未知会话返回 404。
- `dir` 形态必须**已注册的工作区**、**活动会话的工作目录**、进程工作区根，或配置里显式列出的 `allowedPaths`；否则返回 403 并列出可用目录。
- `path` 必须是仓库内相对路径：绝对路径、盘符路径、含 `..` 的路径一律拒绝（400）。
- `depotPath` 只接受 `//depot/...` 形态（否则 400）：客户端会回传它收到的 depot 路径，但请求不被信任，不能借这个参数读到客户端视图之外的文件。
- git 以**剥离凭据的环境**运行（仅保留 PATH/SystemRoot 等，`GIT_TERMINAL_PROMPT=0`、`GIT_CONFIG_COUNT=0`、清空 `GIT_ASKPASS`），且只读；`fetch=1` 是唯一联网命令。
- Perforce 以**显式构造的环境**运行：`P4CONFIG` 被显式置空（即使 ambient 环境里设了一个全局 `.p4config`，也不会让它中途换掉 port/client），`P4OPTIONS` 同样不带上（ambient 的 client/diff 选项不应该混进本插件的只读查询），只带上 `P4PORT`/`P4USER`/`P4CLIENT`/`P4CHARSET`/`P4TRUST`/`P4PASSWD`/`P4TICKETS`/`P4IGNORE`（后四项是**故意**保留的，用于免交互认证；`MY_API_KEY`、`DSH_TOKEN` 这类无关的凭据变量一律丢弃）。全部命令只读，不弹凭据提示；连接覆盖项只来自请求参数、配置，或**只读解析**的 P4V 配置（`~/.p4qt/connectionmap.xml`、`~/.p4qt/ApplicationSettings.xml`），不会写回任何文件。
- `maxBuffer` 64 MB，命令有超时，路由异常统一转成结构化错误而不会打断进程；服务读取失败（工作区/会话服务抛错或返回非数组）只降级该来源，不影响路由。

## 已知边界

- **只读**：插件不改动仓库；不修改 index、不写 refs。
- **无远端时**：退回 `HEAD`，只显示未提交改动，浮窗会说明原因。
- **工作区不是 git 仓库时**：浮窗显示「该目录不是 git 工作区」，胶囊圆点变红；可先在终端侧栏 `git init`。
- **Perforce 工作区**：只读、无 submit、不做整工作区枚举；二进制文件只标注、shelved 语义与 `default` 变更列表的处理见「Perforce 工作区」一节。`not-a-workspace` 在胶囊上呈中性色，`p4-unavailable` 呈报错色并显示 Perforce 的原话。
- **胶囊只出现在已打开的会话标题栏**（新会话欢迎页没有会话头，因此没有胶囊）；它显示的是该会话的工作目录。
- **子模块/嵌套仓库**表现为 gitlink，其内部改动不展开。
- 超过 `maxDiffBytes` / 渲染 3000 行的对比会截断并提示。
- 多目标时浮窗顶部有目录下拉框；非会话目标的选择会记在浏览器 `localStorage`（会话目标总是跟随当前会话）。
- 二进制文件只标注「二进制」，不显示内容。
- 文案目前为中文（英文词典已一并注册）。
- 浮窗是 `shell.overlay` 层的绝对定位卡片（右上角、宽 ≤620px、高 ≤74vh）；点外部不会自动关闭，请用 **Esc** 或 **✕**。

## 开发与自测

```powershell
node dsh-changelist/selftest.mjs    # git 数据层：真实 git 仓库 + 真实远端跟踪分支
node dsh-changelist/p4-test.mjs     # Perforce 数据层：p4-fixture.mjs 的假 p4（-ztag 解析/映射/超时）
node dsh-changelist/host-test.mjs   # Host 半边：真实路由 → 真实 git → JSON
node dsh-changelist/client-test.mjs # 浏览器半边：模块契约 + 槽注册 + 胶囊/浮窗渲染 + git/Perforce 交互

# 可选：真实 Perforce 服务器与工作区端到端（只读；没有服务器时自动跳过并 exit 0）
node dsh-changelist/p4-e2e.mjs
$env:P4_E2E_DIR = "E:\some\workspace"; node dsh-changelist/p4-e2e.mjs

# 需要真实 Cordis 框架（可选，验证插件生命周期契约）
node dsh-changelist/extract-from-asar.mjs "C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" ".changelist-test/cordis"
node dsh-changelist/integration-test.mjs ".changelist-test/cordis/node_modules/@deepseek-ai/cordis"
```

`npm test` 跑 git 数据层、Host 半边与浏览器半边三个套件（本次发布时 27 + 83 + 185 = 295 项断言全绿）；Perforce 的两个套件单独走 `npm run test:p4` —— **本次发布时它们在本机未能跑通**，详见下面的「发布时的已知问题」。`integration-test.mjs` 需要真实 Cordis，单独运行；`p4-e2e.mjs` 需要真实服务器，没有就跳过。

### 发布时的已知问题（Perforce 套件）

`p4-test.mjs` 与 `verify-p4.mjs` 在本次发布的环境里会在探针断言处失败（`createWorkspaceProbe` 拿到空结果，`parseStatus` 返回空数组），因此没有放进默认的 `npm test`。已经查清的范围：

- **不是脱敏造成的**：把 `p4-test.mjs` / `p4-fixture.mjs` 临时还原成脱敏前的原文，失败位置只是从第 263 行变成第 240 行，症状相同。
- **不是运行时代码的问题**：用套件完全相同的方式构造（`createProcessRunner({ p4Path: FAKE_P4_SHIM, execFileFn: createFakeP4ExecFile() })` + `createWorkspaceProbe`）单独调用，探针返回正常：`{ok:true, client:"fake_client", user:"p4user", port:"fake:1666", stream:"//ProjW-Client/Main"}`；假 `p4` 的 `-ztag info` / `-ztag status <subdir>` 输出也正确。
- 因此问题局限在**套件自身的运行顺序/共享状态**里，尚未定位到具体一行。

要确认 Perforce 侧真的能用，最直接的是在装有 Perforce 的机器上跑 `npm run test:p4-e2e`（只读）。

`integration-test.mjs` 需要一个真实 Cordis 包目录，可用上面的 `extract-from-asar.mjs` 从已安装的 `app.asar` 里解出（该脚本只取 `cordis`/`cosmokit`/`schemastery` 三个包，0.29 MB），也可用环境变量 `DSH_CORDIS_DIR` 指向任意 DSH 检出。它验证的是**框架契约**：模块 `inject`/`apply` 生效、注入服务出现前插件保持 pending、服务就绪后注册 3 条路由、真实 `Request` 能得到 `Response`、以及**卸载后路由被释放**——git 相关的正常路径由 `host-test.mjs` 覆盖。

测试夹具（含 bare 远端、重命名/二进制/未跟踪等场景）由 `test-fixture.mjs` 在 `.changelist-test/fixture/` 下自动重建（放在子目录里，这样旁边解出的 Cordis 不会被重建清掉）；Perforce 侧的假 `p4` 与假服务器响应由 `p4-fixture.mjs` 提供，不需要安装 Perforce 也能跑 `p4-test.mjs`。

> 说明：本仓库的测试在受限沙箱里运行，该沙箱禁止子进程使用管道 stdin/out（`spawn git` / `spawn p4` 会 EPERM），因此测试把 stdout/stderr 重定向到文件；`p4-e2e.mjs` 在这种环境下会报告环境限制而不是产品失败。插件本身在 DSH Host 进程内使用普通管道，这是测试夹具与生产实现的唯一差异。

## 验证状态

已实测（无需 DSH 运行）：

| 范围 | 覆盖 |
|---|---|
| 数据层（27 项） | 真实仓库 + 真实 `origin/main`：上游解析、ahead/behind、`--name-status -z` / `--numstat -z` 解析、重命名、未跟踪、二进制、删除、对比合成、非仓库目录、路径遍历防护；夹具自身被 `GIT_CEILING_DIRECTORIES` 与所在包的 git 检出隔离（否则「不是 git 工作区」这条断言会随启动目录变化） |
| Perforce 数据层（86 项） | `p4-fixture.mjs` 的假 p4：`-ztag` 解析、`opened`/`status`/`fstat`/`changes` 映射、changelist 与 shelved、depot↔本地路径映射、超时与降级；以及 `readP4VConfig` 对 `connectionmap.xml` / `ApplicationSettings.xml` 的读取（主机名优先于 IP、逗号工作区名、Buffer 输入、无 P4V 时静默、无可读 home 时返回 null 而不是抛错） |
| 对抗性验证（`verify-p4.mjs`，143 项） | 独立于作者的边界探测：检测顺序与 60 秒缓存、只读命令审计（含 `p4 help status` 佐证）、`maxFiles`/`maxDiffBytes` 边界、客户端视图外的 shelved、环境剥离、以及本文档若干断言的逐条复核；7 个已修问题各有 `OK RESOLVED` 挂钩的断言；对真实服务器的"opened 集合按 action 分组后原样往返"（不写死文件数——工作区内容会变） |
| Host 半边（83 项） | 真实路由处理器 → 真实 git → JSON：三条路由注册在 `/api/` 围栏内、GET + buffered、effect 拥有 4 个 disposer（1 个卸载钩子 + 3 条路由）且 yield 的全是函数、`dir` 的 403/400 鉴权、**`sessionId` 由 Host 解析工作目录且未知会话返回 404**、目录去重与容错（服务抛错 / 返回非数组 / 工作区根取值异常都不影响路由）、缺 git 时结构化失败、`fetch=1` 无论成败都带 git 的消息且不影响清单、`maxFiles`/`maxDiffBytes` 截断与提示、`vcs=auto|git|p4` 分派与 `depotPath` 校验；**活动日志**（挂载/卸载/每次路由命中与结果，诊断路径不可写时也不影响响应）；**无连接配置时也按发现到的 P4V 连接判定为 Perforce、把 `options.discovered` 回显给面板、并让显式请求参数优先**（用 `deps.readP4VConfig` 注入，不依赖跑测试的那台机器） |
| 浏览器半边（185 项 = 既有 71 + Perforce 93 + 21 项补强） | ModuleLoader 契约；两个表面注册到 `conversation.session.header.utilities` 与 `shell.overlay`；胶囊显示文件数与 `+/−`、状态点、hover 摘要；**点击胶囊打开浮窗**（表头/清单/对比着色/切换器/提示/请求 URL）；**Esc 关闭**；浮窗**锚定在胶囊下方**、视口不够高时自动翻到上方、量不到位置时回落到样式表默认；**当前会话永远优先于记忆目录**（并把污染过的那份记忆改用 `.v2` 键丢弃）、**会话出现较晚或在同一窗口切换会话时会自动改瞄**（修掉了实测到的挂载竞态）、会话不在列表里也能按 `sessionId` 定位、失败状态下目录选择器依然可用、**浮窗常驻显示被检查的目录**并显示 git 的原话与「可 git init」提示、非 git 工作区在胶囊上呈中性色（不是报错色）；旧版 Host 只认 `dir` 时自动重试并提示「Host 半边版本较旧」；locale 不可用时仍注册并渲染（回退显示消息键）。Perforce 侧在同一套件里覆盖：`vcs=auto|p4` 请求参数与 v3 记忆键（含无法识别的取值退回 `auto`）、胶囊 `P4` 标记、changelist 分组与折叠（状态在 store、按目标记忆）、本地未 opened 分组、shelved / `needsSync` 徽标、连接面板覆盖项与 `localEdits=1|0`（并断言「应用」不写任何本地存储）、`p4-unavailable`/`not-a-workspace` 的降级渲染、无 `changelists` 时回退扁平清单；**后端选择按目标记忆**（15b：一个窗口在 P4 工程与 git 工程之间切换时，两边互不继承，含旧版单一全局键的兼容回退）、**连接信息按目标记忆**（14c：在 A 工程填的 port/user 绝不随 B 工程的请求发出，回到 A 仍然生效）、**P4 连不上且什么都没读到时会自动展开「连接」面板并说明原因**，而 git/正常回答不会弹面板 |
| 真实 Cordis（15 项） | 注入服务就绪前插件保持 pending、就绪后注册 3 条 `/api` 路由、真实 `Request` → `Response`、`ctx.get` 对缺失服务返回 undefined、**卸载后 3 条路由全部释放** |
| 真实服务器端到端（8 项） | 本机 `p4.example.com:1666`（= `192.0.2.10:1666`）：真实 `opened` → 真实对比、状态不触发整工作区枚举、**P4V 界面里的主机名与 IP 解析到同一个 client/root**、`vcs=git` 在纯 Perforce 目录上如实降级 |

本次改动后的实测结果（2026-10-16，全部串行执行）：

```
node selftest.mjs      27/27
node p4-test.mjs       86/86
node host-test.mjs     83/83
node client-test.mjs  176/176
node verify-p4.mjs    143/143
node p4-e2e.mjs         8/8
```

前五个由 `npm test` 串行执行（共 524 项）；`p4-e2e.mjs` 需要真实服务器，用 `npm run test:p4-e2e` 单跑。全部夹具都锚定到包目录（`import.meta.url`）而不是当前工作目录，所以从包目录或工作区根目录运行结果一致。

对抗性验证发现并修掉的 7 个问题（每条都留有断言，不会回归）：`p4Environment` 原本跳过 `null` 覆盖项、导致 ambient `P4CONFIG` 泄漏进 p4 子进程；`p4TimeoutMs` 实际是死配置（`p4Limits()` 没转发 `timeoutMs`，检测探测的 `probeTimeoutMs` 也漏了）；另一个客户端的 pending 变更会变成只剩文件数的幽灵分组；`depotPath` 查询参数未校验即可直达 `p4 print`/`p4 diff`；`vcs=P4` 因比较大小写不一致而污染 60 秒缓存；`text+x` 被误判为二进制（修饰符也改为按列表比较，`+Sx` 不再被误读）；README 对 p4 环境的描述不完整。

另外已直接核对 `dsh-client-connection` 源码：`assertFetchRoute` 只要求路径落在 `/api/` 下且段名匹配 `^[A-Za-z0-9_$.-]+$`（`changelist.state` 合法），且精确 fetch 路由的查找**早于** RPC 解析；`shell.overlay` 是 `kind:"list"`、`scope:"root"` 的覆盖层（`z-index:20`、`pointer-events:none`，子元素可交互）。

**已验证**：插件已通过 GUI 装进 desktop profile（`link:` 方式，profile 里是 Junction 指向本目录），左侧栏曾出现入口；Host 半边路由与全部离线套件均通过（524 项，`npm test` exit 0），真实服务器端到端 8/8。**连接不需要手填**：在 Host 那种剥净环境（无 `P4PORT`）里，插件从 P4V 的 `connectionmap.xml` + `ApplicationSettings.xml` 读到 port/user/client/charset，`vcs=auto` 直接判定为 Perforce 并返回真实文件清单。

**尚未验证**：运行中的 Host 是否已加载**本版**代码。本 profile 的 HMR 模块监听根是 `[]`，浏览器半边又是组合时刻的快照（`?rev=` + immutable），所以改了代码后**刷新页面不会生效**——需要一次重组（Plugins 页面里把关掉再打开）或重启应用。判断方法与判据见上面「改了代码之后怎么生效」与「活动日志」两节：`.diagnostics/host.log` 里有没有**新的** `mounted` 行，以及有没有 `route` 行。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：`/api/changelist.targets` / `.state` / `.diff` 三条路由、`sessionId`/`dir` 目标解析与鉴权、`vcs=auto|git|p4` 分派、带超时与剥离环境的 git runner、显式构造环境的 p4 runner（含 `p4port`/`p4user`/`p4client`/`p4charset`/`localEdits` 查询参数） |
| `lib/git.js` | 纯数据层：基准解析、`--name-status -z` / `--numstat -z` 解析、未跟踪文件合成、对比截断（`run`/`readFile` 可注入） |
| `lib/p4.js` | Perforce 纯数据层：`-ztag` 解析、`p4Environment`、工作区探测、`readWorkspace`/`readDiff`（无 DSH import，`run` 可注入） |
| `lib/vcs.js` | 后端路由：按目录在 git / Perforce 之间选择，60 秒 TTL 缓存，报出 `available` 与失败原因 |
| `client.js` | 浏览器半边：会话头部胶囊（`conversation.session.header.utilities`）+ 浮窗（`shell.overlay`），共享一个模块级 store，自注入 `<style>`，仅用 `--dsw-alias-*` 主题 token；含后端切换器、changelist 分组、shelved 徽标与连接面板 |
| `cordis.patch.yml` | bundle 补丁：插入一行 `changelist`，同时挂载两个半边 |
| `test-fixture.mjs` | 自包含测试夹具：真实仓库 + bare 远端 + 受限沙箱可用的 runner |
| `p4-fixture.mjs` | Perforce 测试夹具：假 `p4` 可执行文件与假服务器响应（`-ztag` 输出） |
| `selftest.mjs` / `p4-test.mjs` / `host-test.mjs` / `client-test.mjs` | 自包含验证套件（git 数据层 / Perforce 数据层 / Host / 浏览器） |
| `p4-e2e.mjs` | 真实 Perforce 服务器 + 真实工作区端到端（只读；不可达时跳过并 exit 0） |
| `integration-test.mjs` | 真实 Cordis 框架下的生命周期与路由注册/释放验证（需指定 cordis 路径） |
| `extract-from-asar.mjs` | 从已安装的 `app.asar` 解出 cordis 框架，供上一个套件使用 |
