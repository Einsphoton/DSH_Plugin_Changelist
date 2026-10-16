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
      '.dshCl_row{display:flex;align-items:center;gap:8px;width:100%;padding:4px 8px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshCl_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCl_rowActive{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCl_status{flex:none;width:13px;text-align:center;font-family:var(--ds-font-family-code);font-size:11px;font-weight:700}',
      '.dshCl_sM{color:var(--dsw-alias-state-warn-primary,#bf8700)}',
      '.dshCl_sA{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dshCl_sD{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dshCl_sR{color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dshCl_path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);font-size:12px}',
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
    let generation = 0

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

    async function loadTargets() {
      try {
        const body = await requestJson(`${BASE}.targets`)
        const targets = Array.isArray(body.targets) ? body.targets : []
        store.set({ targets })
        if (targets.length === 0 && store.get().target === null) {
          store.set({ phase: 'empty', error: null })
        }
        return targets
      } catch (cause) {
        store.set({ phase: 'error', error: cause.message })
        return []
      }
    }

    async function loadState(options = {}) {
      const snapshot = store.get()
      const query = targetQuery(snapshot)
      if (!query) return
      const token = ++generation
      store.set({ busy: true })
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
          notice: body.fetch
            ? body.fetch.ok
              ? options.t?.('fetchOk', { remote: body.fetch.remote }) ?? null
              : options.t?.('fetchFailed', { remote: body.fetch.remote, message: body.fetch.message ?? '' }) ?? null
            : store.get().notice,
          // Auto-detected per project: a Perforce workspace that cannot be
          // reached asks for its connection; anything else closes a panel the
          // plugin itself opened.
          ...(connectionPromptPatch(body, store.get()) ?? {}),
        })
      } catch (cause) {
        if (token !== generation) return
        store.set({
          phase: 'error',
          error:
            cause.status === 403 && cause.body?.allowed
              ? `${cause.message}\n${cause.body.allowed.join('  ')}`
              : cause.message,
        })
      } finally {
        if (token === generation) store.set({ busy: false })
      }
    }

    async function loadDiff(t) {
      const snapshot = store.get()
      const query = targetQuery(snapshot)
      if (!query || !snapshot.selected) return
      const token = generation
      store.set({ diffPhase: 'loading' })
      try {
        const extra = { path: snapshot.selected }
        if (snapshot.state?.base) extra.base = snapshot.state.base
        Object.assign(extra, requestExtra(store.get()))
        // A Perforce file needs its own coordinates: the depot path reaches the
        // shelved/opened revision, the change number and the flags tell the Host
        // which comparison was asked for. Git (and an older Host) never sees these.
        if (backendOf(snapshot.state) === 'P4') {
          const files = Array.isArray(snapshot.state?.files) ? snapshot.state.files : []
          const file = files.find((entry) => entry?.path === snapshot.selected)
          if (file) {
            if (file.depotPath) extra.depotPath = file.depotPath
            if (file.change !== undefined && file.change !== null) extra.change = String(file.change)
            if (file.shelved === true) extra.shelved = '1'
            if (file.untracked === true || file.origin === 'local') extra.changed = '1'
          }
        }
        const { body } = await requestTarget('diff', query, snapshot.target, extra)
        if (token !== generation) return
        store.set({ diff: body, diffPhase: 'ready' })
      } catch (cause) {
        if (token !== generation) return
        store.set({
          diff: { path: snapshot.selected, message: t('error', { message: cause.message }), text: '' },
          diffPhase: 'error',
        })
      }
    }

    /** Point the store at one target and (re)load everything for it. */
    function selectTarget(target, t, options = {}) {
      if (!target) return
      generation++
      store.set({
        target,
        // Auto-detect for this project. If the reader picked a backend for it by
        // hand, that choice comes back; otherwise detection decides, so a git
        // project and a Perforce project in one window each get the right mode
        // without the reader saying so.
        vcs: rememberedVcs(target),
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
      return loadState({ ...options, t }).then(() => loadDiff(t))
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
      void loadState({ t }).then(() => loadDiff(t))
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

    // ── views ─────────────────────────────────────────────────────────────
    function FileRow(props) {
      const { file, active, onSelect } = props
      const t = typeof props.t === 'function' ? props.t : fallbackTranslator
      const shelved = file.shelved === true
      return h(
        'button',
        {
          type: 'button',
          className: `dshCl_row${active ? ' dshCl_rowActive' : ''}${shelved ? ' dshCl_rowShelved' : ''}`,
          'data-origin': file.origin ?? undefined,
          onClick: () => onSelect(file.path),
          title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.untracked ? `${file.path} (${t('untracked')})` : file.path,
        },
        h('span', { className: `dshCl_status ${STATUS_CLASS[file.status] ?? 'dshCl_sM'}` }, file.status),
        h('span', { className: 'dshCl_path' }, file.path),
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
          { className: 'dshCl_diffBody' },
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

      if (phase === 'loading') return h('div', { className: 'dshCl_body' }, picker, h('div', { className: 'dshCl_center' }, t('loading')))
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
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      const files = Array.isArray(state?.files) ? state.files : []
      const totals = totalOf(files)
      // The directory stays on screen: "not a repository" must never be a
      // mystery about which folder was inspected.
      const targetDir = state?.dir ?? snapshot.target?.dir ?? ''
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
                void loadState({ t }).then(() => loadDiff(t))
              },
            })
          : null,
        h(SummaryBody, { snapshot, t }),
        snapshot.hostCompat === 'dir' ? h('div', { className: 'dshCl_note' }, t('oldHost')) : null,
        notice ? h('div', { className: 'dshCl_note' }, notice) : null,
        Array.isArray(state?.notes) && state.notes.length > 0 ? h('div', { className: 'dshCl_note' }, state.notes.join('\n')) : null,
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
      apply(ctx) {
        if (typeof ctx.locale?.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'changelist: dictionaries')
        }
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : fallbackTranslator
        const getViewedSessionId = () => viewedSessionId(ctx.sessions)
        const subscribeViewedSession = (listener) => watchViewedSession(ctx.sessions, listener)

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
      },
    }
  },
})
