/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * 一个节点一个目录 —— 见 `plans/2026-10-08-板块范式与目录规划.md` §2 与总纲「节点化」条。
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'code.shell',
  category: 'code',
  label: '执行命令',
  summary: '执行系统命令（可调用现有 bat 脚本）',
  executor: 'shell',
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  outputs: [{ id: 'out', label: '输出', type: 'text' }, { id: 'code', label: '退出码', type: 'number' }],
  onError: 'continueErrorOutput',
  /**
   * 本类节点的超时上限：**10 分钟**（契约 BD，2026-10-25）。
   *
   * ## 为什么是它（如实交代证据，不编理由）
   *
   * 我核过真实运行记录（`runs/` 下 7 份，全部节点的耗时）：
   * 最长的是 `browser.act` 46.8 秒、`code.shell` 8.3 秒 ——
   * **当前没有任何节点真的跑超过 300 秒**。所以这里不是「已经出过事」，而是：
   *
   *   ① 本节点的参数说明写着「采集类脚本可能需调至数十分钟」——
   *      那是它存在的理由之一（把现成 bat 包进工作流）；
   *   ② 曾经有一段时间，那个 `timeout` 参数**执行层根本不读**（`commandOf` 的
   *      shell 分支只拼 `argv` / `cwd`，shell 执行方也不看命令体里的超时），
   *      于是实际生效的唯一天花板是派发器的全局 300 秒；
   *   ③ 那时一条跑了 6 分钟的采集脚本会被判超时并杀掉，而用户在节点上填的值不起作用。
   *      **这一条已经修掉了**（契约 BE，见下面的 `timeoutParam`）：现在填多少就用多少。
   *
   * ## 现在这个数字管什么
   *
   * `timeoutMs: 600000` 是**用户什么都没填时的上限**（10 分钟）。
   * 用户填了更大的就按他填的走 —— 三层优先级是
   * 「实例参数 > 这里的静态值 > 派发器全局 300 秒」，实现在
   * `workflow/model.ts` 的 `readTimeout`。
   *
   * 10 分钟是「够跑完一段采集、又不至于让卡死的进程挂太久」的折中值。
   */
  timeoutMs: 600000,
  /**
   * 让节点上的「超时上限」参数（`params.timeout`）真正生效（契约 BE）。
   *
   * 界面上那个参数一直写着「超过该时长判定失败并终止命令」，
   * 而在此之前引擎**一个字都没读它** —— 界面在做一个做不到的承诺。
   * 加这一行之后：填了就按填的走，没填就用上面的 600000。
   */
  timeoutParam: 'timeout',
  params: { command: '', cwd: '', shell: 'cmd', timeout: 120000 },
  detail: {
    what: '执行一条命令行指令。这是把现有 bat 脚本接入工作流的入口——「下载抖音 / 下载天猫 / 清洗入库」等 bat 均可包装成该节点。',
    inputs: '任意上游数据（不用也行）。',
    outputs: '命令的输出文字；以及退出码（0 表示成功）。',
    whenToUse: '要调用现成脚本、或做本程序做不到的系统操作时。',
    cautions: '退出码非 0 会走「失败」出口。命令写错可能导致意外操作，建议先用简单命令验证。',
  },
  paramDefs: [
    { key: 'command', label: '命令', kind: 'text', required: true, placeholder: 'cmd /c "D:\\脚本\\下载抖音.bat"',
      hint: '要执行的完整命令。调用 bat 用 cmd /c "路径"；路径含空格要加引号。' },
    { key: 'cwd', label: '在哪个目录执行', kind: 'text', placeholder: 'D:\\ecom-data',
      hint: '命令的工作目录。脚本里用了相对路径时必须填对，否则找不到文件。' },
    { key: 'shell', label: '用哪个解释器', kind: 'select', default: 'cmd', options: [
      { value: 'cmd', label: 'cmd.exe', description: 'Windows 默认；执行 bat 用此项' },
      { value: 'powershell', label: 'PowerShell', description: '执行 .ps1 或复杂管道' },
      { value: 'bash', label: 'bash', description: '已安装 Git Bash / WSL 时' },
    ], hint: '执行 .bat 脚本选 cmd.exe；执行 .ps1 脚本选 PowerShell。' },
    { key: 'timeout', label: '超时上限', kind: 'number', default: 120000, unit: '毫秒', min: 1000, step: 1000, advanced: true,
      hint: '超过该时长判定失败并终止命令。默认 120000 毫秒（2 分钟）。采集类脚本可能需调至数十分钟。' },
  ],
}
