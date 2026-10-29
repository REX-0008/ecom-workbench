/** 产物被谁引用（宿主半，契约 BA，2026-10-25）。
 *
 * ## 为什么不建索引文件
 *
 * 计划 §三 4.1 已定：**每次现扫** `canvases/*.json`。
 * 理由是画布数量是几十级，扫描够快（几十个小 JSON）；而建索引就要维护两处一致 ——
 * 「索引说有 3 处引用、实际 2 处」这种分歧是本项目反复踩过的坑
 * （同一个事实两个来源，迟早漂）。所以宁可每次多读几个文件。
 *
 * ## 认哪几种引用位置（**只认这几种，其余不计数**）
 *
 * 实际查了界面那侧的形状（`src/client/workbench/content-canvas-store.ts:30-45`
 * 的 `ContentNodeData`、`content-nodes.tsx:71-73` 的 `artifactUrl`），画布 JSON 里
 * 一个产物 id 可能出现的地方有三种：
 *
 * | 位置 | 例子 | 说明 |
 * |---|---|---|
 * | `data.artifact` | `{"data":{"artifact":"20261025-…-ab12"}}` | **界面现在真正用的**那种 |
 * | `data.artifactId` | `{"data":{"artifactId":"20261025-…-ab12"}}` | 另一种命名，兼容 |
 * | 任意字符串里的二进制路由 | `"/api/ecom-workbench/artifact/<id>"` | 有人直接把网址存进 `src` |
 *
 * ⚠️ **不认**的：`settings.refImages` 这类「设置里的参考图数组」。
 * 理由：内容画布的节点数据里**现在没有这个字段**（`ContentNodeData` 全文只有
 * `text` / `artifact` / `genType` / `model` / `size` / `count` / `workflow`）。
 * 为一个还不存在的形状写识别，等于凭空猜一个格式 —— 等生成配置真加了参考图，
 * 在这里补一个字段并补一条断言，才算数。
 *
 * ⚠️ 还有一种**不**算引用：`gen-logs/` 里那些记录的 `artifacts[]`。
 * 那是「谁生成了它」的溯源，不是「谁在用它的图」。删产物时生成记录不该拦着
 * （拦了就永远删不掉：任何一张图都有自己的出生记录）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canvasesDir, artifactsDir } from './artifacts.ts'

/** 一处引用。 */
export interface ArtifactRef {
  /** 哪个画布。 */
  canvasId: string
  /** 那个画布叫什么（界面悬浮时显示）。 */
  canvasTitle: string
  /** 哪个节点。 */
  nodeId: string
}

/** 二进制路由的前缀（`content-nodes.tsx:71-73` 拼出来的就是它）。 */
const ARTIFACT_URL_MARK = '/api/ecom-workbench/artifact/'

/**
 * 从一个任意字符串里抽产物 id。
 *
 * 只认「`…/artifact/<id>`」这一段，后面不许再带斜杠（那就是路径而不是 id 了）。
 * @param text - 待查字符串。
 * @returns 产物 id；不是这条路由给空串。
 */
function idFromUrl(text: string): string {
  const i = text.indexOf(ARTIFACT_URL_MARK)
  if (i < 0) return ''
  const rest = text.slice(i + ARTIFACT_URL_MARK.length)
  const end = rest.search(/[/?#\s"']/)
  const id = (end < 0 ? rest : rest.slice(0, end)).trim()
  return id
}

/**
 * 深挖一份画布的所有节点，收集引用。
 *
 * 为什么递归而不是只看 `data` 顶层两层：节点的形状会变（生成配置节点以后可能
 * 挂参考图数组），绑死层级的代码下次改形状就**静默不漏不错**——最糟的一种错。
 *
 * @param value - 任意值。
 * @param nodeId - 当前节点 id（递归时带着）。
 * @param hit - 命中回调。
 */
function walk(value: unknown, nodeId: string, hit: (artifactId: string, nodeId: string) => void): void {
  if (typeof value === 'string') {
    const id = idFromUrl(value)
    if (id !== '') hit(id, nodeId)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, nodeId, hit)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const rec = value as Record<string, unknown>
  for (const [key, child] of Object.entries(rec)) {
    /* 这两个键**就是**产物 id 本身（键名即语义），不走网址解析。 */
    if ((key === 'artifact' || key === 'artifactId') && typeof child === 'string' && child !== '') {
      hit(child.trim(), nodeId)
      continue
    }
    walk(child, nodeId, hit)
  }
}

/**
 * 扫一遍所有画布，算出每个产物被谁引用。
 *
 * ## 只返回**仍然存在**的产物
 *
 * 画布上删了节点不会删产物，反过来**产物删了画布上的引用还在**（节点的
 * `data.artifact` 仍指着那个 id —— 界面据此显示「图已删除」）。
 *
 * 所以画布扫描会扫出一些「已经不存在」的 id。把它们一起返回会让界面说
 * 「被 3 个画布引用，删了会显示图已删除」—— 而那张图早就没了。
 * 因此这里**先按 `artifacts/` 现有文件过滤**，只留还活着的。
 *
 * 代价：每次多一次 `readdir`（几十到几百个文件名）。比读所有画布小得多。
 *
 * @returns `{ 产物 id: [{ canvasId, canvasTitle, nodeId }] }`。
 *   没有任何画布 / 目录不存在 → 空对象（不报错：新装的工作台就是这个状态）。
 */
export async function artifactUsage(): Promise<Record<string, ArtifactRef[]>> {
  const dir = canvasesDir()
  let names: string[]
  try { names = await readdir(dir) } catch { return {} }
  /* 现存产物 id 的集合：`<id>.json` 是元数据、`<id>.<ext>` 是本体，
   * 两种都去掉最后一段扩展名，得到 id。 */
  const alive = new Set<string>()
  let artNames: string[]
  try { artNames = await readdir(artifactsDir()) } catch { artNames = [] }
  for (const n of artNames) {
    const i = n.lastIndexOf('.')
    if (i > 0) alive.add(n.slice(0, i))
  }

  const out: Record<string, ArtifactRef[]> = {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>
    } catch { continue /* 坏画布跳过：一份坏文件不该让整张引用表空掉 */ }
    const canvasId = typeof doc.id === 'string' && doc.id !== '' ? doc.id : name.slice(0, -'.json'.length)
    const canvasTitle = typeof doc.title === 'string' && doc.title !== '' ? doc.title : canvasId
    const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue
      const nodeId = typeof (node as Record<string, unknown>).id === 'string'
        ? String((node as Record<string, unknown>).id) : ''
      const hit = (artifactId: string, nid: string): void => {
        /* 已经不存在的产物不列（见上面那段说明）。 */
        if (!alive.has(artifactId)) return
        /* 同一个节点里同一产物只记一次：一个节点既存 id 又存网址时不该算两处。 */
        const list = out[artifactId] ?? (out[artifactId] = [])
        if (list.some(r => r.canvasId === canvasId && r.nodeId === nid)) return
        list.push({ canvasId, canvasTitle, nodeId: nid })
      }
      walk(node, nodeId, hit)
    }
  }
  return out
}

/**
 * 某个产物被引用几处（删之前弹提醒用）。
 *
 * @param artifactId - 产物 id。
 * @returns 引用数组（没被引用给空数组）。
 */
export async function usageOf(artifactId: string): Promise<ArtifactRef[]> {
  return (await artifactUsage())[artifactId] ?? []
}
