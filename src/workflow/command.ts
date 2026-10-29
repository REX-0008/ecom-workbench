/** 节点 → 派发命令（把参数翻译成各执行方能懂的命令体）。
 *
 * 为什么在客户端算：
 *   客户端知道**节点定义**（参数默认值）、知道**这次实例填了什么**、还知道**上游给了什么**。
 *   把这些一起翻译成一条明确的命令再发给宿主，宿主就只剩「执行」一件事——不查表、不猜默认值。
 *   这正是 dsh 的做法：执行方只认相对完整的命令。
 *
 * 按执行方的通用约定（节点没写 `toCommand` 时用）：
 *   - builtin：命令 = { node: 节点 id, params }，宿主按节点 id 找内置函数
 *   - http：命令 = { url, method, headers, body }
 *   - shell：命令 = { argv, cwd }，argv 逐项传（不经过 shell 转义）
 *   - agent：命令 = { prompt }
 */
import type { CanvasNode, CommandContext, NodeDef, RunContextValues } from './model.ts'
import { toCommandContext } from './model.ts'
import { substituteDeep, fieldsFromUpstream, type VariableScope } from './variables.ts'

/** 派发请求（与宿主半 dispatch/dispatcher.ts 的 DispatchRequest 对齐）。 */
export interface DispatchRequest {
  /** 本次运行 id。 */
  runId: string
  /** 节点实例 id。 */
  nodeId: string
  /** 派发给谁。 */
  executor: string
  /** 执行方各自解释的命令体。 */
  command: unknown
  /** 上下文。 */
  context: {
    /** 所属工作流名。 */
    workflowId: string
    /** 上游节点的输出（按连线顺序）。 */
    upstream: unknown[]
    /** 工作目录。 */
    workdir: string
    /** 额外环境变量。 */
    env?: Record<string, string>
  }
}

/** 从参数里取一个字符串（没有就用 fallback）。 */
function str(params: Record<string, unknown>, key: string, fallback = ''): string {
  const v = params[key]
  return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v)
}

/** 把 JSON 文本解析成对象；空串或解析不出来就原样返回文本。 */
function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined
  try { return JSON.parse(text) } catch { return text }
}

/** 按 shell 名字给出可执行文件（argv 的第一项）。 */
function shellBin(name: string): string {
  return name === 'powershell' ? 'powershell' : name === 'bash' ? 'bash' : 'cmd.exe'
}

/**
 * 节点 → 派发命令。
 *
 * **第一步先做变量替换**（把参数里的 `{{名字}}` 换成上游实际值）——
 * 放这里一处生效，26 个节点都不用各自处理。再把参数交给「按执行方套的通用约定」，
 * 或者节点自己写的 `toCommand`。
 *
 * @param def - 节点定义。
 * @param params - 本次实例的参数（已合并默认值）。
 * @param upstream - 上游节点的输出（按连线顺序）。
 * @param scope - 额外的变量取值来源（环境变量 / 全局变量），可选。
 * @param runCtx - 运行上下文（**不是这个节点填的**值，如开始节点选的模型），可选。
 *   会经 `toCommandContext` 收成最小授权的那一份再交给 `toCommand`，见下。
 * @returns 命令体，以及没找到的变量名。
 */
export function buildCommand(
  def: NodeDef,
  params: Record<string, unknown>,
  upstream: unknown[],
  scope?: VariableScope,
  runCtx?: RunContextValues,
): { command: unknown, missing: string[] } {  /* 变量替换：上游字段 + 调用方给的 fields / env / vars。
   *
   * ⚠️ `fields` 是**合并在上游字段之上**，不是取代（2026-10-12 改）。
   * 原先写成 `scope?.fields ?? fieldsFromUpstream(upstream)` —— 一旦调用方传了 fields，
   * 上游字段就**整体消失**。当时没有调用方传它，所以没暴露问题；
   * 但循环要往里注入迭代变量（item / index），若用取代语义，
   * 循环体内的节点就会**读不到上游数据**，只剩 item。
   * 所以改成叠加：上游字段在底层，调用方的 fields 覆盖同名键。 */
  const full: VariableScope = {
    fields: { ...fieldsFromUpstream(upstream), ...scope?.fields },
    env: scope?.env,
    vars: scope?.vars,
  }
  const sub = substituteDeep(params, full)
  const p = sub.value as Record<string, unknown>
  /* ⚠️ `runCtx` **不进 `full.fields`**（2026-10-23）：进了就等于让 `{{__model}}` 能取到，
   * 也会让它混进参数替换结果。它只走 `toCommand` 的第二参这条独立通道。 */
  return { command: commandOf(def, p, upstream, runCtx), missing: sub.missing }
}

/**
 * 参数已验证并替换过 → 命令体（按执行方套约定，或走节点自定义）。
 *
 * @param def - 节点定义。
 * @param params - 替换后的参数。
 * @param upstream - 上游输出。
 * @param runCtx - 运行上下文（只给 `toCommand` 用，通用约定那几条不读它）。
 * @returns 命令体。
 */
function commandOf(
  def: NodeDef,
  params: Record<string, unknown>,
  upstream: unknown[],
  runCtx?: RunContextValues,
): unknown {
  if (def.toCommand !== undefined) return def.toCommand(params, toCommandContext(runCtx, def, params))
  switch (def.executor) {
    case 'http': {
      const method = str(params, 'method', 'GET').toUpperCase()
      const headers = parseJson(str(params, 'headers'))
      const body = upstream.length === 1 ? upstream[0] : upstream.length > 1 ? upstream : undefined
      const cmd: Record<string, unknown> = { url: str(params, 'url'), method }
      if (typeof headers === 'object' && headers !== null) cmd.headers = headers
      if (body !== undefined && method !== 'GET') cmd.body = body
      return cmd
    }
    case 'shell': {
      const command = str(params, 'command')
      const argv = command === '' ? [] : [shellBin(str(params, 'shell', 'cmd')), '/c', command]
      const cwd = str(params, 'cwd')
      const cmd: Record<string, unknown> = { argv }
      if (cwd !== '') cmd.cwd = cwd
      return cmd
    }
    case 'agent':
      return { prompt: str(params, 'prompt', def.summary ?? def.label) }
    default:
      // builtin：宿主按节点 id 找函数，参数原样给过去
      return { node: def.id, params }
  }
}

/**
 * 取一个节点实例最终生效的参数（实例填的优先，缺的回退到节点默认值）。
 *
 * @param node - 画布节点实例。
 * @param def - 它的节点定义。
 * @returns 合并后的参数。
 */
export function effectiveParams(node: CanvasNode, def: NodeDef): Record<string, unknown> {
  return { ...(def.params ?? {}), ...(node.params ?? {}) }
}
