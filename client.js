/**
 * Browser half of the workspace-changelist plugin.
 *
 * Two surfaces, one store:
 *   - a compact **chip** in the session header's top-right utilities that shows
 *     the current workspace's change count and added/deleted lines;
 *   - a **floating summary** in the shell overlay layer, opened by the chip,
 *     listing the changed files and showing one file's comparison.
 *
 * The same two surfaces answer for **git and Perforce**: the chip carries a
 * backend marker, and the floating summary groups files by changelist with a
 * collapsible connection panel for per-session P4 overrides.
 *
 * Plain-JS ModuleLoader lane: no bundler, no Harness Client package imports.
 * Styling uses only `--dsw-alias-*` theme tokens (with literal fallbacks) and
 * one `<style>` tag owned by this plugin's effect.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-changelist',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-changelist'
    const CHIP_ID = 'changelist.chip'
    const POPOVER_ID = 'changelist.popover'
    const ATTENTION_PILL_ID = 'changelist.attention.pill'
    const ATTENTION_PANEL_ID = 'changelist.attention.panel'
    // v2: the first version remembered a directory that could then outrank the
    // session the chip was rendered in, so that memory is deliberately dropped.
    const STORAGE_KEY = 'dsh-changelist.dir.v2'
    // v3: the backend switcher (自动/git/Perforce). It is only ever a request
    // parameter — the current session target still outranks it and any memory.
    const VCS_KEY = 'dsh-changelist.vcs.v3'
    const VCS_VALUES = ['auto', 'git', 'p4']
    const DEFAULT_VCS = 'auto'
    const BASE = 'api/changelist'
    const MAX_RENDER_LINES = 3000
    const GROUP_DESC_MAX = 140

    const zh = {
      panel: '工作区改动',
      summary: '置顶摘要',
      refresh: '刷新',
      fetchRemote: '拉取远端',
      close: '关闭',
      wrapping: '自动换行',
      noWrap: '不换行',
      loading: '正在读取改动…',
      loadingDiff: '正在读取对比…',
      clean: '工作区干净',
      cleanAgainst: '与 {base} 无差异',
      notRepo: '该目录不是 git 工作区',
      notRepoChip: '非 git 工作区',
      noTargets: '还没有可用的工作区或会话目录',
      files: '{count} 个文件',
      shortFiles: '{count} 个文件',
      ahead: '领先 {count}',
      behind: '落后 {count}',
      untracked: '未跟踪',
      binary: '二进制',
      truncated: '内容过长，仅显示前 {count} 行',
      missing: '这轮改动的内容已不可用',
      createdAt: '新建',
      deletedAt: '删除',
      unchanged: '两侧内容相同',
      added: '新增',
      deleted: '删除',
      chooseFile: '点击左侧文件查看代码改动',
      fetchOk: '已拉取 {remote}',
      fetchFailed: '拉取 {remote} 失败：{message}',
      allowed: '可用的目录：',
      error: '读取失败：{message}',
      hint: '点击查看工作区改动',
      directory: '目录',
      updatedAt: '{time} 更新',
      copyHint: '双击复制路径',
      copiedPath: '已复制路径',
      copyFailed: '复制失败，请在文件列表上手动选择路径',
      notRepoHint: '这里是当前会话的工作目录；若它还没有版本库，可在终端里执行 git init。',
      oldHost: 'Host 半边版本较旧：已改用目录方式读取。重启 DSH 可加载新版 Host 半边。',
      // ── Perforce ────────────────────────────────────────────────────────
      backend: '后端',
      autoBackend: '自动',
      gitBackend: 'git',
      p4Backend: 'Perforce',
      markGit: 'git',
      markP4: 'P4',
      notWorkspace: '该目录不是 Perforce 工作区',
      notWorkspaceChip: '非 Perforce 工作区',
      notWorkspaceHint:
        '这里是当前会话的工作目录；若它应当是 Perforce 客户端，请在下方「连接」里填写 P4PORT/P4USER/P4CLIENT，或在配置里给出 p4Path。',
      p4Unavailable: 'Perforce 不可用',
      p4UnavailableHint: '找不到或无法运行 p4 可执行文件；请在配置里设置 p4Path，或在终端确认 p4 在 PATH 中。',
      askAfterP4V: '已从 P4V 的本地配置读到服务器 {port}、用户 {user}，但连不上。请确认这些值，或在下面覆盖后点「应用」。',
      askNothingFound: '没能从 P4V 的本地配置读到连接信息（connectionmap.xml / ApplicationSettings.xml）。请手动填写下面四项，或先在 P4V 里连一次。',
      changelists: '变更列表',
      changelistCount: '{count} 个变更列表',
      changeN: '变更 {number}',
      defaultChange: 'default',
      localGroup: '本地未 opened 改动',
      localGroupDesc: '不在任何 changelist 中的本地改动',
      noDescription: '（无描述）',
      shelved: 'shelved',
      shelvedFiles: '含 shelved 文件',
      opened: 'opened',
      notOpened: '未 opened',
      needsSync: '需同步',
      collapse: '收起',
      expand: '展开',
      connection: '连接',
      connectionTitle: '连接（仅本次会话生效）',
      clientRoot: '客户端根目录',
      stream: 'stream',
      detected: '检测到',
      detectedFromP4V: '来自 P4V 配置',
      notDetected: '未检测到',
      labelPort: 'P4PORT',
      labelUser: 'P4USER',
      labelClient: 'P4CLIENT',
      labelCharset: 'P4CHARSET',
      portHint: '服务器地址，例如 p4.example.com:1666',
      userHint: 'Perforce 用户名',
      clientHint: '工作区名（P4V 的 Workspace，不是 changelist）',
      charsetHint: '字符集，通常填 utf8',
      scanLocalEdits: '扫描本地未 opened 改动',
      scanTimeout: '扫描超时 {seconds} 秒',
      scanWarning:
        '警告：整工作区扫描可能要几分钟（本机实测工作区有 2.48M 个文件：fstat 一次 28 秒，全量扫描超过 10 分钟）。默认只扫描会话所在的子目录，并受上面的超时限制。',
      applyHint:
        '这些值只作为本次会话的查询参数发送（p4port / p4user / p4client / p4charset、localEdits=1），不写入任何配置文件；改完点「应用」重新读取。',
      applyOverrides: '应用',
      p4ReadOnly: '只读：不会 open/edit/submit，也不会写任何配置文件。',
      // ── attention（跨项目状态提示） ─────────────────────────────────────
      attentionPanel: '跨项目状态',
      attentionPillClear: '全部正常',
      attentionPillUnknown: '状态未知',
      attentionPillWaiting: '{count} 待处理',
      attentionPillError: '{count} 出错',
      attentionPillDone: '{count} 已完成',
      attentionPillRunning: '{count} 进行中',
      attentionCalloutWaiting: '工作区里有 {count} 个会话在等你',
      attentionCalloutError: '{count} 个会话本轮出错了',
      attentionEnableNotifications: '打开系统通知',
      attentionNotificationsOff: '系统通知未开启：改为在标题栏与侧栏提示',
      attentionNotificationsBlocked: '系统通知被拒绝；可在系统设置 › 通知 里允许本应用',
      attentionQuietLine: '只在别的会话需要你时提醒，正在看的会话不打扰',
      attentionWatching: '监视全部会话 · 每 {seconds} 秒',
      attentionEmpty: '所有会话都正常。别的会话完成的、出错的、或等你确认的，都会出现在这里。',
      attentionStaleRows: '以下是你最后一次读到的状态，可能已过期：',
      attentionUnknownHint: '读不到会话状态：可能 Host 半边是旧版（缺 /api/changelist.attention）或刚才那次读取失败了',
      attentionUnknownBody:
        '读不到会话状态，所以这里既不能说「全部正常」，也不能说「有事」。\n最常见的原因是运行中的 Host 半边还是旧版：本 profile 的 HMR 不监听源码，改完插件要在 Plugins 页面把该 bundle 关掉再打开（或重启 DSH），新的 /api/changelist.attention 路由才会注册。',
      attentionOpen: '打开',
      attentionNotInList: '不在列表',
      attentionNotOpenableHint: '这个会话不在当前窗口的会话列表里（{id}），无法直接打开。它可能已归档，或只属于另一个窗口。',
      attentionOpenedWorkspace: '已切到「{workspace}」：这个会话不能直接打开，请在该工作区的会话列表里选择',
      attentionOpenFailed: '打不开这个会话（{id}）：它不在当前窗口的会话列表里，刷新后仍找不到',
      attentionOpenFailedShort: '打不开',
      attentionMarkAllRead: '全部标记已读',
      attentionUnknownWorkspace: '未知工作区',
      attentionAgoJustNow: '刚刚',
      attentionAgoMinutes: '{count} 分钟前',
      attentionAgoHours: '{count} 小时前',
      attentionAgoDays: '{count} 天前',
      stateWaiting: '待处理',
      stateError: '出错',
      stateDone: '已完成',
      stateRunning: '进行中',
      stateIdle: '空闲',
      reasonApproval: '等待确认',
      reasonQuestion: '等待回答',
      reasonBlocked: '等待恢复',
      reasonTurnError: '本轮出错',
      reasonTurnEnd: '本轮完成',
      reasonTurnStart: '正在开始新一轮',
      reasonActivity: '正在执行',
      reasonUnknown: '状态变化',
      notifyWaitingTitle: '「{workspace}」等你确认',
      notifyErrorTitle: '「{workspace}」本轮出错',
      notifyDoneTitle: '「{workspace}」已完成',
      notifyBatchTitle: '{count} 个会话有更新',
    }
    const en = {
      panel: 'Workspace changes',
      summary: 'Pinned summary',
      refresh: 'Refresh',
      fetchRemote: 'Fetch remote',
      close: 'Close',
      wrapping: 'Wrap lines',
      noWrap: 'No wrap',
      loading: 'Reading changes…',
      loadingDiff: 'Reading comparison…',
      clean: 'Working tree clean',
      cleanAgainst: 'No differences against {base}',
      notRepo: 'Not a git working tree',
      notRepoChip: 'No git repo',
      noTargets: 'No usable workspace or session directory yet',
      files: '{count} files',
      shortFiles: '{count} files',
      ahead: '{count} ahead',
      behind: '{count} behind',
      untracked: 'untracked',
      binary: 'binary',
      truncated: 'Showing the first {count} lines',
      missing: 'This comparison is no longer available',
      createdAt: 'created',
      deletedAt: 'deleted',
      unchanged: 'Both sides hold the same lines',
      added: 'added',
      deleted: 'deleted',
      chooseFile: 'Choose a file on the left to see its code changes',
      fetchOk: 'Fetched {remote}',
      fetchFailed: 'Fetching {remote} failed: {message}',
      allowed: 'Available directories: ',
      error: 'Read failed: {message}',
      hint: 'Open the workspace changelist',
      directory: 'Directory',
      updatedAt: 'updated {time}',
      copyHint: 'Double-click to copy the path',
      copiedPath: 'Path copied',
      copyFailed: 'Copy failed; select the path in the list instead',
      notRepoHint: 'This is the current session’s working directory; run git init there if it has no repository yet.',
      oldHost: 'Older Host half: reading by directory instead. Restart DSH to load the current Host half.',
      // ── Perforce ────────────────────────────────────────────────────────
      backend: 'backend',
      autoBackend: 'Auto',
      gitBackend: 'git',
      p4Backend: 'Perforce',
      markGit: 'git',
      markP4: 'P4',
      notWorkspace: 'Not a Perforce workspace',
      notWorkspaceChip: 'No p4 workspace',
      notWorkspaceHint:
        'This is the current session’s working directory; if it should be a Perforce client, fill P4PORT/P4USER/P4CLIENT under “Connection” below, or set p4Path in the config.',
      p4Unavailable: 'Perforce unavailable',
      p4UnavailableHint: 'The p4 executable was not found or cannot run; set p4Path in the config, or check that p4 is on PATH.',
      changelists: 'Changelists',
      changelistCount: '{count} changelists',
      changeN: 'Change {number}',
      defaultChange: 'default',
      localGroup: 'Local edits (not opened)',
      localGroupDesc: 'Local edits that belong to no changelist',
      noDescription: '(no description)',
      shelved: 'shelved',
      shelvedFiles: 'has shelved files',
      opened: 'opened',
      notOpened: 'not opened',
      needsSync: 'needs sync',
      collapse: 'Collapse',
      expand: 'Expand',
      connection: 'Connection',
      connectionTitle: 'Connection (this session only)',
      clientRoot: 'Client root',
      stream: 'stream',
      detected: 'detected',
      detectedFromP4V: 'from P4V config',
      askAfterP4V: 'P4V’s local config gave the server {port} and user {user}, but the connection failed. Check these, or override them below and press Apply.',
      askNothingFound:
        'No connection could be read from P4V’s local config (connectionmap.xml / ApplicationSettings.xml). Fill in the four fields below, or connect once in P4V first.',
      notDetected: 'not detected',
      labelPort: 'P4PORT',
      labelUser: 'P4USER',
      labelClient: 'P4CLIENT',
      labelCharset: 'P4CHARSET',
      portHint: 'Server address, e.g. p4.example.com:1666',
      userHint: 'Perforce user name',
      clientHint: 'Workspace name (P4V’s Workspace, not a changelist)',
      charsetHint: 'Charset, usually utf8',
      scanLocalEdits: 'Scan local edits (not opened)',
      scanTimeout: 'Scan timeout {seconds}s',
      scanWarning:
        'Warning: a whole-workspace scan can take minutes (this workspace holds 2.48M files: one fstat takes 28 s and a full scan exceeded 10 minutes). Only the session’s subdirectory is scanned by default, and it stays bounded by the timeout above.',
      applyHint:
        'These values are sent as this session’s query parameters only (p4port / p4user / p4client / p4charset, localEdits=1); no config file is written. Press Apply to re-read.',
      applyOverrides: 'Apply',
      p4ReadOnly: 'Read-only: no open/edit/submit, and no config file is written.',
      // ── attention (cross-project status) ────────────────────────────────
      attentionPanel: 'All sessions',
      attentionPillClear: 'All clear',
      attentionPillUnknown: 'Status unknown',
      attentionPillWaiting: '{count} need you',
      attentionPillError: '{count} failed',
      attentionPillDone: '{count} finished',
      attentionPillRunning: '{count} running',
      attentionCalloutWaiting: '{count} session(s) are waiting for you',
      attentionCalloutError: '{count} session(s) ended with an error',
      attentionEnableNotifications: 'Enable system notifications',
      attentionNotificationsOff: 'System notifications are off: falling back to the title and sidebar',
      attentionNotificationsBlocked: 'System notifications were denied; allow this app in System Settings › Notifications',
      attentionQuietLine: 'Only speaks up for other sessions; the one you are reading stays quiet',
      attentionWatching: 'Watching every session · every {seconds}s',
      attentionEmpty: 'Every session is healthy. Completions, failures and pending questions from other sessions show up here.',
      attentionStaleRows: 'Last known state below; it may be out of date:',
      attentionUnknownHint: 'Cannot read session status: the Host half may be older (no /api/changelist.attention) or the last read failed',
      attentionUnknownBody:
        'Session status cannot be read, so this cannot honestly say "all clear" or "something needs you".\nThe usual cause is a running Host half from before this feature: HMR does not watch sources in this profile, so toggle the bundle off and on in the Plugins page (or restart DSH) to register the new /api/changelist.attention route.',
      attentionOpen: 'Open',
      attentionNotInList: 'not listed',
      attentionNotOpenableHint: 'This session is not in this window’s session list ({id}), so it cannot be opened directly. It may be archived, or belong to another window.',
      attentionOpenedWorkspace: 'Switched to “{workspace}”: that session cannot be opened directly, pick it from the workspace’s session list',
      attentionOpenFailed: 'Cannot open that session ({id}): it is not in this window’s session list, even after a refresh',
      attentionOpenFailedShort: 'Cannot open',
      attentionMarkAllRead: 'Mark all read',
      attentionUnknownWorkspace: 'Unknown workspace',
      attentionAgoJustNow: 'just now',
      attentionAgoMinutes: '{count} min ago',
      attentionAgoHours: '{count} h ago',
      attentionAgoDays: '{count} d ago',
      stateWaiting: 'Needs you',
      stateError: 'Error',
      stateDone: 'Finished',
      stateRunning: 'Running',
      stateIdle: 'Idle',
      reasonApproval: 'Waiting for approval',
      reasonQuestion: 'Waiting for an answer',
      reasonBlocked: 'Blocked',
      reasonTurnError: 'Turn failed',
      reasonTurnEnd: 'Turn finished',
      reasonTurnStart: 'Starting a turn',
      reasonActivity: 'Working',
      reasonUnknown: 'State changed',
      notifyWaitingTitle: '“{workspace}” needs you',
      notifyErrorTitle: '“{workspace}” hit an error',
      notifyDoneTitle: '“{workspace}” finished',
      notifyBatchTitle: '{count} sessions changed',
    }

    const css = [
      '.dshCl_root{min-width:0}',
      /* ── the chip in the session header ─────────────────────────────── */
      '.dshCl_chip{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:230px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden}',
      '.dshCl_chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshCl_chip[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshCl_dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#bf8700)}',
      '.dshCl_dot[data-state=clean]{background:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshCl_dot[data-state=error]{background:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshCl_dot[data-state=loading]{background:var(--dsw-alias-label-tertiary)}',
      '.dshCl_dot[data-state=norepo]{background:var(--dsw-alias-label-tertiary);box-shadow:none}',
      '.dshCl_chipText{min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--ds-font-family-code)}',
      '.dshCl_chipAdd{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshCl_chipDel{color:var(--dsw-alias-state-error-primary,#e03131)}',
      /* ── the floating summary ───────────────────────────────────────── */
      '.dshCl_pop{position:absolute;top:56px;right:14px;z-index:21;display:flex;flex-direction:column;width:min(620px,94vw);max-height:min(74vh,660px);pointer-events:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden;font-size:13px}',
      '.dshCl_head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshCl_title{flex:none;margin:0;font-size:13px;font-weight:600}',
      '.dshCl_meta{flex:1;min-width:0;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:var(--ds-font-family-code);overflow:hidden;white-space:nowrap}',
      '.dshCl_btn{flex:none;height:26px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.dshCl_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCl_btn[disabled]{opacity:.45;cursor:default}',
      '.dshCl_iconBtn{flex:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;cursor:pointer}',
      '.dshCl_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshCl_body{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.dshCl_picker{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshCl_select{flex:1;min-width:0;height:26px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-l1);color:inherit;font:inherit;font-size:12px}',
      '.dshCl_list{flex:none;min-height:0;overflow:auto;max-height:34%;padding:6px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshCl_listFull{max-height:100%;border-bottom:none}',
      '.dshCl_row{display:flex;align-items:center;gap:8px;width:100%;padding:4px 8px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background 60ms linear}',
      '.dshCl_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCl_rowActive{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dshCl_status{flex:none;width:13px;text-align:center;font-family:var(--ds-font-family-code);font-size:11px;font-weight:700}',
      '.dshCl_sM{color:var(--dsw-alias-state-warn-primary,#bf8700)}',
      '.dshCl_sA{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshCl_sD{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshCl_sR{color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      /* The file name must survive a narrow row: the directory gives up width
         first, so a deep path still shows which file changed. */
      '.dshCl_path{flex:1;min-width:0;display:flex;align-items:baseline;overflow:hidden;font-family:var(--ds-font-family-code);font-size:12px}',
      '.dshCl_pathDir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      '.dshCl_pathName{flex:none;white-space:nowrap}',
      '.dshCl_stamp{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;white-space:nowrap}',
      '.dshCl_skelRow{display:flex;align-items:center;gap:8px;padding:5px 10px}',
      '.dshCl_skelBar{height:9px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));animation:dshClPulse 1.4s ease-in-out infinite}',
      '@keyframes dshClPulse{0%,100%{opacity:.5}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.dshCl_skelBar{animation:none;opacity:.7}.dshCl_row{transition:none}}',
      '.dshCl_counts{flex:none;display:flex;gap:5px;font-family:var(--ds-font-family-code);font-size:11px}',
      '.dshCl_add{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshCl_del{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshCl_diffWrap{flex:1;min-height:120px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-l1)}',
      '.dshCl_diffHead{flex:none;display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshCl_diffBody{flex:1;min-height:0;overflow:auto}',
      '.dshCl_pre{margin:0;padding:6px 0;font-family:var(--ds-font-family-code);font-size:12px;line-height:1.5}',
      '.dshCl_line{display:block;padding:0 12px;white-space:pre}',
      '.dshCl_wrap .dshCl_line{white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshCl_addLine{background:var(--dsw-alias-file-diff-added-bg,rgba(47,158,68,.14))}',
      '.dshCl_delLine{background:var(--dsw-alias-file-diff-deleted-bg,rgba(224,49,49,.14))}',
      '.dshCl_hunk{color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dshCl_metaLine{color:var(--dsw-alias-label-tertiary)}',
      '.dshCl_ctx{color:var(--dsw-alias-label-secondary)}',
      '.dshCl_note{flex:none;max-height:96px;overflow:auto;padding:7px 12px;border-top:.5px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-state-warn-primary,#bf8700);white-space:pre-wrap}',
      '.dshCl_error{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshCl_center{display:flex;align-items:center;justify-content:center;min-height:88px;padding:18px 12px;color:var(--dsw-alias-label-tertiary);text-align:center}',
      '.dshCl_detail{margin-top:6px;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshCl_dir{flex:none;display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      /* ── backend marker (chip + header) ─────────────────────────────── */
      '.dshCl_backend{flex:none;padding:0 4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:5px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;font-family:var(--ds-font-family-code);text-transform:uppercase}',
      '.dshCl_vcs{flex:none;height:24px;max-width:96px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px}',
      /* ── changelist groups ───────────────────────────────────────────── */
      '.dshCl_groups{display:flex;flex-direction:column}',
      '.dshCl_group{display:flex;flex-direction:column}',
      '.dshCl_groupHead{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshCl_groupHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCl_caret{flex:none;width:10px;color:var(--dsw-alias-label-tertiary);font-size:10px}',
      '.dshCl_groupTitle{flex:none;font-family:var(--ds-font-family-code);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dshCl_groupTitleLocal{color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dshCl_groupDesc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshCl_groupMeta{flex:none;display:flex;gap:6px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px}',
      '.dshCl_groupFiles{margin-left:10px;padding-left:6px;border-left:.5px solid var(--dsw-alias-border-l3)}',
      '.dshCl_badge{flex:none;padding:0 4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:10px;line-height:15px}',
      '.dshCl_badgeShelved{color:var(--dsw-alias-state-warn-primary,#bf8700);border-color:var(--dsw-alias-state-warn-primary,#bf8700)}',
      '.dshCl_badgeSync{color:var(--dsw-alias-state-business-primary,#4c6ef5);border-color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dshCl_rowShelved{box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary,#bf8700)}',
      /* ── connection panel ────────────────────────────────────────────── */
      '.dshCl_panel{flex:none;display:flex;flex-direction:column;gap:5px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-l1)}',
      '.dshCl_panelRow{display:flex;align-items:center;gap:8px;font-size:11px}',
      '.dshCl_panelLabel{flex:none;width:74px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px}',
      '.dshCl_input{flex:1;min-width:0;height:24px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-family:var(--ds-font-family-code);font-size:11px}',
      '.dshCl_panelDetected{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px}',
      '.dshCl_panelHint{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshCl_check{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}',
      '.dshCl_warn{color:var(--dsw-alias-state-warn-primary,#bf8700);font-size:11px;white-space:pre-wrap}',
      /* ── attention: the sidebar-foot pill ─────────────────────────────── */
      /* `position:relative` is what both the call-out and the guide panel
         measure against, so the pointer aims at this row wherever it sits. */
      '.dshAt_root{position:relative;display:flex;align-items:center;min-width:0}',
      '.dshAt_pill{display:inline-flex;align-items:center;gap:6px;min-width:0;height:28px;max-width:100%;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;transition:background 60ms linear,color 60ms linear}',
      '.dshAt_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshAt_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshAt_pill[data-rail=true]{width:28px;height:28px;padding:0;justify-content:center}',
      '.dshAt_dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.dshAt_dot[data-state=waiting]{background:var(--dsw-alias-state-warn-primary,#bf8700)}',
      '.dshAt_dot[data-state=error]{background:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshAt_dot[data-state=done]{background:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshAt_dot[data-state=running]{background:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      /* "We cannot see" is its own state: neither a clean bill of health nor an
         alarm. A hollow ring reads as "no information" at a glance. */
      '.dshAt_dot[data-state=unknown]{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-label-tertiary)}',
      '.dshAt_pill[data-state=unknown] .dshAt_text{color:var(--dsw-alias-label-tertiary)}',
      '.dshAt_emptyWarn{color:var(--dsw-alias-state-warn-primary,#bf8700);text-align:left;white-space:pre-wrap}',
      '.dshAt_staleHead{padding:6px 10px 2px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshAt_failBar{flex:none;padding:7px 12px;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-state-error-primary,#e03131);font-size:11px;line-height:1.45}',
      '.dshAt_noticeBar{flex:none;padding:7px 12px;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-state-warn-primary,#bf8700);font-size:11px;line-height:1.45}',
      '.dshAt_text{min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--ds-font-family-code)}',
      '.dshAt_pill[data-state=waiting] .dshAt_text{color:var(--dsw-alias-state-warn-primary,#bf8700)}',
      '.dshAt_pill[data-state=error] .dshAt_text{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshAt_pill[data-state=done] .dshAt_text{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshAt_caret{flex:none;color:var(--dsw-alias-state-warn-primary,#bf8700);font-size:9px;line-height:1}',
      '.dshAt_callout{flex:0 0 auto;max-width:190px;color:var(--dsw-alias-state-warn-primary,#bf8700);font-size:11px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* ── attention: the guide panel (overlay layer) ───────────────────── */
      '.dshAt_pop{position:absolute;z-index:22;display:flex;flex-direction:column;width:min(392px,92vw);max-height:min(70vh,560px);pointer-events:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden;font-size:13px}',
      '.dshAt_head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshAt_title{flex:none;margin:0;font-size:13px;font-weight:600}',
      '.dshAt_headMeta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px}',
      '.dshAt_body{flex:1;min-height:0;overflow:auto;padding:6px}',
      '.dshAt_group{display:flex;flex-direction:column;margin-bottom:8px}',
      '.dshAt_group:last-child{margin-bottom:0}',
      '.dshAt_groupHead{display:flex;align-items:center;gap:6px;padding:4px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:var(--ds-font-family-code)}',
      '.dshAt_groupName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshAt_groupCount{flex:none}',
      '.dshAt_row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshAt_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshAt_rowRead{opacity:.62}',
      '.dshAt_stateIcon{flex:none;width:14px;text-align:center;font-size:11px;line-height:1}',
      '.dshAt_stateIcon[data-state=waiting]{color:var(--dsw-alias-state-warn-primary,#bf8700)}',
      '.dshAt_stateIcon[data-state=error]{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshAt_stateIcon[data-state=done]{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshAt_stateIcon[data-state=running]{color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dshAt_rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dshAt_rowTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
      '.dshAt_rowMeta{min-width:0;display:flex;gap:6px;overflow:hidden;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:var(--ds-font-family-code)}',
      '.dshAt_rowReason{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dshAt_rowDot{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.dshAt_openHint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshAt_row:hover .dshAt_openHint{color:var(--dsw-alias-label-primary)}',
      /* A row whose Open did nothing must not look like a successful click. */
      '.dshAt_row[data-failed=true]{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshAt_row[data-failed=true] .dshAt_openHint{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshAt_empty{padding:20px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;text-align:center}',
      '.dshAt_foot{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshAt_footText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshAt_legend{flex:none;display:flex;flex-wrap:wrap;gap:6px 12px;padding:0 12px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshAt_legendItem{display:inline-flex;align-items:center;gap:4px}',
    ].join('')

    const STATUS_CLASS = { M: 'dshCl_sM', A: 'dshCl_sA', D: 'dshCl_sD', R: 'dshCl_sR', C: 'dshCl_sR', T: 'dshCl_sM' }
    const fallbackTranslator = (key) => String(key)

    /** Classify one unified-diff line for colouring. Headers must beat the +/- prefixes. */
    function lineKind(line) {
      if (line.startsWith('@@')) return 'hunk'
      if (
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('similarity ') ||
        line.startsWith('rename ') ||
        line.startsWith('\\')
      ) {
        return 'meta'
      }
      if (line.startsWith('+')) return 'add'
      if (line.startsWith('-')) return 'del'
      return 'ctx'
    }
    const LINE_CLASS = { add: 'dshCl_addLine', del: 'dshCl_delLine', hunk: 'dshCl_hunk', meta: 'dshCl_metaLine', ctx: 'dshCl_ctx' }

    /** Read one host route; a non-2xx answer becomes an Error carrying its message. */
    async function requestJson(url, signal) {
      const response = await fetch(url, { credentials: 'same-origin', signal })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || body === null) {
        const error = new Error(body?.message || `HTTP ${response.status}`)
        error.status = response.status
        error.body = body
        throw error
      }
      return body
    }

    const totalOf = (files) => {
      let added = 0
      let deleted = 0
      let binary = 0
      for (const file of files) {
        if (typeof file.added === 'number') added += file.added
        if (typeof file.deleted === 'number') deleted += file.deleted
        if (file.binary) binary += 1
      }
      return { added, deleted, binary }
    }

    /**
     * Split a repo-relative path for display. The row keeps one flex line: the
     * directory shrinks (and ellipsizes) first, so the file name stays readable
     * however deep the path is. The concatenation is still the full path, which
     * keeps the copy/tooltip/tests using the same string.
     */
    function pathParts(value) {
      const full = String(value ?? '')
      const cut = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'))
      return cut < 0 ? { dir: '', name: full } : { dir: full.slice(0, cut + 1), name: full.slice(cut + 1) }
    }

    /** Local wall-clock time for a Host ISO timestamp, or null when unusable. */
    function clockOf(iso) {
      const date = iso ? new Date(iso) : null
      if (!date || Number.isNaN(date.getTime())) return null
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Clipboard write with a textarea fallback; returns whether it landed. */
    function copyText(value) {
      const text = String(value ?? '')
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the selection-based copy */
      }
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute?.('readonly', '')
        document.body?.appendChild?.(area)
        area.select?.()
        const ok = document.execCommand?.('copy') === true
        area.remove?.()
        return ok
      } catch {
        return false
      }
    }

    /** A short-lived inline message; a second copy replaces the first. */
    let noticeTimer = null
    function flashNotice(message) {
      if (!message) return
      store.set({ notice: message })
      if (typeof setTimeout !== 'function') return
      if (noticeTimer) clearTimeout(noticeTimer)
      noticeTimer = setTimeout(() => {
        noticeTimer = null
        if (store.get().notice === message) store.set({ notice: null })
      }, 2500)
    }

    /** Placeholder rows shaped like real file rows, so loading does not jump. */
    function skeletonRows(count) {
      const rows = []
      for (let index = 0; index < count; index += 1) {
        rows.push(
          h(
            'div',
            { className: 'dshCl_skelRow', key: `skel-${index}` },
            h('span', { className: 'dshCl_skelBar', style: { width: '13px' } }),
            h('span', { className: 'dshCl_skelBar', style: { width: `${38 + index * 7}%` } }),
            h('span', { className: 'dshCl_skelBar', style: { width: '34px', marginLeft: 'auto' } }),
          ),
        )
      }
      return rows
    }

    /**
     * Which backend answered. `state.vcs` is authoritative; when an older Host
     * omits it, the presence of p4-only fields decides, so git keeps rendering
     * exactly as it did before Perforce existed.
     */
    function backendOf(state) {
      if (!state || state.ok === false) return null
      if (state.vcs === 'p4') return 'P4'
      if (state.vcs === 'git') return 'git'
      if (state.workspace || Array.isArray(state.changelists)) return 'P4'
      return 'git'
    }

    /** One line, never longer than `max`, from a change description. */
    function oneLine(text, max = GROUP_DESC_MAX) {
      const first = String(text ?? '')
        .split('\n')[0]
        .trim()
      return first.length > max ? `${first.slice(0, max)}…` : first
    }

    /** `'default'` for the default changelist, otherwise the change number as text. */
    function changeKey(value) {
      // The contract allows `'default'` or a number; a zero (or missing) change
      // is the default changelist, never a real change number.
      if (value === null || value === undefined || value === 'default' || value === 0 || value === '0') return 'default'
      return String(value)
    }

    function isShelvedChange(entry) {
      return Boolean(entry?.shelved) || entry?.status === 'shelved' || Boolean(entry?.hasShelved)
    }

    /**
     * Group the flat file list under changelist headers. Declared changelists
     * keep the Host's order first; a change that was not declared (older Host,
     * or a truncated `changelists` array) still gets a header; local-only edits
     * are returned separately so they render under their own group.
     */
    function buildGroups(state, files) {
      const lists = Array.isArray(state?.changelists) ? state.changelists : []
      const groups = []
      const index = new Map()
      const bucket = (key, entry) => {
        if (index.has(key)) return index.get(key)
        const group = { key, entry, files: [] }
        index.set(key, group)
        groups.push(group)
        return group
      }
      for (const entry of lists) {
        bucket(entry?.isDefault ? 'default' : changeKey(entry?.change ?? entry?.number), entry)
      }
      const localFiles = []
      for (const file of files) {
        const origin = file?.origin
        // `origin:'local'` is authoritative; `untracked` is the fallback for an
        // answer that carries no origin at all.
        if (origin === 'local' || (origin !== 'opened' && origin !== 'shelved' && file?.untracked === true)) {
          localFiles.push(file)
          continue
        }
        bucket(changeKey(file?.change), null).files.push(file)
      }
      return {
        groups: groups.filter((group) => group.files.length > 0),
        local: localFiles.length > 0 ? { key: 'local', entry: null, files: localFiles } : null,
      }
    }

    /**
     * The remembered backend choice, or `auto` when nothing valid is stored.
     *
     * This is deliberately **per target**. One browser window switches between a
     * Perforce project and a git project all the time, and a single global value
     * leaked the P4 choice into the git project: the request went out as `vcs=p4`,
     * the git project answered `not-a-workspace`, and the panel only recovered
     * once something reset it back to `auto`. Collapse state was already keyed by
     * target; this now is too.
     */
    function rememberedVcs(target) {
      const key = target ? targetKey(target) : null
      try {
        if (key) {
          const stored = window.localStorage.getItem(`${VCS_KEY}.${key}`)
          if (VCS_VALUES.includes(stored)) return stored
          // A stored choice for this target always wins, `auto` included: the
          // user asked for automatic detection here, so the legacy global value
          // (from a version of this plugin that only had one slot) must not
          // override it.
          if (stored !== null) return DEFAULT_VCS
        }
        const legacy = window.localStorage.getItem(VCS_KEY)
        return VCS_VALUES.includes(legacy) ? legacy : DEFAULT_VCS
      } catch {
        return DEFAULT_VCS
      }
    }
    function rememberVcs(target, value) {
      const key = target ? targetKey(target) : null
      try {
        if (key) window.localStorage.setItem(`${VCS_KEY}.${key}`, value)
        // Keep the legacy single slot up to date as well, so a downgrade still
        // remembers something sensible.
        window.localStorage.setItem(VCS_KEY, value)
      } catch {
        /* private mode: the choice simply does not persist */
      }
    }

    // ── one shared store for both surfaces ────────────────────────────────
    const store = {
      snapshot: {
        open: false,
        anchor: null,
        targets: [],
        target: null,
        state: null,
        phase: 'loading',
        error: null,
        selected: null,
        diff: null,
        diffPhase: 'idle',
        busy: false,
        notice: null,
        hostCompat: null,
        wrap: false,
        // p4 additions
        vcs: DEFAULT_VCS,
        // Connection overrides, keyed by target. Never written to disk, so a
        // password or a typed port never leaves this tab.
        p4ByTarget: {},
        // null = "not chosen in this browser yet": the Host config decides. An
        // explicit true/false then sends localEdits=1 / localEdits=0.
        localEdits: null,
        panelOpen: false,
        // Set when the panel was opened by the plugin rather than by the reader,
        // so switching to a git project can close it again without fighting a
        // reader who opened it on purpose.
        panelAuto: false,
        // collapse state lives in the store, keyed by target, never on disk
        collapsed: {},
      },
      listeners: new Set(),
      get() {
        return store.snapshot
      },
      set(patch) {
        store.snapshot = { ...store.snapshot, ...patch }
        for (const listener of [...store.listeners]) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    /** Subscribe one component to the shared store. */
    function useStore() {
      const [snapshot, setSnapshot] = React.useState(store.get())
      React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [])
      return snapshot
    }

    const remember = (dir) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, dir)
      } catch {
        /* private mode: the choice simply does not persist */
      }
    }
    const remembered = () => {
      try {
        return window.localStorage.getItem(STORAGE_KEY)
      } catch {
        return null
      }
    }

    /** The `sessionId` or `dir` query for the current target. */
    function targetQuery(snapshot) {
      const target = snapshot.target
      if (!target) return null
      return target.kind === 'session' ? { sessionId: target.id } : { dir: target.dir }
    }

    /**
     * The connection overrides typed for one target. They travel as query
     * parameters only — nothing is written to a p4 config or any other file, and
     * an empty box leaves the host's own environment (and P4V's own settings) in
     * charge.
     *
     * Keyed by target, like the backend choice and the collapse state: a
     * Perforce connection typed for one project must never be sent for another.
     * The values stay in memory for the session, so credentials are not written
     * anywhere.
     */
    function p4FieldsFor(snapshot, target = snapshot?.target) {
      const key = target ? targetKey(target) : ''
      return snapshot?.p4ByTarget?.[key] ?? {}
    }
    function p4Query(snapshot) {
      const values = p4FieldsFor(snapshot)
      const query = {}
      if (values.port) query.p4port = values.port
      if (values.user) query.p4user = values.user
      if (values.client) query.p4client = values.client
      if (values.charset) query.p4charset = values.charset
      return query
    }

    /** Everything a state/diff request carries beyond the target itself. */
    function requestExtra(snapshot, options = {}) {
      const extra = { vcs: snapshot?.vcs ?? DEFAULT_VCS, ...p4Query(snapshot) }
      if (options.localEdits) {
        if (snapshot?.localEdits === true) extra.localEdits = '1'
        else if (snapshot?.localEdits === false) extra.localEdits = '0'
      }
      return extra
    }

    /** Collapse state for the current target's changelist groups (store, not disk). */
    function collapsedFor(snapshot) {
      const key = snapshot?.target ? targetKey(snapshot.target) : ''
      return snapshot?.collapsed?.[key] ?? {}
    }

    function toggleGroup(groupKey) {
      const snapshot = store.get()
      const key = snapshot.target ? targetKey(snapshot.target) : ''
      const forTarget = { ...(snapshot.collapsed?.[key] ?? {}) }
      if (forTarget[groupKey]) delete forTarget[groupKey]
      else forTarget[groupKey] = true
      store.set({ collapsed: { ...(snapshot.collapsed ?? {}), [key]: forTarget } })
    }

    function setP4Override(field, value) {
      const snapshot = store.get()
      const key = snapshot.target ? targetKey(snapshot.target) : ''
      const forTarget = { ...p4FieldsFor(snapshot) }
      if (value === '' || value === null || value === undefined) delete forTarget[field]
      else forTarget[field] = value
      store.set({ p4ByTarget: { ...(snapshot.p4ByTarget ?? {}), [key]: forTarget } })
    }

    /**
     * Ask the host for one resource. The current Host resolves a `sessionId`
     * itself; an older Host — or one whose session lookup fails — only
     * understands `dir`, so a rejected session request is retried once with the
     * target's directory. That keeps a newer browser half working against an
     * older host half instead of showing an error.
     */
    async function requestTarget(name, query, target, extra = {}) {
      try {
        const body = await requestJson(`${BASE}.${name}?${new URLSearchParams({ ...query, ...extra }).toString()}`)
        return { body, viaDirectory: false }
      } catch (cause) {
        const retryable = cause?.status === 400 || cause?.status === 403 || cause?.status === 404
        if (query.sessionId && target?.dir && retryable) {
          const body = await requestJson(`${BASE}.${name}?${new URLSearchParams({ dir: target.dir, ...extra }).toString()}`)
          return { body, viaDirectory: true }
        }
        throw cause
      }
    }

    /**
     * Measure the chip so the floating summary can hang under it, flipping above
     * when the viewport leaves too little room below. A missing measurement
     * leaves the CSS default placement in charge.
     */
    function measureAnchor(event) {
      try {
        const element = event?.currentTarget ?? event?.target
        const rect = element?.getBoundingClientRect?.()
        if (!rect || typeof rect.bottom !== 'number') return null
        const viewportHeight = window.innerHeight || 0
        const viewportWidth = window.innerWidth || 0
        const right = Math.max(8, viewportWidth - rect.right)
        const spaceBelow = viewportHeight - rect.bottom
        if (viewportHeight > 0 && spaceBelow < 380) {
          return { right, top: null, bottom: Math.max(8, viewportHeight - rect.top + 8) }
        }
        return { right, top: rect.bottom + 8, bottom: null }
      } catch {
        return null
      }
    }

    // ── loading ───────────────────────────────────────────────────────────
    // `generation` guards whole-target reads (state and backend switches);
    // `diffGeneration` guards one file's comparison, so a fast series of clicks
    // can never let an older answer win.
    let generation = 0
    let diffGeneration = 0

    /**
     * Should the connection panel open by itself?
     *
     * Only for a Perforce workspace that cannot be reached, and only when no
     * connection was discovered: at that point the reader genuinely has to type
     * something, so asking is helpful. A git project never opens it — git needs
     * no account at all, which is the whole point of reading `.git` directly.
     * A reader who closed the panel by hand is not overruled.
     */
    function needsConnectionPrompt(state) {
      if (!state || state.ok !== false) return false
      const reason = state.reason
      if (reason !== 'p4-unavailable' && reason !== 'p4-error') return false
      const discovered = state.options?.discovered ?? null
      const workspace = state.workspace ?? null
      const known = discovered?.port ?? workspace?.port ?? null
      return !known
    }

    /** The store patch that opens the panel, or null when it need not open. */
    function connectionPromptPatch(state, snapshot) {
      if (!needsConnectionPrompt(state)) return snapshot?.panelAuto ? { panelOpen: false, panelAuto: false } : null
      if (snapshot?.panelOpen) return null
      return { panelOpen: true, panelAuto: true }
    }

    // Several chips (one per mounted session header) can ask for the same list at
    // once, and a remount asks again milliseconds later. One shared in-flight
    // promise plus a short freshness window keeps that to one request.
    let targetsInFlight = null
    let targetsLoadedAt = 0
    async function loadTargets(options = {}) {
      if (!options.force) {
        if (targetsInFlight) return targetsInFlight
        if (targetsLoadedAt > 0 && Date.now() - targetsLoadedAt < 1500 && store.get().targets.length > 0) {
          return store.get().targets
        }
      }
      const run = (async () => {
        try {
          const body = await requestJson(`${BASE}.targets`)
          const targets = Array.isArray(body.targets) ? body.targets : []
          targetsLoadedAt = Date.now()
          store.set({ targets })
          if (targets.length === 0 && store.get().target === null) {
            store.set({ phase: 'empty', error: null })
          }
          return targets
        } catch (cause) {
          store.set({ phase: 'error', error: cause.message })
          return []
        } finally {
          targetsInFlight = null
        }
      })()
      targetsInFlight = run
      return run
    }

    // ── automatic refresh: a cheap revision poll drives the expensive read ──
    //
    // A `state` read spawns seven git commands (~0.45 s, P95 1.9 s), so polling it
    // would keep the fan running. `revision` only reads an in-memory counter and
    // spawns nothing, so the browser asks it on a timer and pays for a `state`
    // read only when the number actually moved. That is the whole freshness
    // story: without it the chip kept yesterday's count until someone clicked
    // 刷新, because `loadState` only ever ran on a click.
    //
    // One watcher for the module, not one per surface: a second chip on screen
    // must not double the request rate. `users` counts mounts; the last release
    // stops the timer and detaches the listeners.
    const watchTuning = {
      pollVisibleMs: 2000,
      pollHiddenMs: 8000,
      /** Minimum gap between two automatic reads: bursts collapse into one. */
      minAutoMs: 1200,
    }
    /**
     * The rev each target's own last read reflects, keyed by `targetKey`.
     *
     * Per target, never one global value: A at rev 37 then B at rev 5 would look
     * like a backward jump and stop the refresh. Unknown means "no baseline yet"
     * — the read that selected the target has already loaded it.
     */
    const appliedRevByTarget = new Map()
    const watchState = {
      users: 0,
      timer: null,
      /** The delay the live timer was armed with: lets a test see the cadence. */
      pendingDelay: null,
      /** The single in-flight `revision` request, shared by every caller. */
      inFlight: null,
      /** True while an automatic `state` read runs, so two never overlap. */
      inFlightState: false,
      /** Targets whose auto refresh gave up on a 404 / network error. */
      disabled: new Set(),
      attached: false,
      detach: [],
      /** The translator of the most recent mount, for silent reads. */
      t: null,
      /** Timestamp of the last automatic read, for `minAutoMs`. */
      lastAutoReadAt: 0,
    }

    // A state read for one target can be triggered by several mounted chips and
    // by a refresh in the same tick; share the in-flight promise so the Host is
    // not asked for the same list four times (it used to spawn ~40 processes).
    let stateInFlight = null

    async function loadState(options = {}) {
      const snapshot = store.get()
      const query = targetQuery(snapshot)
      if (!query) return null
      // An automatic read (driven by the revision poll) must be invisible: it
      // never turns the list into skeleton rows, never clears a notice and never
      // claims the toolbar, so a background refresh cannot make the panel jump.
      // It still merges with an in-flight read and still honours `generation`.
      const auto = options.auto === true
      const inFlightKey = `${targetKey(snapshot.target)}\u0000${snapshot.vcs}\u0000${options.fetchRemote ? 'fetch' : 'read'}`
      // A read may only be shared while it is still the current generation: a
      // target switch bumped it, and the old promise will discard its own answer.
      if (!options.force && stateInFlight?.key === inFlightKey && stateInFlight.token === generation) {
        return stateInFlight.promise
      }
      // A background read must never displace a read the reader asked for (a
      // refresh, a fetch, a target switch): it would bump `generation` and throw
      // that answer away. Skipping one tick costs nothing — the next poll picks
      // the change up again because the rev is only marked applied once read.
      if (auto && stateInFlight && !options.force) return null
      const token = ++generation
      // A state read replaces the list, so any comparison still in flight would
      // be answering about a list that no longer exists.
      diffGeneration++
      if (!auto) store.set({ busy: true })
      let loaded = false
      let result = null
      const promise = (async () => {
        try {
          const extra = {
            ...(options.fetchRemote ? { fetch: '1', remote: options.remote ?? 'origin' } : {}),
            ...requestExtra(store.get(), { localEdits: true }),
          }
          const { body, viaDirectory } = await requestTarget('state', query, snapshot.target, extra)
          if (token !== generation) return
          const files = Array.isArray(body.files) ? body.files : []
          const selected =
            snapshot.selected && files.some((file) => file.path === snapshot.selected)
              ? snapshot.selected
              : files.length > 0
                ? files[0].path
                : null
          store.set({
            state: body,
            error: body.ok === false ? body.message ?? null : null,
            phase: body.ok === false ? 'error' : files.length === 0 ? 'clean' : 'ready',
            selected,
            hostCompat: viaDirectory ? 'dir' : 'session',
            // A background read leaves the notice alone: "已拉取 origin" is the
            // reader's news about a click they made, not a property of this file
            // list, and a silent refresh must never wipe it.
            ...(auto
              ? {}
              : {
                  // A fetch result belongs to this answer only; keeping an older
                  // notice is how "Fetched origin" used to stay on screen forever.
                  notice: body.fetch
                    ? body.fetch.ok
                      ? options.t?.('fetchOk', { remote: body.fetch.remote }) ?? null
                      : options.t?.('fetchFailed', { remote: body.fetch.remote, message: body.fetch.message ?? '' }) ?? null
                    : null,
                }),
            // Auto-detected per project: a Perforce workspace that cannot be
            // reached asks for its connection; anything else closes a panel the
            // plugin itself opened.
            ...(connectionPromptPatch(body, store.get()) ?? {}),
          })
          loaded = true
          result = body
          // The answer carries the rev it reflects (contract §2), so the panel's
          // baseline is known without a second request.
          //
          // A foreground read may adopt it outright: the reader has just seen
          // this exact list, so any change the Host counted before answering is
          // already on screen. A background read must NOT — it recorded the rev
          // it was polled with, and a larger one here is a change that landed
          // mid-read and belongs to the next poll, not to this read.
          if (typeof body.rev === 'number' && snapshot.target) {
            const key = targetKey(snapshot.target)
            // Foreground: adopt outright — this list is what the reader sees.
            // Background: only seed a target with no baseline; a larger rev here
            // is a change that landed mid-read and must survive to the next poll.
            if (!auto || !appliedRevByTarget.has(key)) appliedRevByTarget.set(key, body.rev)
          }
        } catch (cause) {
          if (token !== generation) return
          // A silent refresh has no surface to report on: the previous list is
          // still the best thing the panel knows, and an error banner over a
          // background poll would be a regression, not information.
          if (!auto) {
            store.set({
              phase: 'error',
              error:
                cause.status === 403 && cause.body?.allowed
                  ? `${cause.message}\n${cause.body.allowed.join('  ')}`
                  : cause.message,
            })
          }
        } finally {
          if (stateInFlight?.token === token) stateInFlight = null
          // Only a foreground read owns the toolbar; an auto read never took it.
          if (!auto && token === generation) store.set({ busy: false })
        }
        // The refresh may have re-picked the selected file (first file of the new
        // list), so the comparison has to follow it. Without this the pane kept
        // the previous file's text while its header showed the new path.
        if (loaded && token === generation) await loadDiff(options.t)
        return result
      })()
      stateInFlight = { key: inFlightKey, token, promise }
      return promise
    }

    // One comparison in flight per (target, file, base). The state refresh and the
    // click that selected the file both ask; they share one request.
    let diffInFlight = null

    async function loadDiff(t) {
      const tr = typeof t === 'function' ? t : fallbackTranslator
      const snapshot = store.get()
      const query = targetQuery(snapshot)
      const wanted = snapshot.selected
      if (!query || !wanted) return
      const key = `${targetKey(snapshot.target)}\u0000${wanted}\u0000${snapshot.state?.base ?? ''}\u0000${snapshot.vcs}`
      // Same rule as the state read: only share a comparison while no newer read
      // was requested. A stale answer would otherwise be returned to a caller
      // that is looking at a newer file.
      if (diffInFlight?.key === key && diffInFlight.token === diffGeneration) return diffInFlight.promise
      // A per-file token, independent of target switches: clicking a second file
      // must cancel the first answer even though no target changed.
      const token = ++diffGeneration
      store.set({ diffPhase: 'loading' })
      const promise = (async () => {
        try {
          const extra = { path: wanted }
          if (snapshot.state?.base) extra.base = snapshot.state.base
          Object.assign(extra, requestExtra(store.get()))
          // A Perforce file needs its own coordinates: the depot path reaches the
          // shelved/opened revision, the change number and the flags tell the Host
          // which comparison was asked for. Git (and an older Host) never sees these.
          if (backendOf(snapshot.state) === 'P4') {
            const files = Array.isArray(snapshot.state?.files) ? snapshot.state.files : []
            const file = files.find((entry) => entry?.path === wanted)
            if (file) {
              if (file.depotPath) extra.depotPath = file.depotPath
              if (file.change !== undefined && file.change !== null) extra.change = String(file.change)
              if (file.shelved === true) extra.shelved = '1'
              if (file.untracked === true || file.origin === 'local') extra.changed = '1'
              // Naming the comparison keeps the Host from guessing between the
              // opened, shelved and local revisions of the same file.
              if (file.origin) extra.origin = file.origin
              if (file.p4Type) extra.p4Type = file.p4Type
              if (typeof file.headRev === 'number') extra.baseRev = String(file.headRev)
            }
          }
          const { body } = await requestTarget('diff', query, snapshot.target, extra)
          // The reader may have clicked another file while this was in flight.
          if (token !== diffGeneration || store.get().selected !== wanted) return
          store.set({ diff: body, diffPhase: 'ready' })
        } catch (cause) {
          if (token !== diffGeneration || store.get().selected !== wanted) return
          store.set({
            diff: { path: wanted, message: tr('error', { message: cause.message }), text: '' },
            diffPhase: 'error',
          })
        } finally {
          if (diffInFlight?.token === token) diffInFlight = null
        }
      })()
      diffInFlight = { key, token, promise }
      return promise
    }

    /** Point the store at one target and (re)load everything for it. */
    function selectTarget(target, t, options = {}) {
      if (!target) return
      const nextVcs = rememberedVcs(target)
      const current = store.get()
      // A chip remount (or a second mounted chip) points at the target the store
      // already holds. Clearing the list there would flash a skeleton and race
      // the read the reader just triggered, so only the data is refreshed.
      if (current.target && targetKey(current.target) === targetKey(target) && current.vcs === nextVcs) {
        return loadState({ ...options, t })
      }
      generation++
      store.set({
        target,
        // Auto-detect for this project. If the reader picked a backend for it by
        // hand, that choice comes back; otherwise detection decides, so a git
        // project and a Perforce project in one window each get the right mode
        // without the reader saying so.
        vcs: nextVcs,
        state: null,
        diff: null,
        diffPhase: 'idle',
        selected: null,
        phase: 'loading',
        error: null,
        notice: null,
        // A panel the plugin opened for the previous project does not carry
        // over; the next state load re-decides for this one.
        panelOpen: false,
        panelAuto: false,
      })
      if (target.kind !== 'session' && target.dir) remember(target.dir)
      return loadState({ ...options, t })
    }

    // ── the revision watcher (contract §5) ────────────────────────────────
    const REVISION_BASE = `${BASE}.revision`

    /** Is the tab currently visible? A missing `visibilityState` counts as visible. */
    function watchHidden() {
      try {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden'
      } catch {
        return false
      }
    }

    /**
     * The `revision` query for the current target: exactly the `state` targeting
     * parameters and **no `vcs`**.
     *
     * `vcs` chooses which backend answers; it cannot change whether a directory
     * moved. Sending it would also make the poll URL change on every backend
     * switch, needlessly splitting the in-flight coalescing.
     */
    function revisionQuery(snapshot) {
      const query = targetQuery(snapshot)
      if (!query) return null
      return new URLSearchParams(query).toString()
    }

    /** Forget one target's baseline, e.g. after its directory changed. */
    function forgetRev(target) {
      if (!target) return
      appliedRevByTarget.delete(targetKey(target))
    }

    /**
     * Ask the Host whether the current target moved. One request in flight
     * module-wide, whatever the number of mounted surfaces.
     *
     * A 404 (a Host half from before this route) or a network error disables
     * auto refresh for that target and nothing else: the reader keeps their own
     * 刷新 button, and — this is the point — sees no error surface at all. A
     * missing enhancement must never look like a broken feature.
     */
    async function loadRevision(options = {}) {
      const snapshot = store.get()
      const query = revisionQuery(snapshot)
      const target = snapshot.target
      if (!query || !target) return null
      const key = targetKey(target)
      if (watchState.disabled.has(key)) return null
      if (watchState.inFlight) return watchState.inFlight
      const run = (async () => {
        try {
          const body = await requestJson(`${REVISION_BASE}?${query}`)
          return body
        } catch (cause) {
          // 404 = older Host half. Anything else = the route is unreachable.
          // Both mean "this enhancement cannot work here", not "the workspace
          // failed"; record it per target and stay quiet.
          watchState.disabled.add(key)
          return null
        } finally {
          watchState.inFlight = null
        }
      })()
      watchState.inFlight = run
      return run
    }

    /**
     * Record the rev a read reflects and, when it differs from what the panel
     * already shows, run one silent `state` read.
     *
     * The **polled** rev is recorded, not one re-read afterwards: a change that
     * lands during the read must be left for the next poll instead of being
     * swallowed, which is what makes the second edit of a turn show up too.
     *
     * Only `!==` is ever compared. The Host's counter is an in-process sequence,
     * so it restarts on a plugin reload or a Host restart; a lower number is a
     * different number, not a rollback, and must still trigger a read.
     */
    function applyRev(target, rev, options = {}) {
      const key = targetKey(target)
      const seen = typeof rev === 'number' && Number.isFinite(rev) ? rev : 0
      const previous = appliedRevByTarget.get(key)
      // No baseline yet: the read that selected this target has just loaded it,
      // so adopt the number instead of asking for the same list twice.
      if (previous === undefined) {
        appliedRevByTarget.set(key, seen)
        return false
      }
      if (previous === seen) return false
      // Throttled or already reading: leave the baseline untouched, so the next
      // poll sees the same difference again and retries it. Marking it applied
      // here would silently drop the change.
      if (!autoReadReady()) return false
      appliedRevByTarget.set(key, seen)
      void runAutoRead(options.t)
      return true
    }

    /** May another automatic read start right now? */
    function autoReadReady() {
      if (watchState.inFlightState) return false
      return Date.now() - watchState.lastAutoReadAt >= watchTuning.minAutoMs
    }

    /** One silent state read. The caller has already claimed the throttle slot. */
    async function runAutoRead(t) {
      watchState.lastAutoReadAt = Date.now()
      watchState.inFlightState = true
      try {
        return await loadState({ auto: true, t: t ?? watchState.t })
      } finally {
        watchState.inFlightState = false
      }
    }

    /** One poll: check the rev, and do the visibility compensation when asked. */
    async function watchTick(options = {}) {
      const snapshot = store.get()
      const target = snapshot.target
      if (!target) return null
      if (watchState.disabled.has(targetKey(target))) return null
      const body = await loadRevision()
      if (!body || typeof body !== 'object') return null
      // The target may have moved while the request was in flight.
      if (targetKey(store.get().target ?? {}) !== targetKey(target)) return null
      const rev = typeof body.rev === 'number' ? body.rev : 0
      const changed = applyRev(target, rev, options)
      // Returning to the tab: the only compensation for edits the Host never
      // saw. External editors and `git checkout` never bump the revision, so a
      // rev check alone would keep reporting the numbers from before.
      if (options.compensate && !changed) {
        const openNow = store.get().open
        if (openNow && autoReadReady()) await runAutoRead(options.t)
      }
      return rev
    }

    /** Arm the next tick at the cadence the current visibility deserves. */
    function watchArm() {
      if (watchState.users <= 0) return
      if (typeof setTimeout !== 'function') return
      const delay = watchHidden() ? watchTuning.pollHiddenMs : watchTuning.pollVisibleMs
      watchState.pendingDelay = delay
      watchState.timer = setTimeout(async () => {
        watchState.timer = null
        watchState.pendingDelay = null
        await watchTick({ t: watchState.t })
        watchArm()
      }, delay)
    }

    /**
     * Attach the listeners that make the panel honest again.
     *
     * `visibilitychange` and `focus` exist only in a real browser; in the test
     * shim they are absent, so their handlers are reachable through the test
     * seam instead of being unreachable code.
     */
    function watchAttach() {
      if (watchState.attached) return
      watchState.attached = true
      const onVisible = () => {
        if (watchHidden()) return
        // Immediately, not on the tick: coming back is exactly when a stale
        // number is most misleading.
        void watchTick({ compensate: true, t: watchState.t })
      }
      const onFocus = () => {
        if (watchHidden()) return
        void watchTick({ compensate: true, t: watchState.t })
      }
      watchState.onVisible = onVisible
      watchState.onFocus = onFocus
      try {
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisible)
          watchState.detach.push(() => document.removeEventListener('visibilitychange', onVisible))
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('focus', onFocus)
          watchState.detach.push(() => window.removeEventListener('focus', onFocus))
        }
      } catch {
        /* a host without DOM events simply never gets the compensation */
      }
    }

    function watchDetach() {
      watchState.attached = false
      for (const off of watchState.detach) {
        try {
          off()
        } catch {
          /* a listener removed twice is not an error worth reporting */
        }
      }
      watchState.detach = []
    }

    /**
     * A surface mounted: start the shared watcher if it is the first one.
     * Returns the release function; the last release stops everything, so
     * unmounting leaves no timer behind.
     */
    function watchMount(t) {
      if (typeof t === 'function') watchState.t = t
      watchState.users += 1
      watchAttach()
      if (watchState.users === 1) watchArm()
      let released = false
      return () => {
        if (released) return
        released = true
        watchState.users = Math.max(0, watchState.users - 1)
        if (watchState.users > 0) return
        if (watchState.timer) clearTimeout(watchState.timer)
        watchState.timer = null
        watchState.pendingDelay = null
        watchDetach()
      }
    }

    /** Test seam: restore the watcher to its just-loaded state between sections. */
    function watchReset() {
      if (watchState.timer) clearTimeout(watchState.timer)
      watchState.timer = null
      watchState.pendingDelay = null
      watchState.users = 0
      watchState.inFlight = null
      watchState.inFlightState = false
      watchState.lastAutoReadAt = 0
      appliedRevByTarget.clear()
      watchState.disabled.clear()
      watchDetach()
    }

    /**
     * Switch the backend the Host is asked about. This never re-picks the
     * target: the current session/dir choice stays exactly where it was, and the
     * new value only rides along as `vcs=auto|git|p4` on the next read.
     */
    function changeBackend(value, t) {
      const next = VCS_VALUES.includes(value) ? value : DEFAULT_VCS
      const current = store.get()
      rememberVcs(current.target, next)
      if (next === current.vcs) return
      generation++
      store.set({ vcs: next, state: null, diff: null, diffPhase: 'idle', selected: null, phase: 'loading', error: null })
      void loadState({ t })
    }

    /** Short backend marker used on the chip and in the summary header. */
    function backendLabel(state, t) {
      return backendOf(state) === 'P4' ? t('markP4') : t('markGit')
    }

    /** The header meta line: git keeps its branch/base/ahead/behind wording. */
    function metaParts(state, t) {
      if (backendOf(state) === 'P4') {
        const parts = []
        const workspace = state.workspace
        if (workspace?.client) parts.push(h('span', { key: 'client' }, workspace.client))
        else if (workspace?.root) parts.push(h('span', { key: 'root' }, workspace.root))
        const revisions = state.revisions
        if (revisions && (revisions.have !== null || revisions.head !== null)) {
          parts.push(h('span', { key: 'rev' }, `rev ${revisions.have ?? '?'} / head ${revisions.head ?? '?'}`))
        }
        if (Array.isArray(state.changelists) && state.changelists.length > 0) {
          parts.push(h('span', { key: 'cl' }, t('changelistCount', { count: state.changelists.length })))
        }
        return parts
      }
      return [
        h('span', { key: 'branch' }, state.branch),
        h('span', { key: 'base' }, `→ ${state.base}`),
        state.ahead > 0 ? h('span', { key: 'ahead' }, `↑${state.ahead}`) : null,
        state.behind > 0 ? h('span', { key: 'behind' }, `↓${state.behind}`) : null,
      ].filter(Boolean)
    }

    /** The chip tooltip's one-line summary, backend-aware. */
    function chipDetail(state, totals, t) {
      if (!state?.ok) return null
      if (backendOf(state) === 'P4') {
        const parts = []
        if (state.workspace?.client) parts.push(state.workspace.client)
        if (state.base) parts.push(state.base)
        parts.push(`+${totals.added} −${totals.deleted}`)
        return parts.join('  ·  ')
      }
      return `${state.branch} → ${state.base}  ·  +${totals.added} −${totals.deleted}`
    }

    /** Pick a target: the session the chip lives in always outranks a remembered directory. */
    function pickTarget(targets, sessionId) {
      if (sessionId) {
        const known = targets.find((target) => target.kind === 'session' && target.id === sessionId)
        if (known) return known
        // The session may be missing from the live list; the Host can still
        // resolve it, so a synthetic target keeps the chip in the right project.
        return { kind: 'session', id: sessionId, dir: '', title: '', live: true, sessions: null }
      }
      const rememberedDir = remembered()
      if (rememberedDir) {
        const match = targets.find((target) => target.dir === rememberedDir)
        if (match) return match
      }
      return targets.find((target) => target.live) ?? targets[0] ?? null
    }

    /**
     * The session the user is looking at, derived the way the shipped sidebar
     * does it: the session retained by the main view.
     */
    /**
     * The session ids this window can actually select.
     *
     * `ctx.sessions.open(id)` selects through the CLIENT list, whose membership
     * comes from the Host's persisted-session index. The attention route reports
     * the HOST's live sessions instead, and the two are not the same set: a
     * session running in this Host but absent from this window's index (finished
     * and archived, or owned by another window's selection) appears in the guide
     * yet can never be opened here. Knowing which is which up front is what lets
     * the panel offer an honest action instead of a button that always fails.
     */
    function selectableSessionIds(service) {
      try {
        const snapshot = service?.list?.getSnapshot?.()
        const ids = new Set()
        for (const id of snapshot?.ids ?? []) ids.add(id)
        for (const id of Object.keys(snapshot?.byId ?? {})) ids.add(id)
        return ids
      } catch {
        return null
      }
    }

    function viewedSessionId(service) {
      try {
        const snapshot = service?.list?.getSnapshot?.()
        for (const row of Object.values(snapshot?.byId ?? {})) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id ?? null
        }
        return null
      } catch {
        return null
      }
    }

    /**
     * Watch the viewed session. The store is not necessarily seeded when the
     * chip first mounts (it may still be loading), so the chip must be able to
     * follow the session once it appears — and when the user switches sessions
     * in the same window, where the header does not remount.
     */
    function watchViewedSession(service, listener) {
      try {
        const subscribe = service?.list?.subscribe
        if (typeof subscribe !== 'function') return () => {}
        return subscribe.call(service.list, () => listener(viewedSessionId(service))) ?? (() => {})
      } catch {
        return () => {}
      }
    }

    /** The identity a picker option carries, so a synthetic target stays selectable. */
    const targetKey = (target) => (target.kind === 'session' ? `session:${target.id}` : `dir:${target.dir}`)

    // ── attention: cross-project status, one store, three layers ──────────
    //
    // The changelist surfaces above answer "what changed in the project I am
    // looking at". Nothing answered "is anything ELSE waiting for me" — with
    // several sessions across several workspace folders, a finished turn, a
    // failed turn, or a pending approval sitting in an unopened session was
    // invisible until the reader happened to click into that session.
    //
    // Three layers, quietest first:
    //   L3 sidebar pill + guide panel  — always on, no permission needed;
    //   L2 document-title prefix/badge — always on, no permission needed;
    //   L1 OS notification             — only with permission, only for a
    //                                    session the reader is not looking at.
    // Everything is derived from one read-only Host route, polled, because the
    // browser gets no event feed for sessions it has not opened.

    const ATTENTION_BASE = `${BASE}.attention`
    /**
     * Tunables, kept in one mutable object so the verification suite can drive
     * the poll/notify clock without five-second sleeps. Production never writes
     * to it; the defaults are the contract.
     */
    const attentionTuning = {
      pollVisibleMs: 5000,
      pollHiddenMs: 15000,
      /** A `done` reminder stops being useful; `waiting` and `error` never expire. */
      doneTtlMs: 10 * 60 * 1000,
      /** Coalescing window for OS notifications: N transitions in one window = one toast. */
      notifyBatchMs: 2000,
    }
    const ATTENTION_ASKED_KEY = 'dsh-changelist.attention.notifyAsked'
    const ATTENTION_DENIED_KEY = 'dsh-changelist.attention.notifyDenied'
    /** Worst first: what the pill summarises and how the panel sorts. */
    const ATTENTION_STATE_ORDER = ['waiting', 'error', 'done', 'running', 'idle']
    /** States that deserve a human's attention; `running`/`idle` never notify. */
    const ATTENTION_LOUD = new Set(['waiting', 'error', 'done'])
    const ATTENTION_ICON = { waiting: '!', error: '✕', done: '✓', running: '·', idle: '·' }
    const ATTENTION_STATE_KEY = {
      waiting: 'stateWaiting',
      error: 'stateError',
      done: 'stateDone',
      running: 'stateRunning',
      idle: 'stateIdle',
    }
    const ATTENTION_REASON_KEY = {
      approval: 'reasonApproval',
      question: 'reasonQuestion',
      blocked: 'reasonBlocked',
      'turn-error': 'reasonTurnError',
      'turn-end': 'reasonTurnEnd',
      'turn-start': 'reasonTurnStart',
      activity: 'reasonActivity',
    }

    // A third store: attention is independent of the changelist target and must
    // keep working on the welcome screen (where no session header exists).
    const attention = {
      snapshot: {
        open: false,
        /** Anchor rect measured from the pill, so the panel points at it. */
        anchor: null,
        sessions: [],
        counts: { waiting: 0, error: 0, done: 0, running: 0, idle: 0 },
        /** Session ids the reader has acknowledged; `waiting` never clears. */
        read: {},
        phase: 'idle',
        error: null,
        generatedAt: null,
        /** False when the Host reports `enabled:false`: the feature is switched off. */
        enabled: true,
        /**
         * Whether the last read actually reached the Host. A failed read must
         * never render as "all clear": silence about other agents' work is not
         * evidence that it is done.
         */
        reachable: true,
        /** True once the reader has been shown the call-out for the current waiting set. */
        calloutSeen: false,
        waitingKey: '',
        /** Permission state for L1: 'default' | 'granted' | 'denied' | 'unsupported'. */
        permission: 'unsupported',
        /** Session id whose last "Open" failed, so the row can say so. */
        failed: null,
        /** Why that open failed, shown in the panel's own footer. */
        failedMessage: null,
        /** A short-lived line for an action that succeeded indirectly. */
        notice: null,
      },
      listeners: new Set(),
      get() {
        return attention.snapshot
      },
      set(patch) {
        attention.snapshot = { ...attention.snapshot, ...patch }
        for (const listener of [...attention.listeners]) listener()
      },
      subscribe(listener) {
        attention.listeners.add(listener)
        return () => attention.listeners.delete(listener)
      },
    }

    function useAttention() {
      const [snapshot, setSnapshot] = React.useState(attention.get())
      React.useEffect(() => attention.subscribe(() => setSnapshot(attention.get())), [])
      return snapshot
    }

    const hasNotifications = () => {
      try {
        return typeof window !== 'undefined' && typeof window.Notification === 'function'
      } catch {
        return false
      }
    }
    const notificationPermission = () => {
      try {
        if (!hasNotifications()) return 'unsupported'
        return window.Notification.permission ?? 'default'
      } catch {
        return 'unsupported'
      }
    }
    /** Has the reader already been asked? Asking twice is the fastest way to get denied. */
    function notificationAsked() {
      try {
        return window.localStorage.getItem(ATTENTION_ASKED_KEY) === '1'
      } catch {
        return false
      }
    }
    function rememberNotificationAsked(denied) {
      try {
        window.localStorage.setItem(ATTENTION_ASKED_KEY, '1')
        if (denied) window.localStorage.setItem(ATTENTION_DENIED_KEY, '1')
      } catch {
        /* private mode: the prompt simply reappears next launch */
      }
    }
    function notificationDeniedBefore() {
      try {
        return window.localStorage.getItem(ATTENTION_DENIED_KEY) === '1'
      } catch {
        return false
      }
    }

    /** Per-workspace grouping; the guide answers "which project", so it groups by that. */
    function attentionGroups(sessions) {
      const groups = []
      const index = new Map()
      for (const session of sessions) {
        const name = session.workspace || session.dir || ''
        const key = name.toLowerCase()
        let group = index.get(key)
        if (!group) {
          group = { key, name, sessions: [] }
          index.set(key, group)
          groups.push(group)
        }
        group.sessions.push(session)
      }
      return groups
    }

    /**
     * The counts that drive the pill, the title and the badge. `read` only
     * suppresses `done`/`error`: `waiting` is never dismissible, because a
     * blocked agent stays blocked until the human answers it.
     */
    function attentionSummary(snapshot) {
      const read = snapshot?.read ?? {}
      const sessions = snapshot?.sessions ?? []
      const counts = { waiting: 0, error: 0, done: 0, running: 0, idle: 0 }
      let unread = 0
      for (const session of sessions) {
        const state = ATTENTION_STATE_ORDER.includes(session.state) ? session.state : 'idle'
        counts[state] += 1
        if (state !== 'running' && state !== 'idle' && !read[session.sessionId]) unread += 1
      }
      // What the pill is coloured by. `running` counts: "three projects are
      // working" is exactly the fact this surface exists to report, and leaving
      // it out made a busy workspace read "全部正常".
      let worst = null
      if (sessions.some((session) => session.state === 'waiting')) worst = 'waiting'
      else if (sessions.some((session) => session.state === 'error' && !read[session.sessionId])) worst = 'error'
      else if (sessions.some((session) => session.state === 'done' && !read[session.sessionId])) worst = 'done'
      else if (sessions.some((session) => session.state === 'running')) worst = 'running'
      return { counts, unread, worst, total: sessions.length }
    }

    /** `just now` / `3 min ago` / `2 h ago` / `4 d ago`, from an epoch-ms stamp. */
    function attentionAgo(at, t) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 60) return t('attentionAgoJustNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('attentionAgoMinutes', { count: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('attentionAgoHours', { count: hours })
      return t('attentionAgoDays', { count: Math.round(hours / 24) })
    }

    /** The one-line reason under a session title. */
    function attentionReason(session, t) {
      const key = ATTENTION_REASON_KEY[session?.reason]
      if (key) return t(key)
      return t('reasonUnknown')
    }

    /**
     * Drop stale `done` reminders so the pill does not keep a green dot forever.
     * `waiting`/`error` are kept: a blocked or failed session is still true
     * regardless of the clock.
     */
    /**
     * Drop `done` reminders that have gone stale, and drop anything the Host
     * flagged as a delegated child.
     *
     * The second half is deliberate duplication of a Host-side rule. A subagent
     * child inherits its parent's cwd, so it is indistinguishable from a real
     * project by directory alone; it also can never be selected in the client,
     * which makes its row a dead end. The Host filters these, but a row leaking
     * through (an older Host half, a record seeded before the filter existed)
     * would put unopenable rows back in front of the reader, so the browser
     * refuses them too. Defence in depth on a surface whose whole value is that
     * its rows are actionable.
     */
    function isDelegatedChild(session) {
      return (
        session?.origin === 'subagent' ||
        session?.parentSession !== undefined ||
        (typeof session?.delegationDepth === 'number' && session.delegationDepth > 0)
      )
    }

    function pruneAttention(sessions) {
      const now = Date.now()
      return sessions.filter((session) => {
        if (isDelegatedChild(session)) return false
        return !(session.state === 'done' && typeof session.at === 'number' && now - session.at > attentionTuning.doneTtlMs)
      })
    }

    let attentionInFlight = null
    async function loadAttention(options = {}) {
      if (attentionInFlight) return attentionInFlight
      const run = (async () => {
        try {
          const body = await requestJson(ATTENTION_BASE)
          // `enabled` is only present on the disabled branch of the contract; an
          // absent field means "on". A Host that was told to stop this feature
          // must leave no trace: no pill counts, no title prefix, no badge.
          const disabled = body.enabled === false
          const sessions = disabled ? [] : pruneAttention(Array.isArray(body.sessions) ? body.sessions : [])
          const previous = attention.get()
          attention.set({
            sessions,
            enabled: !disabled,
            // A successful answer re-establishes contact.
            reachable: true,
            counts:
              !disabled && body.counts && typeof body.counts === 'object'
                ? { ...previous.counts, ...body.counts }
                : { waiting: 0, error: 0, done: 0, running: 0, idle: 0 },
            phase: 'ready',
            error: null,
            generatedAt: typeof body.generatedAt === 'number' ? body.generatedAt : Date.now(),
          })
          // A brand-new waiting set re-arms the call-out, so the arrow points
          // again instead of staying collapsed after the first acknowledgement.
          const waitingKey = sessions
            .filter((session) => session.state === 'waiting')
            .map((session) => session.sessionId)
            .sort()
            .join(',')
          attention.set({ calloutSeen: previous.calloutSeen && previous.waitingKey === waitingKey, waitingKey })
          const summary = attentionSummary(attention.get())
          applyTitle(summary)
          applyBadge(summary)
          if (!options.silent) notifyAttention(previous, sessions, options.t)
          return body
        } catch (cause) {
          // Attention is advisory: a failed read must never turn into an error
          // banner over the reader's work. But it must also never be reported as
          // "all clear" — that is a claim about other agents' work, and a 404
          // (older Host half without the route) or a dropped read knows nothing.
          attention.set({
            phase: attention.get().phase === 'idle' ? 'error' : attention.get().phase,
            error: cause?.message ?? null,
            // Losing contact invalidates the counts; keep the rows so the reader
            // still sees what was last known, but stop asserting freshness.
            reachable: false,
          })
          applyTitle(attentionSummary(attention.get()))
          return null
        }
        finally {
          attentionInFlight = null
        }
      })()
      attentionInFlight = run
      return run
    }

    // ── L2: document title + app badge ────────────────────────────────────
    //
    // The shell owns `document.title` (it projects the session title). To stay
    // additive we only ever strip a prefix this plugin itself wrote, so a
    // concurrent shell update can never accumulate `(1) (1) (1) `.
    const TITLE_PREFIX_RE = /^\(\d+\)\s+/
    let titleApplied = false
    function applyTitle(summary) {
      try {
        if (typeof document === 'undefined') return
        const bare = String(document.title ?? '').replace(TITLE_PREFIX_RE, '')
        const count = summary.unread
        if (count > 0) {
          document.title = `(${count}) ${bare}`
          titleApplied = true
        } else if (titleApplied) {
          document.title = bare
          titleApplied = false
        }
      } catch {
        /* a frozen title is not worth failing a poll over */
      }
    }
    function resetTitle() {
      try {
        if (typeof document === 'undefined' || !titleApplied) return
        document.title = String(document.title ?? '').replace(TITLE_PREFIX_RE, '')
        titleApplied = false
      } catch {
        /* nothing to restore */
      }
    }
    function applyBadge(summary) {
      try {
        if (typeof navigator === 'undefined') return
        const count = summary.unread
        if (count > 0 && typeof navigator.setAppBadge === 'function') void navigator.setAppBadge(count)
        else if (count === 0 && typeof navigator.clearAppBadge === 'function') void navigator.clearAppBadge()
      } catch {
        /* the badge is a bonus, never a requirement */
      }
    }

    // ── L1: OS notifications ──────────────────────────────────────────────
    //
    // Notified only for a *transition* into a loud state, only when the reader
    // is not already looking at that session, and only with permission. The tag
    // makes the platform replace rather than stack, and a batch window turns N
    // simultaneous changes into one toast.
    let notifyTimer = null
    let notifyPending = []
    /** The client session service, captured by `apply` so the guide can open a row. */
    let sessionsService = null
    function viewedSession() {
      try {
        return viewedSessionId(sessionsService)
      } catch {
        return null
      }
    }
    function notificationBody(session, t) {
      const title = String(session.title ?? '').trim()
      const detail = session.detail ? String(session.detail).trim() : ''
      if (detail) return title ? `${title} · ${detail}` : detail
      return title || attentionReason(session, t)
    }
    function notifyAttention(previous, sessions, t) {
      const tr = typeof t === 'function' ? t : fallbackTranslator
      const before = new Map((previous.sessions ?? []).map((session) => [session.sessionId, session.state]))
      const current = viewedSession()
      const hidden = (() => {
        try {
          return typeof document !== 'undefined' && document.visibilityState === 'hidden'
        } catch {
          return false
        }
      })()
      const fresh = []
      for (const session of sessions) {
        const state = session.state
        if (!ATTENTION_LOUD.has(state)) continue
        if (before.get(session.sessionId) === state) continue // no transition: the same fact again
        // Silence cases: the reader is reading it right now (unless the window
        // is hidden), and a completion elsewhere while the app is visible is
        // already visible in the pill.
        if (!hidden && session.sessionId === current) continue
        if (state === 'done' && !hidden) continue
        fresh.push(session)
      }
      if (fresh.length === 0) return
      notifyPending.push(...fresh)
      if (notifyTimer) return
      notifyTimer = setTimeout(() => {
        notifyTimer = null
        const batch = notifyPending
        notifyPending = []
        flushNotifications(batch, tr)
      }, attentionTuning.notifyBatchMs)
    }
    function flushNotifications(batch, t) {
      if (notificationPermission() !== 'granted') return
      try {
        if (batch.length === 1) {
          const session = batch[0]
          const workspace = session.workspace || t('attentionUnknownWorkspace')
          const titleKey =
            session.state === 'waiting'
              ? 'notifyWaitingTitle'
              : session.state === 'error'
                ? 'notifyErrorTitle'
                : 'notifyDoneTitle'
          const notification = new window.Notification(t(titleKey, { workspace }), {
            body: notificationBody(session, t),
            // One tag per session+state: the platform replaces rather than stacks.
            tag: `dsh-attention-${session.sessionId}-${session.state}`,
            silent: session.state === 'done',
          })
          notification.onclick = () => {
            try {
              window.focus?.()
            } catch {
              /* some platforms refuse focus from a notification */
            }
            attention.set({ open: true })
            void openSession(session.sessionId, t)
            notification.close?.()
          }
        } else {
          const notification = new window.Notification(t('notifyBatchTitle', { count: batch.length }), {
            body: batch
              .slice(0, 4)
              .map((session) => `${session.workspace || t('attentionUnknownWorkspace')} · ${attentionReason(session, t)}`)
              .join('\n'),
            tag: 'dsh-attention-batch',
          })
          notification.onclick = () => {
            try {
              window.focus?.()
            } catch {
              /* focus is a courtesy */
            }
            attention.set({ open: true })
            notification.close?.()
          }
        }
      } catch {
        /* a refused constructor (permission revoked mid-flight) is not fatal */
      }
    }

    /** Ask for notification permission — only ever from an explicit click. */
    async function requestNotificationPermission() {
      try {
        if (!hasNotifications()) return 'unsupported'
        if (notificationDeniedBefore()) return 'denied'
        const result = await window.Notification.requestPermission()
        rememberNotificationAsked(result !== 'granted')
        attention.set({ permission: result })
        return result
      } catch {
        return 'denied'
      }
    }

    /**
     * Open one session from the guide.
     *
     * `ctx.sessions.open(id)` is strict by contract: the id must already exist in
     * THIS window's list, and an unknown id fails loud. The guide, however, lists
     * every session the HOST knows about — including ones this window has never
     * had in its list (opened in another window, or created after this tab
     * loaded). So an open is: try, refresh the list once, try again, and if it
     * still fails say so instead of swallowing it. Silently doing nothing is how
     * this button looked broken.
     */
    async function openSession(sessionId, translate = null) {
      const tr = typeof translate === 'function' ? translate : fallbackTranslator
      const service = sessionsService
      const attempt = () => {
        // No service is not a success: `?.()` would silently do nothing and
        // report that the session opened when nothing happened at all.
        if (typeof service?.open !== 'function') return false
        try {
          service.open(sessionId)
          return true
        } catch {
          return false
        }
      }
      // Opening is only useful if the reader can SEE the session: the guide is a
      // floating panel, so it has to get out of the way. Closing first also means
      // a failed open cannot leave a panel covering the reason it failed.
      const succeed = () => {
        attention.set({ open: false })
        markAttentionOpened(sessionId)
      }
      if (attempt()) {
        succeed()
        return
      }
      // Try once to widen the list, because a stale snapshot is the common case.
      try {
        if (typeof service?.refresh === 'function') await service.refresh()
      } catch {
        /* a failed refresh is just another failed open, reported below */
      }
      if (attempt()) {
        succeed()
        return
      }
      // Still unselectable. There is one honest recovery left: the session is
      // real but not addressable in this window, and opening its WORKSPACE is
      // something the client can always do — `sessions.create({ cwd })` is the
      // same adopt-or-create the sidebar's "+ New session" uses. The reader
      // lands in the right project and can pick the conversation from the tree.
      const session = (attention.get().sessions ?? []).find((entry) => entry.sessionId === sessionId)
      if (session?.dir && typeof service?.create === 'function') {
        try {
          const adopted = await service.create({ cwd: session.dir })
          if (typeof adopted === 'string') {
            attempt()
            attention.set({
              failed: null,
              failedMessage: null,
              open: false,
              notice: tr('attentionOpenedWorkspace', { workspace: session.workspace || session.dir }),
            })
            return
          }
        } catch {
          /* fall through to the plain explanation */
        }
      }
      // Nothing worked. Keep the panel OPEN so the reader can see why: closing it
      // would hide the only explanation of what went wrong.
      attention.set({
        failed: sessionId,
        failedMessage: selectableSessionIds(service)?.has(sessionId)
          ? tr('attentionOpenFailed', { id: sessionId })
          : tr('attentionNotOpenableHint', { id: sessionId }),
      })
      if (typeof setTimeout === 'function') {
        setTimeout(() => {
          if (attention.get().failed === sessionId) attention.set({ failed: null, failedMessage: null })
        }, 6000)
      }
    }

    /** Record that the reader has seen one entry (never for `waiting`). */
    function markAttentionOpened(sessionId) {
      const snapshot = attention.get()
      const session = (snapshot.sessions ?? []).find((entry) => entry.sessionId === sessionId)
      // `waiting` is never cleared by opening: the agent is still blocked until
      // the reader actually answers it inside that session.
      if (session && session.state !== 'waiting') {
        attention.set({ read: { ...snapshot.read, [sessionId]: true }, failed: null, failedMessage: null })
        applyTitle(attentionSummary(attention.get()))
      } else {
        attention.set({ failed: null, failedMessage: null })
      }
    }

    function markAllAttentionRead() {
      const snapshot = attention.get()
      const read = { ...snapshot.read }
      for (const session of snapshot.sessions ?? []) {
        if (session.state !== 'waiting') read[session.sessionId] = true
      }
      attention.set({ read, calloutSeen: true })
      applyTitle(attentionSummary(attention.get()))
    }

    // ── views ─────────────────────────────────────────────────────────────
    function FileRow(props) {
      const { file, active, onSelect } = props
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const shelved = file.shelved === true
      const parts = pathParts(file.path)
      const tooltip = file.oldPath
        ? `${file.oldPath} → ${file.path}`
        : file.untracked
          ? `${file.path} (${t('untracked')})`
          : file.path
      return h(
        'button',
        {
          type: 'button',
          className: `dshCl_row${active ? ' dshCl_rowActive' : ''}${shelved ? ' dshCl_rowShelved' : ''}`,
          'data-origin': file.origin ?? undefined,
          onClick: () => onSelect(file.path),
          onDoubleClick: () => {
            if (copyText(file.path)) flashNotice(t('copiedPath'))
            else flashNotice(t('copyFailed'))
          },
          title: `${tooltip}\n${t('copyHint')}`,
        },
        h('span', { className: `dshCl_status ${STATUS_CLASS[file.status] ?? 'dshCl_sM'}` }, file.status),
        h(
          'span',
          { className: 'dshCl_path' },
          parts.dir ? h('span', { className: 'dshCl_pathDir' }, parts.dir) : null,
          h('span', { className: 'dshCl_pathName' }, parts.name),
        ),
        // A shelved file stays visually distinct; a file that is both opened and
        // shelved shows the action badge *and* the shelved badge.
        file.action ? h('span', { className: 'dshCl_badge', title: file.depotPath ?? '' }, file.action) : null,
        shelved ? h('span', { className: 'dshCl_badge dshCl_badgeShelved', title: t('shelvedFiles') }, t('shelved')) : null,
        file.needsSync ? h('span', { className: 'dshCl_badge dshCl_badgeSync' }, t('needsSync')) : null,
        h(
          'span',
          { className: 'dshCl_counts' },
          typeof file.added === 'number' && file.added > 0 ? h('span', { className: 'dshCl_add' }, `+${file.added}`) : null,
          typeof file.deleted === 'number' && file.deleted > 0 ? h('span', { className: 'dshCl_del' }, `-${file.deleted}`) : null,
          file.binary ? h('span', { className: 'dshCl_counts' }, t('binary')) : null,
        ),
      )
    }

    /**
     * The changed-file list: flat for git (and for any answer without a
     * `changelists` array), grouped under collapsible changelist headers when
     * Perforce reported changelists.
     */
    function FileList(props) {
      const { state, files, selected, onSelect, t, snapshot } = props
      const grouped = Array.isArray(state?.changelists) && state.changelists.length > 0
      if (!grouped) {
        return files.map((file) => h(FileRow, { key: file.path, file, active: file.path === selected, onSelect, t }))
      }
      const { groups, local } = buildGroups(state, files)
      const collapsed = collapsedFor(snapshot)
      const sections = local ? [...groups, local] : groups
      return h(
        'div',
        { className: 'dshCl_groups' },
        sections.map((group) => {
          const rowKey = group.key === 'local' ? 'local' : `change:${group.key}`
          const isCollapsed = collapsed[rowKey] === true
          const entry = group.entry
          const shelved = group.key === 'local' ? false : isShelvedChange(entry) || group.files.some((file) => file.shelved === true)
          const description =
            group.key === 'local'
              ? t('localGroupDesc')
              : oneLine(entry?.description) || t('noDescription')
          const titleText = group.key === 'local' ? t('localGroup') : group.key === 'default' ? t('defaultChange') : t('changeN', { number: group.key })
          return h(
            'div',
            { className: 'dshCl_group', key: rowKey },
            h(
              'button',
              {
                type: 'button',
                className: 'dshCl_groupHead',
                'aria-expanded': isCollapsed ? 'false' : 'true',
                title: `${titleText}\n${entry?.description ?? ''}`,
                onClick: () => toggleGroup(rowKey),
              },
              h('span', { className: 'dshCl_caret' }, isCollapsed ? '▸' : '▾'),
              h('span', { className: `dshCl_groupTitle${group.key === 'local' ? ' dshCl_groupTitleLocal' : ''}` }, titleText),
              shelved ? h('span', { className: 'dshCl_badge dshCl_badgeShelved' }, t('shelved')) : null,
              h('span', { className: 'dshCl_groupDesc' }, description),
              h(
                'span',
                { className: 'dshCl_groupMeta' },
                entry?.user ? h('span', null, entry.user) : null,
                h('span', null, t('files', { count: group.files.length })),
              ),
            ),
            isCollapsed
              ? null
              : h(
                  'div',
                  { className: 'dshCl_groupFiles' },
                  group.files.map((file) =>
                    h(FileRow, { key: file.path, file, active: file.path === selected, onSelect, t }),
                  ),
                ),
          )
        }),
      )
    }

    /**
     * Per-session Perforce connection overrides. Nothing here is persisted to a
     * config file: the boxes only feed the `p4port`/`p4user`/`p4client`/
     * `p4charset` query parameters, and the detected values stay visible next to
     * them so an override can be compared with what the Host actually resolved.
     * A Host that fails to answer leaves `state.workspace` null and the panel
     * simply reads "not detected".
     */
    function ConnectionPanel(props) {
      const { state, t, snapshot, onApply } = props
      // The overrides typed for *this* target, not for whichever one was last
      // edited — a Perforce connection belongs to one project.
      const p4 = p4FieldsFor(snapshot)
      const workspace = state?.workspace ?? null
      const options = state?.options ?? null
      // The Host reads P4V's own configuration (and the plugin config) and echoes
      // the effective connection back, so the panel can pre-fill what is known
      // instead of showing an empty form the reader has to guess at.
      const known = options?.discovered ?? null
      const detected = {
        port: workspace?.port ?? known?.port ?? null,
        user: workspace?.user ?? known?.user ?? null,
        client: workspace?.client ?? known?.client ?? null,
        charset: workspace?.charset ?? known?.charset ?? null,
      }
      const scanSeconds =
        typeof options?.scanTimeoutMs === 'number' && options.scanTimeoutMs > 0
          ? Math.round(options.scanTimeoutMs / 1000)
          : null
      // The box shows what actually ran: an explicit browser choice wins over the
      // Host's own option, so a config-enabled scan still reads as checked.
      const localEditsOn = snapshot?.localEdits === true || (snapshot?.localEdits == null && options?.localEdits === true)
      const field = (key, label, hint) => {
        // Where this value came from: the live connection, P4V's config, or nowhere.
        const origin = detected[key] ? (workspace?.[key] ? t('detected') : t('detectedFromP4V')) : t('notDetected')
        return h(
          'label',
          { className: 'dshCl_panelRow', key },
          h('span', { className: 'dshCl_panelLabel' }, label),
          h('input', {
            className: 'dshCl_input',
            type: 'text',
            value: p4[key] ?? '',
            placeholder: detected[key] ? String(detected[key]) : hint,
            'aria-label': label,
            spellCheck: false,
            onChange: (event) => setP4Override(key, event.target.value),
          }),
          h(
            'span',
            { className: 'dshCl_panelDetected', title: `${origin}: ${detected[key] ?? t('notDetected')}` },
            detected[key] ? String(detected[key]) : t('notDetected'),
          ),
        )
      }
      return h(
        'div',
        { className: 'dshCl_panel' },
        h(
          'div',
          { className: 'dshCl_panelRow' },
          h('span', { className: 'dshCl_panelLabel' }, t('connectionTitle')),
          h('span', { className: 'dshCl_panelHint' }, t('applyHint')),
        ),
        field('port', t('labelPort'), t('portHint')),
        field('user', t('labelUser'), t('userHint')),
        field('client', t('labelClient'), t('clientHint')),
        field('charset', t('labelCharset'), t('charsetHint')),
        h(
          'div',
          { className: 'dshCl_panelRow' },
          h('span', { className: 'dshCl_panelLabel' }, t('clientRoot')),
          h(
            'span',
            { className: 'dshCl_panelDetected', title: workspace?.root ?? '' },
            workspace?.root ? String(workspace.root) : t('notDetected'),
          ),
          workspace?.stream ? h('span', { className: 'dshCl_panelHint' }, `${t('stream')} ${workspace.stream}`) : null,
        ),
        // When Perforce could not be reached, say what the plugin already knew
        // before asking for anything — the reader should be able to tell "P4V
        // had nothing for us" from "we knew the server but could not connect".
        state && state.ok === false && (state.reason === 'p4-unavailable' || state.reason === 'p4-error')
          ? h(
              'div',
              { className: 'dshCl_panelHint' },
              known?.port || known?.user
                ? t('askAfterP4V', { port: known?.port ?? t('notDetected'), user: known?.user ?? t('notDetected') })
                : t('askNothingFound'),
            )
          : null,
        h(
          'label',
          { className: 'dshCl_check' },
          h('input', {
            type: 'checkbox',
            checked: localEditsOn,
            onChange: (event) => store.set({ localEdits: event.target.checked }),
          }),
          h('span', null, t('scanLocalEdits')),
          scanSeconds !== null ? h('span', { className: 'dshCl_panelHint' }, t('scanTimeout', { seconds: scanSeconds })) : null,
        ),
        h('div', { className: 'dshCl_warn' }, t('scanWarning')),
        h(
          'div',
          { className: 'dshCl_panelRow' },
          h('button', { type: 'button', className: 'dshCl_btn', onClick: () => onApply?.() }, t('applyOverrides')),
          h('span', { className: 'dshCl_panelHint' }, t('p4ReadOnly')),
        ),
      )
    }

    function DiffPane(props) {
      const { diff, phase, wrap, path: changedPath } = props
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const path = changedPath
      if (!path) return h('div', { className: 'dshCl_center' }, t('chooseFile'))
      if (phase === 'loading') return h('div', { className: 'dshCl_center' }, t('loadingDiff'))
      if (phase === 'error') return h('div', { className: 'dshCl_center dshCl_error' }, diff?.message ?? t('missing'))
      if (!diff || diff.missing) return h('div', { className: 'dshCl_center' }, t('missing'))
      // A comparison that belongs to another file must never be rendered under
      // this header: while the Host answers for the new selection, show loading.
      if (diff.path !== path) return h('div', { className: 'dshCl_center' }, t('loadingDiff'))
      if (diff.binary) return h('div', { className: 'dshCl_center' }, t('binary'))

      const lines = String(diff.text ?? '').split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const shown = lines.slice(0, MAX_RENDER_LINES)

      return h(
        'div',
        { className: `dshCl_diffWrap${wrap ? ' dshCl_wrap' : ''}` },
        h(
          'div',
          { className: 'dshCl_diffHead' },
          h('span', null, diff.path),
          h('span', null, diff.base ? `→ ${diff.base}` : ''),
          diff.untracked ? h('span', null, t('createdAt')) : null,
        ),
        h(
          'div',
          // Re-mounting on selection change resets the scroll position, so the
          // next file starts at its first line instead of line 800.
          { className: 'dshCl_diffBody', key: path },
          h(
            'pre',
            { className: 'dshCl_pre' },
            shown.map((line, index) => {
              const kind = lineKind(line)
              return h('span', { key: index, className: `dshCl_line ${LINE_CLASS[kind]}` }, line === '' ? ' ' : line)
            }),
          ),
        ),
        diff.truncated || lines.length > shown.length
          ? h('div', { className: 'dshCl_note' }, t('truncated', { count: shown.length }))
          : null,
      )
    }

    function SummaryBody(props) {
      const { snapshot } = props
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const { phase, state, error, selected, diff, diffPhase, targets, target } = snapshot

      // The picker stays available in every state, so a wrong or failing target
      // can always be switched away from without hunting for the right session.
      const options = [...targets]
      if (target && !options.some((entry) => targetKey(entry) === targetKey(target))) {
        options.unshift({ ...target, title: target.title || t('panel') })
      }
      const picker =
        options.length > 1
          ? h(
              'div',
              { className: 'dshCl_picker' },
              h(
                'select',
                {
                  className: 'dshCl_select',
                  value: target ? targetKey(target) : '',
                  onChange: (event) => {
                    const next = options.find((entry) => targetKey(entry) === event.target.value)
                    if (next) selectTarget(next, t)
                  },
                  'aria-label': t('panel'),
                },
                options.map((entry) => {
                  const label = entry.title || entry.id
                  return h(
                    'option',
                    { key: targetKey(entry), value: targetKey(entry) },
                    entry.dir ? `${label} — ${entry.dir}` : label,
                  )
                }),
              ),
            )
          : null

      const detail = state?.ok === false && state.detail ? h('div', { className: 'dshCl_detail' }, state.detail) : null
      const hint =
        state?.ok === false && state.reason === 'not-a-repository'
          ? h('div', { className: 'dshCl_detail' }, t('notRepoHint'))
          : state?.ok === false && state.reason === 'not-a-workspace'
            ? h('div', { className: 'dshCl_detail' }, t('notWorkspaceHint'))
            : state?.ok === false && state.reason === 'p4-unavailable'
              ? h('div', { className: 'dshCl_detail' }, t('p4UnavailableHint'))
              : null
      // A reason the Host named gets its own wording; anything else keeps the
      // old "not a git repository" copy, exactly as an older Host expects.
      const failedFallback =
        state?.reason === 'not-a-workspace'
          ? t('notWorkspace')
          : state?.reason === 'p4-unavailable'
            ? t('p4Unavailable')
            : t('notRepo')

      if (phase === 'loading') {
        return h(
          'div',
          { className: 'dshCl_body' },
          picker,
          h('div', { className: 'dshCl_list' }, skeletonRows(4)),
          h('div', { className: 'dshCl_center' }, t('loading')),
        )
      }
      if (phase === 'empty') {
        return h('div', { className: 'dshCl_body' }, picker, h('div', { className: 'dshCl_center' }, error ?? t('noTargets')))
      }
      if (state?.ok === false) {
        return h(
          'div',
          { className: 'dshCl_body' },
          picker,
          h('div', { className: 'dshCl_center dshCl_error' }, h('div', null, state.message ?? failedFallback, detail, hint)),
        )
      }
      if (phase === 'error') {
        return h('div', { className: 'dshCl_body' }, picker, h('div', { className: 'dshCl_center dshCl_error' }, t('error', { message: error ?? '' })))
      }
      if (phase === 'clean') {
        return h('div', { className: 'dshCl_body' }, picker, h('div', { className: 'dshCl_center' }, t('cleanAgainst', { base: state?.base ?? '' })))
      }

      const files = Array.isArray(state?.files) ? state.files : []
      // Flat for git and for any answer without changelists; grouped for p4.
      const onSelect = (path) => {
        store.set({ selected: path, diff: null, diffPhase: 'loading' })
        void loadDiff(t)
      }
      return h(
        'div',
        { className: 'dshCl_body' },
        picker,
        h(
          'div',
          { className: 'dshCl_list' },
          h(FileList, { state, files, selected, onSelect, t, snapshot }),
        ),
        h(DiffPane, { diff, phase: diffPhase, wrap: snapshot.wrap, path: selected, t }),
      )
    }

    function Popover(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const snapshot = useStore()
      const { open, state, busy, notice, wrap, anchor, panelOpen, vcs } = snapshot

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') store.set({ open: false })
        }
        // Clicking anywhere outside the summary (or the chip that opens it)
        // closes it, like every other floating surface in the app.
        const onPointerDown = (event) => {
          const target = event?.target
          if (typeof target?.closest === 'function' && (target.closest('.dshCl_pop') || target.closest('.dshCl_chip'))) {
            return
          }
          store.set({ open: false })
        }
        window.addEventListener('keydown', onKey)
        const canWatchDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
        if (canWatchDocument) document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          if (canWatchDocument) document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      if (!open) return null

      const files = Array.isArray(state?.files) ? state.files : []
      const totals = totalOf(files)
      // The directory stays on screen: "not a repository" must never be a
      // mystery about which folder was inspected.
      const targetDir = state?.dir ?? snapshot.target?.dir ?? ''
      // Freshness is part of the answer: a count with no timestamp is either
      // trusted too much or not at all.
      const updated = clockOf(state?.generatedAt)
      // Anchored under the chip when it could be measured; otherwise the
      // stylesheet's default corner placement applies.
      const placement = anchor
        ? anchor.top !== null
          ? { top: `${anchor.top}px`, right: `${anchor.right}px` }
          : { bottom: `${anchor.bottom}px`, right: `${anchor.right}px` }
        : undefined

      return h(
        'div',
        { className: 'dshCl_pop', role: 'dialog', 'aria-label': t('panel'), style: placement },
        h(
          'div',
          { className: 'dshCl_head' },
          h('h3', { className: 'dshCl_title' }, t('panel')),
          updated
            ? h('span', { className: 'dshCl_stamp', title: `${t('updatedAt', { time: updated })} · ${targetDir}` }, t('updatedAt', { time: updated }))
            : null,
          // 自动 / git / Perforce. The choice is a request parameter only: the
          // session target still outranks it and any remembered directory.
          h(
            'select',
            {
              className: 'dshCl_vcs',
              value: vcs,
              title: t('backend'),
              'aria-label': t('backend'),
              onChange: (event) => changeBackend(event.target.value, t),
            },
            h('option', { value: 'auto' }, t('autoBackend')),
            h('option', { value: 'git' }, t('gitBackend')),
            h('option', { value: 'p4' }, t('p4Backend')),
          ),
          state?.ok
            ? h(
                'div',
                { className: 'dshCl_meta' },
                metaParts(state, t),
                h('span', { className: 'dshCl_backend' }, backendLabel(state, t)),
                h('span', { className: 'dshCl_add' }, `+${totals.added}`),
                h('span', { className: 'dshCl_del' }, `-${totals.deleted}`),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dshCl_btn',
              'aria-expanded': panelOpen ? 'true' : 'false',
              // Opening or closing by hand clears the "the plugin opened this"
              // flag, so an automatic close never fights the reader.
              onClick: () => store.set({ panelOpen: !panelOpen, panelAuto: false }),
            },
            t('connection'),
          ),
          h(
            'button',
            { type: 'button', className: 'dshCl_btn', disabled: busy || !snapshot.target, onClick: () => void loadState({ t }) },
            t('refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshCl_btn',
              disabled: busy || !snapshot.target,
              onClick: () => void loadState({ fetchRemote: true, t }),
            },
            t('fetchRemote'),
          ),
          h(
            'button',
            { type: 'button', className: 'dshCl_btn', onClick: () => store.set({ wrap: !wrap }) },
            wrap ? t('noWrap') : t('wrapping'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshCl_iconBtn',
              onClick: () => store.set({ open: false }),
              title: t('close'),
              'aria-label': t('close'),
            },
            '✕',
          ),
        ),
        h(
          'div',
          { className: 'dshCl_dir', title: `${t('directory')}: ${targetDir}` },
          targetDir,
        ),
        panelOpen
          ? h(ConnectionPanel, {
              state,
              t,
              snapshot,
              onApply: () => {
                void loadState({ t })
              },
            })
          : null,
        h(SummaryBody, { snapshot, t }),
        snapshot.hostCompat === 'dir' ? h('div', { className: 'dshCl_note' }, t('oldHost')) : null,
        notice ? h('div', { className: 'dshCl_note' }, notice) : null,
        Array.isArray(state?.notes) && state.notes.length > 0 ? h('div', { className: 'dshCl_note' }, state.notes.join('\n')) : null,
      )
    }

    /** Measure the pill so the guide panel can sit beside it. */
    function measurePill(event) {
      try {
        const element = event?.currentTarget ?? event?.target
        const box = element?.getBoundingClientRect?.()
        if (!box || typeof box.bottom !== 'number') return null
        const viewportHeight = window.innerHeight || 0
        return {
          left: Math.max(8, box.right + 8),
          // Align the panel's bottom with the pill, so it opens upward beside
          // the sidebar and never covers the workspace list it points at.
          bottom: Math.max(8, viewportHeight - box.bottom),
        }
      } catch {
        return null
      }
    }

    /**
     * The always-visible pill at the sidebar foot.
     *
     * It is registered into `sidebar.footer.action` rather than
     * `sidebar.workspaces`: that seat is `single` and owned by ui-workspace, so
     * replacing it would replace the whole session browser. The foot seat is a
     * `list`, which is exactly "add one more control here".
     */
    function AttentionPill(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const snapshot = useAttention()
      const summary = attentionSummary(snapshot)
      const rail = props.wide === false

      // Poll while this surface is mounted. The visible/hidden cadence is the
      // whole freshness story: no event feed exists for unopened sessions.
      React.useEffect(() => {        let timer = null
        let disposed = false
        const isHidden = () => {
          try {
            return typeof document !== 'undefined' && document.visibilityState === 'hidden'
          } catch {
            return false
          }
        }
        const tick = async () => {
          if (disposed) return
          await loadAttention({ t })
          if (disposed) return
          timer = setTimeout(tick, isHidden() ? attentionTuning.pollHiddenMs : attentionTuning.pollVisibleMs)
        }
        void loadAttention({ t, silent: true })
        timer = setTimeout(tick, attentionTuning.pollVisibleMs)
        const onVisible = () => {
          // Coming back from another window is exactly when a stale count is
          // most misleading, so refresh immediately rather than on the tick.
          if (!isHidden()) void loadAttention({ t })
        }
        const canWatch = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
        if (canWatch) document.addEventListener('visibilitychange', onVisible)
        return () => {
          disposed = true
          if (timer) clearTimeout(timer)
          if (canWatch) document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      const worst = summary.worst
      // `attentionEnabled: false` on the Host means the reader turned this
      // feature off: claim no space in the sidebar at all.
      if (snapshot.enabled === false) return null
      // A pill that cannot see must say so. Rendering "全部正常" after a failed
      // read is the one lie this surface must never tell.
      const blind = snapshot.reachable === false
      const label = rail
        ? ''
        : blind
          ? t('attentionPillUnknown')
          : worst === 'waiting'
            ? t('attentionPillWaiting', { count: summary.counts.waiting })
            : worst === 'error'
              ? t('attentionPillError', { count: summary.counts.error })
              : worst === 'done'
                ? t('attentionPillDone', { count: summary.unread })
                : worst === 'running'
                  ? t('attentionPillRunning', { count: summary.counts.running })
                  : t('attentionPillClear')

      // The call-out is the "pointer": it says out loud that something above in
      // this list needs a click, and collapses once the reader has seen it.
      const callout =
        !rail && worst === 'waiting' && snapshot.calloutSeen !== true
          ? h('span', { className: 'dshAt_callout' }, t('attentionCalloutWaiting', { count: summary.counts.waiting }))
          : null

      const openPanel = (event) => {
        const next = !attention.get().open
        if (next) {
          // Opening the panel is "seen": the arrow has done its job.
          attention.set({ open: true, anchor: measurePill(event), calloutSeen: true })
          void loadAttention({ t })
        } else {
          attention.set({ open: false })
        }
      }

      return h(
        'div',
        { className: 'dshAt_root' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshAt_pill',
            'data-state': blind ? 'unknown' : worst ?? 'clear',
            'data-rail': rail ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            'aria-expanded': snapshot.open ? 'true' : 'false',
            'aria-label': `${t('attentionPanel')} · ${label || t('attentionPillClear')}`,
            title: `${t('attentionPanel')}\n${blind ? t('attentionUnknownHint') : t('attentionQuietLine')}`,
            onClick: openPanel,
          },
          worst === 'waiting' ? h('span', { className: 'dshAt_caret', 'aria-hidden': 'true' }, '▲') : null,
          h('span', { className: 'dshAt_dot', 'data-state': blind ? 'unknown' : worst ?? 'clear' }),
          rail ? null : h('span', { className: 'dshAt_text' }, label),
        ),
        callout,
      )
    }

    /**
     * The guide panel: every session that needs a human, grouped by the
     * workspace it belongs to — the actual question ("which project?") is
     * answered by the group header, not by a path the reader has to parse.
     */
    function AttentionPanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const snapshot = useAttention()
      const summary = attentionSummary(snapshot)
      const { open, anchor, sessions } = snapshot

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') attention.set({ open: false })
        }
        const onPointerDown = (event) => {
          const target = event?.target
          if (typeof target?.closest === 'function' && (target.closest('.dshAt_pop') || target.closest('.dshAt_pill'))) return
          attention.set({ open: false })
        }
        window.addEventListener('keydown', onKey)
        const canWatch = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
        if (canWatch) document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          if (canWatch) document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      if (!open) return null
      // The panel follows the same switch as the pill: no feature, no surface.
      if (snapshot.enabled === false) return null

      const placement = anchor ? { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` } : undefined
      // A `running` session is informational only; the guide is about what the
      // reader may need to act on, so it sorts the loud states first and keeps
      // running/idle at the bottom rather than hiding them.
      const ordered = [...sessions].sort((left, right) => {
        const rank = ATTENTION_STATE_ORDER.indexOf(left.state) - ATTENTION_STATE_ORDER.indexOf(right.state)
        if (rank !== 0) return rank
        return (right.at ?? 0) - (left.at ?? 0)
      })
      // Which rows this window can actually select. `null` means "cannot tell"
      // (the list snapshot has not arrived); those stay clickable because
      // openSession refreshes the list before giving up.
      const selectable = selectableSessionIds(sessionsService)
      const groups = attentionGroups(ordered)
      const permission = snapshot.permission
      const canAsk = permission === 'default' && !notificationAsked()
      const read = snapshot.read ?? {}

      return h(
        'div',
        { className: 'dshAt_pop', role: 'dialog', 'aria-label': t('attentionPanel'), style: placement },
        h(
          'div',
          { className: 'dshAt_head' },
          h('h3', { className: 'dshAt_title' }, t('attentionPanel')),
          h(
            'span',
            { className: 'dshAt_headMeta', 'aria-live': 'polite' },
            t('attentionWatching', { seconds: Math.round(attentionTuning.pollVisibleMs / 1000) }),
          ),
          summary.unread > 0
            ? h('button', { type: 'button', className: 'dshCl_btn', onClick: () => markAllAttentionRead() }, t('attentionMarkAllRead'))
            : null,
          h('button', { type: 'button', className: 'dshCl_iconBtn', 'aria-label': t('close'), onClick: () => attention.set({ open: false }) }, '✕'),
        ),
        h(
          'div',
          { className: 'dshAt_body' },
          // Losing contact outranks the last known rows: showing them alone
          // would present stale state as current. The warning comes first and
          // the rows stay below it, clearly demoted.
          snapshot.reachable === false
            ? h('div', { className: 'dshAt_empty dshAt_emptyWarn' }, t('attentionUnknownBody'))
            : null,
          snapshot.reachable === false && ordered.length > 0
            ? h('div', { className: 'dshAt_staleHead' }, t('attentionStaleRows'))
            : null,
          ordered.length === 0
            ? snapshot.reachable === false
              ? null
              : h('div', { className: 'dshAt_empty' }, t('attentionEmpty'))
            : groups.map((group) =>
                h(
                  'div',
                  { className: 'dshAt_group', key: group.key || group.name },
                  h(
                    'div',
                    { className: 'dshAt_groupHead' },
                    h('span', { className: 'dshAt_groupName', title: group.name }, group.name || t('attentionUnknownWorkspace')),
                    h('span', { className: 'dshAt_groupCount' }, String(group.sessions.length)),
                  ),
                  group.sessions.map((session) => {
                    const openable = selectable === null || selectable.has(session.sessionId)
                    return h(
                      'button',
                      {
                        type: 'button',
                        key: session.sessionId,
                        className: `dshAt_row${read[session.sessionId] ? ' dshAt_rowRead' : ''}`,
                        'data-failed': snapshot.failed === session.sessionId ? 'true' : undefined,
                        'data-openable': openable ? 'true' : 'false',
                        title: openable
                          ? `${session.title ?? ''}${session.dir ? `\n${session.dir}` : ''}`
                          : t('attentionNotOpenableHint', { id: session.sessionId }),
                        onClick: () => void openSession(session.sessionId, t),
                      },
                      h('span', { className: 'dshAt_stateIcon', 'data-state': session.state, 'aria-hidden': 'true' }, ATTENTION_ICON[session.state] ?? '·'),
                      h(
                        'span',
                        { className: 'dshAt_rowMain' },
                        // The group header already names the workspace. When the
                        // session has no real title the Host falls back to the
                        // directory basename, which repeats the header verbatim;
                        // show the reason line alone rather than saying it twice.
                        (session.title || session.sessionId) === group.name
                          ? null
                          : h('span', { className: 'dshAt_rowTitle' }, session.title || session.sessionId),
                        h(
                          'span',
                          { className: 'dshAt_rowMeta' },
                          h('span', { className: 'dshAt_rowReason' }, `${t(ATTENTION_STATE_KEY[session.state] ?? 'stateIdle')} · ${attentionReason(session, t)}`),
                          h('span', { className: 'dshAt_rowDot' }, '·'),
                          h('span', null, attentionAgo(session.at, t)),
                        ),
                      ),
                      h(
                        'span',
                        { className: 'dshAt_openHint' },
                        snapshot.failed === session.sessionId
                          ? t('attentionOpenFailedShort')
                          : openable
                            ? t('attentionOpen')
                            : t('attentionNotInList'),
                      ),
                    )
                  }),
                ),
              ),
        ),
        ordered.length > 0
          ? h(
              'div',
              { className: 'dshAt_legend' },
              summary.counts.waiting > 0
                ? h('span', { className: 'dshAt_legendItem' }, h('span', { className: 'dshAt_dot', 'data-state': 'waiting' }), t('stateWaiting'))
                : null,
              summary.counts.error > 0
                ? h('span', { className: 'dshAt_legendItem' }, h('span', { className: 'dshAt_dot', 'data-state': 'error' }), t('stateError'))
                : null,
              summary.counts.done > 0
                ? h('span', { className: 'dshAt_legendItem' }, h('span', { className: 'dshAt_dot', 'data-state': 'done' }), t('stateDone'))
                : null,
              summary.counts.running > 0
                ? h('span', { className: 'dshAt_legendItem' }, h('span', { className: 'dshAt_dot', 'data-state': 'running' }), t('stateRunning'))
                : null,
            )
          : null,
        // An open that failed is reported right here, in the surface the reader
        // is looking at; the footer already carries the permission state, so the
        // failure takes the slot and the permission line moves to its tooltip.
        snapshot.failedMessage
          ? h('div', { className: 'dshAt_failBar', role: 'status' }, snapshot.failedMessage)
          : null,
        snapshot.notice
          ? h('div', { className: 'dshAt_noticeBar', role: 'status' }, snapshot.notice)
          : null,
        h(
          'div',
          { className: 'dshAt_foot' },
          h(
            'span',
            { className: 'dshAt_footText' },
            permission === 'granted'
              ? t('attentionQuietLine')
              : permission === 'denied'
                ? t('attentionNotificationsBlocked')
                : t('attentionNotificationsOff'),
          ),
          canAsk
            ? h(
                'button',
                { type: 'button', className: 'dshCl_btn', onClick: () => void requestNotificationPermission() },
                t('attentionEnableNotifications'),
              )
            : null,
        ),
      )
    }

    function ChangelistChip(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const snapshot = useStore()
      // A slot-provided session wins; otherwise ask the client service which
      // session the main view is showing, so the chip follows the project the
      // user is actually looking at rather than a remembered directory.
      const sessionId =
        props.sessionId ?? (typeof props.getViewedSessionId === 'function' ? props.getViewedSessionId() : null) ?? null

      React.useEffect(() => {
        let cancelled = false
        const apply = async (id) => {
          const targets = await loadTargets()
          if (cancelled) return
          const target = pickTarget(targets, id)
          if (!target) return
          await selectTarget(target, t)
        }
        void apply(sessionId)
        // Automatic refresh rides on this surface being mounted: it is the one
        // that is always on screen, and the watcher is shared module-wide, so a
        // second chip adds a reference instead of a second timer. The release is
        // the effect's cleanup — unmounting leaves no timer behind.
        const releaseWatch = watchMount(t)
        // Follow the session once it becomes known, and across session switches.
        const unsubscribe =
          typeof props.subscribeViewedSession === 'function'
            ? props.subscribeViewedSession((nextId) => {
                const current = store.get().target
                const currentId = current?.kind === 'session' ? current.id : null
                if (nextId && nextId !== currentId) void apply(nextId)
              })
            : undefined
        return () => {
          cancelled = true
          releaseWatch()
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [])

      const { phase, state, error, open } = snapshot
      const files = Array.isArray(state?.files) ? state.files : []
      const totals = totalOf(files)

      let dot = 'loading'
      let label = t('summary')
      if (phase === 'clean') {
        dot = 'clean'
        label = t('clean')
      } else if (state?.reason === 'not-a-repository' || state?.reason === 'not-a-workspace') {
        // A workspace outside version control is a fact about the folder, not a
        // failure of the panel, so it reads neutral instead of alarming. The
        // same applies when Perforce says the directory is not a client root.
        dot = 'norepo'
        label = state.reason === 'not-a-workspace' ? t('notWorkspaceChip') : t('notRepoChip')
      } else if (phase === 'error' || state?.ok === false || phase === 'empty') {
        // `p4-unavailable` / `p4-error` keep the error colour and show the
        // Host's own words in the popover; the chip itself never breaks.
        dot = 'error'
        label = t('summary')
      } else if (phase === 'ready') {
        dot = 'dirty'
        label = `${files.length}`
      }

      const detail = chipDetail(state, totals, t) ?? (error ?? t('hint'))
      const where = state?.dir ?? snapshot.target?.dir ?? ''

      return h(
        'div',
        { className: 'dshCl_root' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshCl_chip',
            'data-open': open ? 'true' : 'false',
            title: `${t('panel')}\n${where}\n${detail}`,
            'aria-label': t('panel'),
            onClick: (event) => {
              const next = !store.get().open
              store.set({ open: next, anchor: next ? measureAnchor(event) : store.get().anchor })
              if (next) void loadState({ t })
            },
          },
          h('span', { className: 'dshCl_dot', 'data-state': dot }),
          state?.ok ? h('span', { className: 'dshCl_backend' }, backendLabel(state, t)) : null,
          phase === 'ready'
            ? [
                h('span', { key: 'n', className: 'dshCl_chipText' }, t('shortFiles', { count: files.length })),
                h('span', { key: 'a', className: 'dshCl_chipAdd' }, `+${totals.added}`),
                h('span', { key: 'd', className: 'dshCl_chipDel' }, `−${totals.deleted}`),
              ]
            : h('span', { className: 'dshCl_chipText' }, label),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      /**
       * Test seam, not API. The poll cadence and the notification batch window
       * are wall-clock timings; exposing them here lets the verification suite
       * drive a transition without sleeping five seconds. Nothing in the
       * plugin reads this object except the defaults it was born with.
       */
      attentionInternals: { tuning: attentionTuning, store: attention, load: loadAttention, summary: attentionSummary },
      /**
       * Test seam, not API. Same reasoning as `attentionInternals`: the poll
       * cadence and the throttle are wall-clock timings, and the timer is a
       * module-level singleton, so the suite needs a handle to drive one tick,
       * read the armed delay, fire a visibility change and observe the unmount.
       * Production never touches it.
       */
      changeInternals: {
        tuning: watchTuning,
        /**
         * The cadence as loaded. `tuning` is mutable so the suite can drive the
         * clock; this snapshot is what the shipped defaults actually are, taken
         * before anything can change them.
         */
        productionTuning: { ...watchTuning },
        store,
        watcher: watchState,
        applied: appliedRevByTarget,
        tick: watchTick,
        mount: watchMount,
        reset: watchReset,
        revision: loadRevision,
        /** The handlers the DOM listeners would call, for a shim without events. */
        visibility: (options = {}) => watchTick({ compensate: true, ...options }),
        /** The delay the armed timer was scheduled with (`null` when idle). */
        armedDelay: () => watchState.pendingDelay,
        /** Mount count: proves a second surface joins instead of adding a timer. */
        users: () => watchState.users,
        /** Forget a target's baseline, as a directory change would. */
        forget: forgetRev,
      },
      apply(ctx) {
        if (typeof ctx.locale?.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'changelist: dictionaries')
        }
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : fallbackTranslator
        const getViewedSessionId = () => viewedSessionId(ctx.sessions)
        const subscribeViewedSession = (listener) => watchViewedSession(ctx.sessions, listener)
        // The attention guide opens sessions, so it needs the service too.
        sessionsService = ctx.sessions ?? null

        ctx.effect(() => {
          const tagId = '@local/dsh-changelist/changelist.css'
          if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) {
            return () => {}
          }
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-changelist'
          tag.dataset.pluginCss = tagId
          tag.textContent = css
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'changelist: styles')

        // Top-right summary chip, inside the session header's utilities row.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: CHIP_ID,
              order: 0,
              locale: NS,
              // `store` travels with the registration as a read-only look at the
              // shared snapshot. The chip and the popover read the same module
              // state, so a test that renders only one of them can still tell
              // which target the other one is currently pointed at.
              inject: () => ({ getViewedSessionId, subscribeViewedSession, store }),
            },
            ChangelistChip,
          ),
        )

        // The floating summary itself, in the shell overlay layer.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: POPOVER_ID,
              order: 0,
              locale: NS,
            },
            Popover,
          ),
        )

        // ── cross-project attention ───────────────────────────────────────
        // L3a: the always-visible status pill at the sidebar foot. It lives in
        // the `sidebar.footer.action` list seat because `sidebar.workspaces` is
        // `single` and owned by ui-workspace — replacing that would replace the
        // whole session browser just to add a badge.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: ATTENTION_PILL_ID,
              order: 0,
              locale: NS,
            },
            AttentionPill,
          ),
        )
        // L3b: the guide panel it opens, in the overlay layer so it can point
        // at the pill from outside the sidebar's own scroll container.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: ATTENTION_PANEL_ID,
              order: 0,
              locale: NS,
            },
            AttentionPanel,
          ),
        )

        // Seed what the platform lets us know about L1/L2 once, at mount. Asking
        // for permission here would be hostile: it waits for an explicit click.
        // The poll itself, including the visibility refresh, belongs to the
        // pill's own effect — that surface is the one that is always mounted.
        ctx.effect(() => {
          attention.set({ permission: notificationPermission(), read: {}, calloutSeen: false, waitingKey: '' })
          return () => {
            // Leaving the composition must not leave a `(2) ` prefix behind.
            resetTitle()
            applyBadge({ unread: 0 })
            if (notifyTimer) {
              clearTimeout(notifyTimer)
              notifyTimer = null
            }
            notifyPending = []
            attention.set({ open: false })
          }
        }, 'changelist: attention lifecycle')
      },
    }
  },
})
