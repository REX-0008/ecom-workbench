/** 系统通知（宿主半）。
 *
 * ## 为什么是 PowerShell 而不是 Electron / dsh 的通知能力
 *
 * 计划 `plans/2026-10-21-工作台板块重构与运营闭环.md` §二「通知通道（实测过）」：
 * `System.Windows.Forms.NotifyIcon` 弹气球实测 **BALLOON_OK**，
 * `ToastNotificationManager` 实测 **WINRT_OK**；而 dsh host 包**没有** Notification 能力
 * （查过 `@deepseek-ai/dsh-host-*` 的导出）。所以最省事的做法是**起一个 PowerShell 子进程**。
 *
 * 这里选气球（NotifyIcon）而不是 Toast：Toast 要 AUMID + 注册快捷方式，
 * 在「不是安装出来的应用」里那套身份不成立；气球只要一个进程就能弹。
 *
 * ## 参数怎么传进去（不拼字符串）
 *
 * 标题与正文走**环境变量**（`EWB_NOTIFY_TITLE` / `EWB_NOTIFY_TEXT`），不拼进脚本。
 * 拼进去就要处理单引号、换行、`$` 转义 —— 那是白送的 bug 面。
 *
 * ## 测试闸门
 *
 * `EWB_TEST_NO_SPAWN=1` 时**不弹**（与 `src/index.ts` 的「打开目录」同一个闸门）。
 * 跑测试弹一堆气球会打断用户，而把整条路由跳过又等于没验 ——
 * 所以只闸住「弹」这一下，命令拼装与前两项探测照跑。
 */
import { spawn, type ChildProcess } from 'node:child_process'

/** 一条检查的结果。 */
export interface NotifyCheck {
  /** 这一项过没过。 */
  ok: boolean
  /** 为什么（给人看的一句话，成败都要有）。 */
  reason: string
}

/** 自检的三项。 */
export interface NotifySelfcheck {
  /** 能不能起 PowerShell。 */
  powershell: NotifyCheck
  /** 弹得出来吗（真的弹一条）。 */
  balloon: NotifyCheck
  /** 系统通知总开关（读注册表）。 */
  pushSwitch: NotifyCheck
}

/** 正在跑的子进程（`ctx.effect` 清理时要把它们收掉）。 */
const running = new Set<ChildProcess>()

/**
 * 把一条通知脚本交给 Windows PowerShell 跑完。
 *
 * @param script - 脚本正文。
 * @param env - 额外环境变量（标题正文走这里）。
 * @param timeoutMs - 超时（到点就杀，返回失败而不是一直挂着）。
 * @returns 退出码与输出。
 */
function runPowerShell(script: string, env: Record<string, string> = {}, timeoutMs = 20000): Promise<{
  code: number | null
  stdout: string
  stderr: string
  error?: string
}> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      /* ⚠️ 用 `powershell.exe`（Windows PowerShell 5.1）而**不是** `pwsh`：
       * 5.1 默认 STA，WinForms 要 STA；pwsh 是 MTA，弹不出来。 */
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: { ...process.env, ...env },
      })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) })
      return
    }
    running.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    /** 收口一次。 */
    const finish = (code: number | null, error?: string): void => {
      if (settled) return
      settled = true
      running.delete(child)
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ...error === undefined ? {} : { error } })
    }
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (e: Error) => { finish(null, e.message) })
    child.on('close', (code) => { finish(code) })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(null, 'PowerShell 超时（' + String(timeoutMs) + ' 毫秒）')
    }, timeoutMs)
  })
}

/** 弹气球用的脚本（正文里不出现任何外部字符串）。 */
const BALLOON_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  'Add-Type -AssemblyName System.Drawing | Out-Null',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.Visible = $true',
  '$n.ShowBalloonTip(5000, $env:EWB_NOTIFY_TITLE, $env:EWB_NOTIFY_TEXT, [System.Windows.Forms.ToolTipIcon]::Info)',
  'Start-Sleep -Milliseconds 6000',
  '$n.Visible = $false',
  '$n.Dispose()',
  "Write-Output 'NOTIFY_OK'",
].join('\n')

