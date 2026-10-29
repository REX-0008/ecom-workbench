/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * ## 它怎么跑（2026-10-27 定的，票 09）
 *
 * **走 shell 执行方，命令是 `python -c <脚本>`。** 不新增执行方，理由三条：
 *
 * ① `code.shell` 的语义就是「起一个子进程跑一条命令、把 stdout 当输出」。
 *    `python -c "..."` 对执行方来说与 `cmd /c xxx.bat` 没有区别 ——
 *    新增一种执行方要把 spawn / 取消 / 杀树 / 超时再写一遍，那是同一段代码第二份。
 * ② n8n 用 Pyodide、Dify 用外部执行服务，都是为了解决**它们自己的部署问题**
 *    （n8n 不想替用户管 Python 环境、Dify 是多租户 SaaS 不能在容器里跑任意代码）。
 *    我们跑在用户自己的机器上，Python 本来就是用户装的。
 * ③ 单独执行方能多给的只有「把上游塞进 stdin」这一件，其余 shell 那个全有。
 *
 * ## 两个实测出来的坑（都必需，别删）
 *
 * **① 中文乱码**：直接跑 `python -c`，`print("中文")` 拿回来是乱码。
 *    加 `PYTHONIOENCODING=utf-8` 与 `PYTHONUTF8=1` 两个环境变量才对 ——
 *    所以下面 `toCommand` 把它们一起交出去（shell 执行方会与运行环境变量合并）。
 *
 * **② 多行代码与引号不用转义**：走的是 argv 数组，不经过 shell 解析。
 *    所以下面**不要**去拼 `cmd /c "python -c \"...\""` —— 那才真会踩引号与转义。
 *
 * ## 上游数据怎么给：用 `{{变量}}`，没有 `DSH_INPUT`
 *
 * `toCommand` 拿到的第二参只有 `model`（见 `workflow/model.ts` 的 `CommandContext`），
 * **拿不到上游**。所以上游数据靠**变量替换**：代码里直接写 `{{字段}}`，
 * 引擎在拼命令之前就把它换成实际值了（与所有节点同一条规则）。
 *
 * ⚠️ 这个节点曾经在说明里写着「上游数据通过环境变量 `DSH_INPUT` 读」——
 * 那个变量**全仓从来没有过**，是句假承诺（与「界面上写着能调、引擎不读」同一类毛病）。
 * 现在改成如实的说法，写进 `cautions`。
 *
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { CommandContext, NodeDef } from '../../../workflow/model.ts'

