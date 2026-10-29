/** 五类默认模型（2026-10-29 票 67 把四类扩成五类）。
 *
 * # 为什么从「四类」变成「五类」
 *
 * 用户原话（2026-10-29）：「再根据已选择、增加的模型给他们一个类型选项
 * （文本，文生图，图生图，文生视频，音频），有选择功能的才放进默认模型设置的名单中。」
 *
 * 原来只有 `image` 一格，而「文生图」与「图生图」其实是两件事：
 * 一条只会文生图的模型在需要参考图的那条路上必然失败。
 *
 * # 老文件兼容（唯一一处兼容逻辑）
 *
 * 盘上可能存着 `defaultImageModel`（那一条同时管文生图与图生图）。
 * 读的时候把它**读成两条**（`t2i` 与 `i2i` 各一份），不丢。
 * 写的时候只写新五键 —— 老键不写回去。
 *
 * ⚠️ 这条兼容必须带断言（票面验收第 5 条），而且它**不能被顺手删掉**：
 * 删了之后，已经设过默认模型的用户升级完会看到「全都没设」，然后生成报错。
 *
 * ## 关于 `export`（写给下一个看这个文件的人）
 *
 * `asModelRef` / `normalizeDefaults` 这两个生产代码不直接调（只在本文件内部被
 * `readModelDefaults` / `saveModelDefaults` 用），`export` 只为单测洗数据的边界：
 * 半截的偏好怎么丢、坏键是不是只跳过这一条（而不是整份作废）、非对象输入怎么归一、
 * 老键 `defaultImageModel` 读成两条时新键优先还是老键优先。
 * 那是有意的，不是漏接线 —— 别因为「grep 不到跨文件调用方」就把它们收回去，
 * 删了会让这些断言只能靠端到端跑。
 *
 * ⚠️ `src/index.ts:123` 也有一个同名 `asModelRef`，那一个洗的是 `{ provider, model }`
 * （工作流节点的路由），与这里的 `{ channelId, modelId }` 不是同一件事 —— 两边都留着。
 *
 * # 与 `model-prefs.json` 不是一件事
 *
 * `model-prefs.json`（契约 H）管的是**工作流节点**用哪个大模型（`ai.agent` 那条路的
 * 五级回落）。这里管的是**内容生成**五类能力的默认模型。两者名字像但不是一个东西，
 * 故意分开存 —— 合并会让「改生成默认」把工作流的模型偏好也改掉。
 *
 * # 为什么单独一个文件、为什么不放进 `channels.json`
 *
 * 默认模型是**插件级偏好**，不是渠道的属性：它回答「我没有特别指定时用哪个」。
 * 塞进渠道表会有两个问题：一条渠道被删掉时那条偏好会跟着消失（用户其实只是换了渠道）；
 * `channels.json` 的语义是「可回给前端的渠道定义」，偏好混进去会让它变脏。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from './artifacts.ts'
import { MODEL_TYPES } from './model-types.ts'

/** 文件名（与 `channels.json` 同级）。 */
export const MODEL_DEFAULTS_FILE = 'model-defaults.json'

/**
 * 五类 → 那个键名。
 *
 * 键名沿用 `default<TYPE>Model` 的驼峰写法（`t2i` → `T2I`），
 * 这样它与老的 `defaultImageModel` 长得像，肉眼好认。
 */
export const DEFAULT_KEYS = {
  image: 'defaultImageModel',
  video: 'defaultVideoModel',
  audio: 'defaultAudioModel',
} as const

/**
 * 老键名 → 它代表哪几类。
 *
 * 现在是票 67 用过两天的 `defaultT2IModel` / `defaultI2IModel`：那时「图片」
 * 被拆成文生图与图生图两格。票 74 又收回「图片」一格，所以这两个键
 * **都归到 `image`**。
 *
 * ## ⚠️ 这一层只负责**读**
 *
 * 保存时只写 `DEFAULT_KEYS` 那四个键，老键**不写回去**（见 `saveModelDefaults`）。
 * 所以用户存过一次之后，磁盘上旧键自动消失、这一层也就不再触发。
 *
 * 但**读**这一条必须一直留着：磁盘上可能还有，也可能有人手改回去。
 */
export const LEGACY_KEYS: Record<string, string[]> = {
  defaultT2IModel: ['image'],
  defaultI2IModel: ['image'],
  /* 票 76（2026-10-29）：渠道里去掉「文本」这一类，所以这个键**映射到空** ——
   * 读的时候认得（不报错、不整份作废），但它不再喂给任何一类。
   * 保存时不写回去，所以存一次就消失。
   *
   * ⚠️ 空数组与「键不在表里」的差别：不在表里会被当成未知键**跳过**，
   * 而这里显式列出来是给读代码的人看的 —— 「这个键存在过，是被有意废弃的」。 */
  defaultTextModel: [],
}

/** 一类能力的默认模型指向。 */
export interface ModelRef {
  /** 渠道 id。 */
  channelId: string
  /** 模型 id。 */
  modelId: string
}

/** 三类默认模型（每类可以没有）。 */
export interface ModelDefaults {
  defaultImageModel?: ModelRef
  defaultVideoModel?: ModelRef
  defaultAudioModel?: ModelRef
}

/** 默认文件路径。 */
function defaultsFile(): string {
  return join(dataRoot(), MODEL_DEFAULTS_FILE)
}

/**
 * 把一个值收成 `ModelRef`（纯函数）。
 *
 * 只认「两个非空字符串」，其余一律当没给 —— 半条引用（只有渠道没有模型）
 * 比没有更糟：它会让人以为设过了。
 *
 * @param raw - 待收的值。
 * @returns 收好的引用；不成立给 `undefined`。
 */
