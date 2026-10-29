/** 「开始 / 结束」节点的声明解析（纯逻辑，脱离调度器与界面直接单测）。
 *
 * ## 为什么要单独一个文件
 *
 * 两个节点的参数都是**一行的文本清单**（`kind: 'list'`，一行一项）：
 *
 *   开始节点 `fields`：`日期 | 要采集哪一天 | 必填 | 2026-10-17`
 *   结束节点 `fields`：`汇总 = n15.json`
 *
 * 解析要容错（存档被手改、用户少写一列、多写空格），而容错的判据
 * **两侧必须一致**（界面显示「有 3 项」而执行层解析出 2 项就麻烦了）。
 * 所以解析只有这一份，客户端与宿主半都引它。
 *
 * ## 参照
 *
 *   · n8n 的 **When Executed by Another Workflow** 触发节点有三种声明输入的方式
 *     （Define using fields below / Define using JSON example / Accept all data）——
 *     我们取 **fields below** 那种形状（一行一个字段），因为它最贴近 `.list` 控件。
 *     出处 https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflowtrigger.md
 *   · Dify 的 End 节点：`outputs` 每项 = 变量名 + `value_selector`（选节点 + 选字段）。
 *     出处 `refs-projects/dify/web/app/components/workflow/nodes/end/default.ts`
 *
 * ## 容错规则（都写在这里，别在调用处各判一遍）
 *
 *   · 空行、`#` 开头的行忽略；
 *   · 分隔符：开始节点用 `|`（全角 `｜` 也认），结束节点用 `=`（全角 `＝` 也认）；
 *   · 名字两端空白去掉；**名字为空的那一行整行忽略**（不是报错）；
 *   · 结束节点的值：`节点id.字段` → 拆成两段；只有一个点号的最后一段当字段；
 *     形如 `名字`（没有 `=`）→ 值取**同名上游字段**。
 */

/** 开始节点声明的一项输入。 */
export interface InputField {
  /** 名字（下游用 `{{名字}}` 取）。 */
  name: string
  /** 说明（可空）。 */
  description: string
  /** 是否必填（默认否）。 */
  required: boolean
  /** 默认值（文本形式；可空表示没有默认值）。 */
  default?: string
}

/** 结束节点声明的一项产出。 */
export interface OutputField {
  /** 对外叫的名字。 */
  name: string
  /** 取哪个节点的哪个字段（`field` 为空串 = 取那个节点的整体输出）。 */
  nodeId: string
  field: string
}

/**
 * 把一个值当作「一行一项的清单」拆开。
 *
 * 参数可能是数组（`.list` 控件的正常值）、也可能是字符串
 * （存档被手改过、或别的工具写的），两种都认。
 *
 * @param raw - 参数原值。
 * @returns 去掉空行后的文本行。
 */
function linesOf(raw: unknown): string[] {
  const arr: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : []
  return arr
    .map(x => (typeof x === 'string' ? x : x === null || x === undefined ? '' : String(x)))
    .map(s => s.trim())
    .filter(s => s !== '' && !s.startsWith('#'))
}

/**
 * 按一组分隔符拆一行（全角与半角都认）。
 *
 * 为什么只按第一个出现的分隔符拆而不用 `split(sep)`：结束节点的值里
 * 可能还有别的 `=`（很少见，但用户手工写的时候会），全拆会把值切碎。
 *
 * @param line - 一行文本。
 * @param half - 半角分隔符。
 * @param full - 全角分隔符。
 * @returns 上半段与下半段（没有分隔符时下半段为空串）。
 */
function splitOnce(line: string, half: string, full: string): { head: string, tail: string } {
  let at = line.indexOf(half)
  const fullAt = line.indexOf(full)
  if (at < 0) at = fullAt
  else if (fullAt >= 0 && fullAt < at) at = fullAt
  if (at < 0) return { head: line.trim(), tail: '' }
  return { head: line.slice(0, at).trim(), tail: line.slice(at + 1).trim() }
}

/**
 * 解析开始节点的输入声明。
 *
 * 每行格式：`名字 | 说明 | 是否必填 | 默认值`（后三项都可省略）。
 * 「是否必填」认这几样：`必填` / `true` / `是` / `1`（其余一律当否）。
 *
 * @param raw - `params.fields` 的原值。
 * @returns 声明列表（顺序保持用户写的顺序）。
 */