/** 从参数里取字符串（节点定义是纯数据，不依赖外部工具函数）。 */
function text(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

export const NODE: NodeDef = {
  id: 'code.python',
  category: 'code',
  label: '执行 Python',
  summary: '跑一段 Python（打印什么就输出什么）',
  executor: 'shell',
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  outputs: [{ id: 'out', label: '输出', type: 'any' }],
  deps: { bin: ['python'] },
  onError: 'stop',
  /**
   * 让节点上的「超时上限」参数真正生效（与 `code.shell` 同一个做法）。
   *
   * 不写这一行的话，界面上那个参数又是一句做不到的承诺 ——
   * 实际生效的只有派发器全局 300 秒（契约 BE 修的就是这一类）。
   */
  timeoutParam: 'timeout',
  params: { code: 'print("hello")', timeout: 60000, cwd: '' },
  /**
   * 拼命令：`python -c <整段脚本>`，外加两个编码变量。
   *
   * ## 为什么代码整段塞进 `-c`
   *
   * n8n 与 Dify 都是「代码变成一段脚本文本、交给一个 python 进程去跑」
   * （n8n 塞进 Pyodide / task runner，Dify 塞进 `python3_transformer.py` 拼的模板）。
   * `-c` 就是那条最直接的等价物，不落临时文件 —— 落文件要处理清理、并发同名、权限。
   *
   * ## 为什么 `cwd` 只在填了时才写
   *
   * 与 `code.shell` 同一条「能省一个键就省」：不填就走运行目录，
   * 行为与改动前一致（`executors.ts` 那句 `cmd?.cwd ?? req.context.workdir`）。
   *
   * @param params - 参数（`{{变量}}` 已替换过）。
   * @param ctx - 运行上下文（本节点不用它，签名要求有）。
   * @returns shell 执行方认的命令体。
   */
  toCommand: (params: Record<string, unknown>, ctx?: CommandContext): unknown => {
    void ctx
    const code = text(params.code)
    const cwd = text(params.cwd)
    const cmd: Record<string, unknown> = {
      argv: ['python', '-c', code],
      /* ⚠️ 两个都必需：`PYTHONUTF8` 让 Python 走 UTF-8 模式，
       * `PYTHONIOENCODING` 管 stdout 的编码。少一个中文就可能乱码（实测过）。 */
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }
    if (cwd !== '') cmd.cwd = cwd
    return cmd
  },
  detail: {
    /* ⚠️ 这些字符串会直接显示在节点设置里，不许出现 Markdown 的 `**`
     * （`tests/copy-no-markdown.mjs` 钉着：用户可见位置出现 `**` 会原样显示成星号）。 */
    what: '在本机跑一段 Python 脚本，脚本打印出来的内容就是这个节点的输出。'
      + '用的解释器是本机装的 python（PATH 里那个），所以能 import 标准库、也能用本机装好的第三方包。',
    inputs: '上游数据通过变量引用：在代码里写 {{字段}}，引擎会在跑之前把它换成实际值。'
      + '注意是替换进代码文本，所以复杂对象会变成一段字符串 —— '
      + '要在 Python 里当数据结构用，就 import json 再 json.loads 一次。',
    outputs: '脚本 print 出来的内容（一段文本，已去掉首尾空白）。'
      + '要交出结构化数据就 print 一段 JSON，后面接「执行 JavaScript」或别的节点解析。',
    whenToUse: '已有的 Python 脚本要接进工作流；或者要做一段 JavaScript 不好写的加工'
      + '（表格处理、中文分词、调本机装好的第三方库）。',
    cautions: '① 输出是脚本的 stdout。写进 stderr 的内容会进运行日志，不算输出；'
      + '脚本以非 0 退出码结束时这个节点判失败，失败原因取 stderr。\n'
      + '② 上游数据只能用 {{字段}} 引用，没有别的通道 —— '
      + '代码里读不到什么「输入环境变量」，那是这个节点早期说明里的错话，已经改掉。\n'
      + '③ 编码已经处理好了（内部给 python 设了 UTF-8），打印中文不会乱码。\n'
      + '④ 需要本机装了 Python 才有意义。没装时执行会报「找不到 python」这类错，'
      + '照报错装一个即可（缺依赖目前不提前拦，见备忘第 9 条）。\n'
      + '⑤ 代码里不要假设当前目录：脚本用到相对路径时，把「在哪个目录执行」填对。\n'
      + '⑥ 超时会终止整个 python 进程（连它起的子进程一起），运行记录里写明超时。',
  },
  paramDefs: [
    {
      key: 'code',
      label: 'Python 代码',
      kind: 'textarea',
      default: 'print("hello")',
      required: true,
      hint: '整段脚本。用 print 把结果交出去（stdout 才是输出）。'
        + '可以用 {{变量}} 取上游字段。',
    },
    {
      key: 'cwd',
      label: '在哪个目录执行',
      kind: 'text',
      default: '',
      placeholder: '如 D:\\\\ecom-data',
      hint: '脚本的工作目录。脚本里用了相对路径时必须填对，否则找不到文件。留空则用运行目录。',
    },
    {
      key: 'timeout',
      label: '超时上限',
      kind: 'number',
      default: 60000,
      unit: '毫秒',
      min: 1000,
      step: 1000,
      advanced: true,
      hint: '超过该时长判为失败并终止 python 进程。默认 60000 毫秒（60 秒）。处理大批数据时调大。',
    },
  ],
}
