/** 在桌面创建「QQ浏览器 CDP (9222)」快捷方式。
 *
 * ## 为什么有这个脚本
 *
 * 用户会用它手动把浏览器准备好（带 CDP 调试端口、保留日常登录态）。
 * 那个快捷方式**被误删过两次**（2026-10-16 ×2），每次都要重新问参数。
 * 所以把配方固化成一条命令：`node scripts/make-cdp-shortcut.mjs`。
 *
 * ## 参数从哪来（**别自己发明**）
 *
 * 抄自原项目 `D:\ecom-data\自动下载\src\launch-qqb.ts` —— 那是
 * 委托人一直在用、实测能干活的启动参数。唯一有意去掉的是 `--start-minimized`：
 * 原脚本带它是因为**脚本自动拉起**时不该打扰桌面；而这个快捷方式是**用户
 * 自己点的**，开出来就是要用的，最小化反而多一步。
 *
 * 用法：
 * ```
 * node scripts/make-cdp-shortcut.mjs              # 建到桌面
 * node scripts/make-cdp-shortcut.mjs --dry-run    # 只打印要写什么
 * ```
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

/** QQ 浏览器的可执行文件。
 *
 * ⚠️ **不许写死盘符**（2026-10-16 踩到）：用户这台机器上它在 **F 盘**，
 * 而原项目 `launch-qqb.ts` 里写的是 `D:\...`（那是委托人当时的环境）。
 * 我按 D 盘写死建了个快捷方式 —— **指向一个不存在的文件**，双击没反应。
 * 同一天原项目那份 `launch-qqb.ts` 也是坏的（所以日志里才有那些红字）。
 *
 * 找的顺序（从可靠到兜底）：
 *   1. **运行中的进程的实际路径** —— 最可靠，与 `src/index.ts` 的探测同思路；
 *   2. 常见安装路径（C / D / E / F 盘各一份）。
 */
function findQqb() {
  /* ① 问正在跑的进程要真实路径（`.Path` 就是 exe 的绝对路径）。 */
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command',
    'Get-Process QQBrowser -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path',
  ], { encoding: 'utf8', windowsHide: true })
  const running = String(r.stdout ?? '').trim()
  if (running !== '' && existsSync(running)) return running
  /* ② 常见路径。 */
  const tried = []
  for (const drive of ['C', 'D', 'E', 'F']) {
    for (const mid of ['Program Files', 'Program Files (x86)']) {
      const p = drive + ':\\' + mid + '\\Tencent\\QQBrowser\\QQBrowser.exe'
      tried.push(p)
      if (existsSync(p)) return p
    }
  }
  return null
}
const EXE = findQqb()
/** QQ 浏览器的工作目录（快捷方式的「起始位置」）。 */
const EXE_DIR = EXE === null ? '' : EXE.slice(0, EXE.lastIndexOf('\\'))
/** 调试端口。与原项目 `launch-qqb.ts` 一致（9222）。 */
const PORT = 9222
/** 快捷方式里的启动参数。 */
const ARGS = [
  '--remote-debugging-port=' + String(PORT),
  '--remote-debugging-address=127.0.0.1',
  '--no-first-run',
  '--no-default-browser-check',
].join(' ')
/** 快捷方式的名字。 */
const NAME = 'QQ浏览器 CDP (' + String(PORT) + ')'
/** 说明文字（鼠标悬停能看到）。 */
const DESC = '启动 QQ 浏览器并开 CDP 调试端口 ' + String(PORT) + '（电商 AI 工作台靠它连上，保留登录态）'

/**
 * 桌面目录。
 *
 * ⚠️ **不要用 `~/Desktop`** —— 这台机器的桌面被重定向到了 `D:\Desktop`
 * （实测 `USERPROFILE\Desktop` 不存在）。所以问 WScript.Shell 要真路径。
 *
 * @returns 桌面目录绝对路径。
 */
function desktopDir() {
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')",
  ], { encoding: 'utf8', windowsHide: true })
  const out = String(r.stdout ?? '').trim()
  return out !== '' ? out : homedir() + '\\Desktop'
}

const dry = process.argv.includes('--dry-run')
if (EXE === null || !existsSync(EXE)) {
  console.error('找不到 QQ 浏览器。')
  console.error('先启动一次 QQ 浏览器（这样能问到它的真实路径），或改本文件顶部的 findQqb()。')
  process.exit(1)
}
const desktop = desktopDir()
const lnk = desktop + '\\' + NAME + '.lnk'
console.log('目标程序 : ' + EXE)
console.log('启动参数 : ' + ARGS)
console.log('快捷方式 : ' + lnk)
if (dry) {
  console.log('（--dry-run，不写文件）')
  process.exit(0)
}

/* 用 PowerShell 的 WScript.Shell 写 —— Node 没有建快捷方式的标准库。 */
const ps = [
  '$sh = New-Object -ComObject WScript.Shell',
  '$s = $sh.CreateShortcut(' + psStr(lnk) + ')',
  '$s.TargetPath = ' + psStr(EXE),
  '$s.Arguments = ' + psStr(ARGS),
  '$s.WorkingDirectory = ' + psStr(EXE_DIR),
  '$s.IconLocation = ' + psStr(EXE + ',0'),
  '$s.Description = ' + psStr(DESC),
  '$s.Save()',
  'if (Test-Path ' + psStr(lnk) + ') { "ok" } else { "fail" }',
].join('; ')
const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
if (String(r.stdout ?? '').trim() !== 'ok') {
  console.error('创建失败：' + String(r.stderr ?? ''))
  process.exit(1)
}
console.log('')
console.log('已建好。两个使用前提：')
console.log('  1. QQ 浏览器必须先完全退出再双击它 —— 同一数据目录是单实例，')
console.log('     已经在跑时带参数启动只会被转发给现有窗口然后退出，端口起不来。')
console.log('  2. 起来后别关那个浏览器（登录态是资产，要的是常驻）。')
console.log('验证：新标签打开 http://127.0.0.1:' + String(PORT) + '/json/version')

/**
 * 把字符串转成 PowerShell 单引号字面量（单引号内 `'` 要写两遍）。
 * @param {string} s - 原字符串。
 * @returns 可安全拼进命令行的字面量。
 */
function psStr(s) {
  return "'" + s.replace(/'/g, "''") + "'"
}