/**
 * 发一条系统通知（Win 的气球提示）。
 *
 * @param title - 标题。
 * @param text - 正文。
 * @returns 发没发出去 + 原因。
 */
export async function notify(title: string, text: string): Promise<NotifyCheck> {
  if (process.env.EWB_TEST_NO_SPAWN === '1') {
    return { ok: true, reason: '测试闸门 EWB_TEST_NO_SPAWN=1：没有真的弹（只验到命令拼装）' }
  }
  if (process.platform !== 'win32') {
    return { ok: false, reason: '只有 Windows 有这套系统通知（当前 ' + process.platform + '）' }
  }
  const r = await runPowerShell(BALLOON_SCRIPT, {
    EWB_NOTIFY_TITLE: title.slice(0, 60),
    EWB_NOTIFY_TEXT: text.slice(0, 200),
  })
  if (r.stdout.includes('NOTIFY_OK')) return { ok: true, reason: '已弹出（气球提示）' }
  const why = r.error ?? (r.stderr.trim() !== '' ? r.stderr.trim() : '退出码 ' + String(r.code))
  return { ok: false, reason: '弹不出来：' + why }
}

/**
 * 收掉还在跑的通知进程（插件卸载 / 热重载时用）。
 *
 * 为什么需要：弹一条通知要 PowerShell 驻留 6 秒（气球显示期间进程不能退）。
 * 插件卸载时留一个还在睡的 PowerShell 不致命，但它**带着旧闭包**、
 * 卸载后还会弹一次 —— 那属于「代码改了行为没变」那类难查的问题。
 * 所以 `src/index.ts` 用一个 `ctx.effect` 挂上它。
 */
export function killAll(): void {
  for (const c of [...running]) {
    try { c.kill() } catch { /* 已退出 */ }
  }
  running.clear()
}

/**
 * 自检三项（提醒板块的「通道自检」用）。
 *
 * 顺序照「先弄清能不能起、再试弹、最后看总开关」——
 * 前面一项失败时，后面那项的结果没有意义，但照样报出来（不隐瞒）。
 *
 * @returns 三项各自的结论与原因。
 */
export async function selfcheck(): Promise<NotifySelfcheck> {
  /* ① 能不能起 PowerShell：只问版本号，不弹任何东西。 */
  let powershell: NotifyCheck
  if (process.platform !== 'win32') {
    powershell = { ok: false, reason: '不是 Windows，没有 PowerShell 这条路' }
  } else {
    const r = await runPowerShell('Write-Output $PSVersionTable.PSVersion.ToString()', {}, 15000)
    const ver = r.stdout.trim()
    powershell = r.code === 0 && ver !== ''
      ? { ok: true, reason: 'PowerShell 可用（版本 ' + ver + '）' }
      : { ok: false, reason: '起不来：' + (r.error ?? (r.stderr.trim() !== '' ? r.stderr.trim() : '退出码 ' + String(r.code))) }
  }

  /* ② 能不能弹：真的弹一条（测试闸门里只验命令拼装）。 */
  const balloon = await notify('电商 AI 工作台', '通知自检：能看到这条就说明通知能发。')

  /* ③ 系统通知总开关：读 HKCU 的 PushNotificationsToastEnabled。 */
  let pushSwitch: NotifyCheck
  if (process.platform !== 'win32') {
    pushSwitch = { ok: false, reason: '不是 Windows，没有这个开关' }
  } else {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications'
    const r = await runPowerShell('reg query "' + key + '" /v ToastEnabled', {}, 15000)
    const text = r.stdout
    const m = /ToastEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(text)
    if (m !== null) {
      const on = parseInt(m[1], 16) !== 0
      pushSwitch = { ok: on, reason: on ? '总开关是开的（ToastEnabled=1）' : '总开关被关掉了（ToastEnabled=0）—— 弹也会被系统吞掉' }
    } else {
      /* 没这个值 = 用户从没关过 → Windows 按**开**处理。如实说出来。 */
      pushSwitch = { ok: true, reason: '注册表里没有 ToastEnabled（用户没关过，按系统默认「开」处理）' }
    }
  }

  return { powershell, balloon, pushSwitch }
}