export function asModelRef(raw: unknown): ModelRef | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as Record<string, unknown>
  const channelId = typeof rec.channelId === 'string' ? rec.channelId.trim() : ''
  const modelId = typeof rec.modelId === 'string' ? rec.modelId.trim() : ''
  if (channelId === '' || modelId === '') return undefined
  return { channelId, modelId }
}

/**
 * 把一份原始 JSON 收成 `ModelDefaults`（纯函数）。
 *
 * 坏键跳过而不是整份作废：一条写坏的偏好不该让另外几条也用不上。
 *
 * ## 规则一直是「当前形态的键优先，老键补空」
 *
 * ⚠️ **这条规则没变过，变的只是「哪一组算当前形态」。**
 *
 * | 时候 | 当前形态（`DEFAULT_KEYS`） | 老键（`LEGACY_KEYS`） |
 * |---|---|---|
 * | 票 67（五类） | `defaultT2IModel` / `defaultI2IModel` | `defaultImageModel` |
 * | 票 74（四类） | `defaultImageModel` | `defaultT2IModel` / `defaultI2IModel` |
 *
 * 所以别把这次的改动理解成「新键优先这个规则反过来了」—— 规则从来没动，
 * 只是换代的那一组换了。哪一组算当前形态**由 `DEFAULT_KEYS` 决定**，
 * `LEGACY_KEYS` 跟着改。
 *
 * 为什么当前形态优先：那是用户在当前界面上能设的东西，是他的**最新意图**。
 * 老键只补「当前形态没给的那几条」—— 反过来（老键盖新键）会让用户
 * 刚设完一保存又被打回上一次的形态。
 *
 * @param raw - 解析好的 JSON。
 * @returns 四类默认模型。
 */
export function normalizeDefaults(raw: unknown): ModelDefaults {
  if (typeof raw !== 'object' || raw === null) return {}
  const rec = raw as Record<string, unknown>
  const out: ModelDefaults = {}
  for (const type of MODEL_TYPES) {
    const key = DEFAULT_KEYS[type]
    const one = asModelRef(rec[key])
    if (one !== undefined) (out as Record<string, ModelRef>)[key] = one
  }
  /* 老键补空（唯一一处兼容逻辑）。 */
  for (const [legacyKey, types] of Object.entries(LEGACY_KEYS)) {
    const one = asModelRef(rec[legacyKey])
    if (one === undefined) continue
    for (const type of types) {
      const key = (DEFAULT_KEYS as Record<string, string>)[type]
      if (key === undefined) continue
      /* 新键已经有了就不动它。 */
      if ((out as Record<string, ModelRef | undefined>)[key] !== undefined) continue
      (out as Record<string, ModelRef>)[key] = { ...one }
    }
  }
  return out
}

/**
 * 读默认模型。
 *
 * 文件不存在 / 坏 JSON → 空对象（不是报错）：全新安装本来就没有这个文件，
 * 那不是故障，只是「还没设」。
 *
 * @returns 五类默认模型。
 */
export async function readModelDefaults(): Promise<ModelDefaults> {
  let text: string
  try {
    text = await readFile(defaultsFile(), 'utf8')
  } catch { return {} }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return {} }
  return normalizeDefaults(parsed)
}

/**
 * 写默认模型（整份覆盖）。
 *
 * `null` / 缺键 = 清掉那一类（回到「没设」）。
 *
 * ## ⚠️ 只写 `DEFAULT_KEYS` 那四个键，老键**一个都不写回去**
 *
 * 这条是兼容层的另一半，别以为「读的时候已经兼容了，写的时候顺手留着也不碍事」：
 * 留着的话磁盘上会永久同时存在两套键，以后**每次读**都要跑一遍「哪组优先」的判断，
 * 而且用户永远不知道那个老键是谁写进去的。
 *
 * 所以：用户存一次之后磁盘上只剩四键，老键自动消失，兼容那一支也不再触发 ——
 * **保存一次就自然迁到新形态**，不需要单独的迁移步骤。
 *
 * 但**读**那一侧的 `LEGACY_KEYS` 要一直留着：磁盘上可能还有，也可能有人手改回去。
 *
 * @param next - 要存的内容。
 * @returns 存好的内容。
 */
export async function saveModelDefaults(next: unknown): Promise<ModelDefaults> {
  const clean = normalizeDefaults(next)
  const dir = dataRoot()
  await mkdir(dir, { recursive: true })
  await writeFile(defaultsFile(), JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

/**
 * 取某一类的默认模型。
 *
 * 票 74 之后四类与 `generate.ts` 里的 `GenKind` **同名同数**
 * （`text` / `image` / `video` / `audio`），所以这里不需要任何映射 ——
 * 上一版那个「`image` 按文生图优先、没有就图生图」的回落已经删掉。
 *
 * @param defaults - 读好的偏好。
 * @param kind - 四类之一。
 * @returns 引用；没设为 `undefined`。
 */
export function defaultOf(defaults: ModelDefaults, kind: string): ModelRef | undefined {
  const key = (DEFAULT_KEYS as Record<string, string>)[kind]
  if (key === undefined) return undefined
  return (defaults as Record<string, ModelRef | undefined>)[key]
}

/**
 * 每一类**有没有**默认模型（界面显示「已设 / 未设」用）。
 *
 * @param defaults - 读好的偏好。
 * @returns 五类的布尔表。
 */
export function defaultStatus(defaults: ModelDefaults): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const type of MODEL_TYPES) out[type] = defaultOf(defaults, type) !== undefined
  return out
}