export function parseInputFields(raw: unknown): InputField[] {
  const out: InputField[] = []
  for (const line of linesOf(raw)) {
    /* 按 `|` 拆成最多 4 段（第 4 段里再出现 `|` 就留在默认值里）。 */
    const parts = line.split(/[|｜]/).map(s => s.trim())
    const name = parts[0] ?? ''
    if (name === '') continue
    const requiredRaw = (parts[2] ?? '').toLowerCase()
    const required = requiredRaw === '必填' || requiredRaw === 'true' || requiredRaw === '是' || requiredRaw === '1'
    const def = parts.length > 3 ? parts.slice(3).join('|').trim() : ''
    const item: InputField = { name, description: parts[1] ?? '', required }
    if (def !== '') item.default = def
    out.push(item)
  }
  return out
}

/**
 * 解析结束节点的产出声明。
 *
 * 每行格式：`名字 = 节点id.字段`。
 *   · 没有 `=` 时：名字与节点名都取该行（等价于「交出同名上游字段」）；
 *   · 值里没有 `.` 时：整段当作**节点 id**、字段为空串（取它的整体输出）。
 *
 * @param raw - `params.fields` 的原值。
 * @returns 声明列表。
 */
export function parseOutputFields(raw: unknown): OutputField[] {
  const out: OutputField[] = []
  for (const line of linesOf(raw)) {
    const { head, tail } = splitOnce(line, '=', '＝')
    if (head === '') continue
    const src = tail === '' ? head : tail
    const dot = src.lastIndexOf('.')
    if (dot <= 0 || dot === src.length - 1) {
      /* 没有 `.`（或点在开头/结尾）→ 整段当节点 id、取整体输出。 */
      out.push({ name: head, nodeId: src, field: '' })
      continue
    }
    out.push({ name: head, nodeId: src.slice(0, dot), field: src.slice(dot + 1) })
  }
  return out
}

/** 一项「名字 = 值」的赋值（父流程喂给子流程、或前端填给开始节点时用）。 */
export interface Assignment {
  /** 名字（子流程声明里的那个字段名）。 */
  name: string
  /**
   * 值（文本形式）。
   *
   * `undefined` 表示**这一行只写了名字、没写值** —— 语义是「取同名变量」，
   * 由调用方决定从哪取（见 `run.ts` 的 `readGivenInputs`）。
   * 用 `undefined` 而不是空串来区分「没写」与「写了空串」：
   * 后者是「明确给它一个空值」，两者在下游表现不同。
   */
  value?: string
}

/**
 * 解析「名字 = 值」的清单（喂给子工作流 / 前端填输入都用这一份）。
 *
 * 每行格式：`名字 = 值`（半角与全角等号都认）。
 * 只写名字没有等号 → `value` 为 `undefined`（「取同名变量」）。
 *
 * @param raw - 一行一项的清单（数组或换行文本）。
 * @returns 赋值列表（顺序保持）。
 */
export function parseAssignments(raw: unknown): Assignment[] {
  const out: Assignment[] = []
  for (const line of linesOf(raw)) {
    const { head, tail } = splitOnce(line, '=', '＝')
    if (head === '') continue
    const item: Assignment = { name: head }
    /* `tail` 为空且原行里**没有等号**才是「没写值」。
     * `splitOnce` 把「没有等号」与「等号后面是空的」都归成 tail === ''，
     * 所以这里用原行判断一次。 */
    const hasEq = line.includes('=') || line.includes('＝')
    if (hasEq) item.value = tail
    out.push(item)
  }
  return out
}

/**
 * 把「外部给进来的值」与「声明的默认值」合成本次运行的输入表。
 *
 * 优先级：**外部给的值 > 默认值**（这是 n8n 与 Dify 一致的语义：
 * 参数表里填了就用填的，没填才用默认）。
 *
 * ⚠️ **只认声明过的字段** —— 外部多给的一律丢掉。
 * 理由：与用户 m00901 定的「没有开始节点不是换个地方接」同一条纪律 ——
 * 接什么由开始节点说了算，不悄悄塞别的进来。
 *
 * @param fields - 解析好的声明。
 * @param given - 外部给的值（可能缺、可能多）。
 * @returns 本次运行的输入表（键 = 字段名）。
 */
export function resolveInputs(fields: readonly InputField[], given: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const g = given?.[f.name]
    if (g !== undefined) out[f.name] = g
    else if (f.default !== undefined) out[f.name] = f.default
  }
  return out
}

/**
 * 检查必填项有没有缺。
 *
 * @param fields - 解析好的声明。
 * @param resolved - `resolveInputs` 的产出。
 * @returns 缺的字段名（空数组 = 都齐了）。
 */
export function missingRequired(fields: readonly InputField[], resolved: Record<string, unknown>): string[] {
  return fields
    .filter(f => f.required)
    .map(f => f.name)
    .filter(name => {
      const v = resolved[name]
      return v === undefined || v === null || v === ''
    })
}
