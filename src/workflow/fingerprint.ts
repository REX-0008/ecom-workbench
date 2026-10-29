/** 工作流存档的**执行指纹**（票 17，2026-10-27）。
 *
 * ## 它解决什么
 *
 * 挂起时存了现场，但没存「当时这份工作流长什么样」。恢复时不管工作流后来改没改，
 * 都按旧现场往下跑 —— 用户改过节点参数、删过节点，点「继续」后界面显示成功，
 * 实际跑的是旧数据。**这比报错更糟，因为看不出来。**
 *
 * 于是：存现场时算一份指纹一起写进去，恢复时重算、比对，不一致就拒绝。
 *
 * ## 算哪些字段：只算**会改变执行结果**的
 *
 * | 算 | 为什么 |
 * | --- | --- |
 * | `nodes[].id` | 上游数据按 id 存，改了 id 就对不上 |
 * | `nodes[].defId` | 换节点类型等于换实现 |
 * | `nodes[].params` | 参数就是「这一步做什么」 |
 * | `nodes[].onError` | 失败时停还是继续，结果完全不同 |
 * | `nodes[].skipped` | 跳过与否决定这一步跑不跑 |
 * | `nodes[].parentId` | 容器归属：它决定某个节点在哪个循环体里跑 |
 * | `edges[].source` / `target` | 连线决定谁在谁之后 |
 * | `edges[].sourceHandle` / `targetHandle` | 出口决定走哪条分支 |
 *
 * | **不算** | 为什么 |
 * | --- | --- |
 * | `nodes[].position` | 纯视觉。用户只是把节点挪了个位置，不该被判成「工作流改动」 |
 * | `nodes[].label` / `note` | 实例名与备注只影响运行历史里显示成什么，不影响跑 |
 * | `nodes[].type` | 存档格式版本号（`'v1'`），与执行无关 |
 * | 顶层 `name` / `id` / `description` | 改名不该让一次已跑一半的运行作废 |
 * | `edges[].id` | 边的编号只是画布内部标识 |
 *
 * ## ⚠️ 为什么**不能**拿「派发规格」去算
 *
 * 派发规格（`toRunSpecs` 的产物）里 `params` 已经**合过浏览器偏好**
 * （`applyPrefsToSpecs` 会往 `port` / `launcher` 里补值）。用户的偏好一改，
 * 指纹就变了 —— 于是「只改了浏览器端口」也会被判成「工作流改动」。
 * 所以指纹算的是**存档原文**，在合并偏好之前。
 *
 * ## 为什么放这个文件
 *
 * 它要 `node:crypto`，而 `run.ts` / `specs.ts` / `snapshot.ts` 是**画布与宿主半共用**的
 * （画布引 `run.ts`，引了 `node:crypto` 就打不出来）。所以指纹另起一个只给宿主半用的文件，
 * 与 `pause-store.ts` / `run-file.ts` 同一个拆法。
 */
import { createHash } from 'node:crypto'
import type { WorkflowDoc } from './specs.ts'

/** 一个节点参与指纹的字段（顺序即写进规范化 JSON 的顺序，改了会让旧指纹全部失效）。 */
const NODE_FIELDS = ['id', 'defId', 'params', 'onError', 'skipped', 'parentId'] as const

/** 一条边参与指纹的字段。 */
const EDGE_FIELDS = ['source', 'target', 'sourceHandle', 'targetHandle'] as const

/** 把值规范化成**键序稳定**的形状（对象按字母序，数组保持原序）。 */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    /* 数字/字符串/布尔照原样；`undefined` 归一成 null（JSON 里它不存在，
     * 但两个存档一个是「没这个键」一个是「值为 undefined」，执行上等价）。 */
    return value === undefined ? null : value
  }
  if (Array.isArray(value)) return value.map(canonical)
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src).sort()) out[k] = canonical(src[k])
  return out
}

/** 从一份列表里只取指定字段（缺的补 null，保证形状稳定）。 */
function pick(item: unknown, fields: readonly string[]): Record<string, unknown> {
  const src = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const f of fields) out[f] = canonical(src[f])
  return out
}

/**
 * 算一份工作流存档的执行指纹。
 *
 * 同一份存档一定得到同一个值（键序稳定、无时间戳、无随机数）；
 * 任何会改变执行结果的字段变了，值就变。
 *
 * @param doc - 存档（`loadWorkflowByRef` 读回来的那一份，或画布传上来的）。
 * @returns 16 个十六进制字符的短指纹。
 */
export function docFingerprint(doc: unknown): string {
  const d = doc !== null && typeof doc === 'object' ? doc as WorkflowDoc & Record<string, unknown> : {}
  const nodes = Array.isArray(d.nodes) ? d.nodes : []
  const edges = Array.isArray(d.edges) ? d.edges : []
  /* 数组顺序也算在内：节点顺序与边顺序在存档里是稳定的（画布按加入顺序写），
   * 而「顺序变了」本身可能意味着重新搭过一遍，宁可多判一次改动。 */
  const shape = {
    nodes: nodes.map(n => pick(n, NODE_FIELDS)),
    edges: edges.map(e => pick(e, EDGE_FIELDS)),
  }
  const text = JSON.stringify(shape)
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 恢复之前核一次：存档还是不是当初挂起时那一份。
 *
 * ## 三档结论，第三档是重点
 *
 * | 情况 | 结论 | 为什么 |
 * | --- | --- | --- |
 * | 指纹一致 | 可以恢复 | — |
 * | 指纹不一致 | **拒绝** | 按旧现场跑出来的东西与当前工作流不是一回事，而界面会显示成功 |
 * | 现场里没有指纹（老现场） | **当它一致**，但要说出来 | 拒绝一个本来能恢复的现场，用户会失去一次已跑一半的工作 |
 *
 * 第三档是 lead 判的（票 17）：磁盘上已有的现场都是加这个字段之前存的，
 * 一律拒绝等于把所有人的等待中运行全部作废。
 *
 * @param saved - 现场里存的指纹（老现场是 `undefined`）。
 * @param doc - 现在磁盘上的那份存档。
 * @returns `ok: true` 放行；`ok: false` 带一句给人看的原因。
 */
export function checkResumeFingerprint(
  saved: string | undefined,
  doc: unknown,
): { ok: true, legacy: boolean } | { ok: false, reason: string } {
  /* 老现场：没有指纹可比。放行，但调用方据此记一笔日志（`legacy`）。 */
  if (saved === undefined || saved === '') return { ok: true, legacy: true }
  if (docFingerprint(doc) === saved) return { ok: true, legacy: false }
  return {
    ok: false,
    reason: '工作流已改动，此前存的现场不再适用：'
      + '节点的参数、连线或节点类型在这次挂起之后变过，按旧现场继续跑出来的结果'
      + '与当前工作流不是一回事。请重新运行一次；'
      + '若刚才是误改，把工作流恢复成挂起时的样子后可以再点继续。',
  }
}
