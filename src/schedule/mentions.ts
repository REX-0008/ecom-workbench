/** `@[名字](节点id)` 提及解析（契约 T1，2026-10-26）。
 *
 * ## 它解决什么
 *
 * 画布上写了「按 @[主图](n3) 的风格再画一张」时，那句话里带的是一个**引用**，
 * 不是普通文字。要把它变成模型能懂的东西：
 *
 * | 被引用的节点 | 变成什么 |
 * |---|---|
 * | 文本节点 | **正文直接插进提示词**（「按 一只白猫坐在窗台 的风格…」） |
 * | 图片节点 | 产物 id 放进 `refs`，原文换成 `[图: 名字]`（**图不能变成文字**） |
 * | 找不到 | 原文**原样保留**，并把那个 id 记进 `missing` |
 *
 * ## 为什么是纯函数、单独一个文件
 *
 * 它是这次唯一一段「有真算法」的东西（正则、替换、去重、顺序）。放在
 * 宿主的 `generate.ts`（快 800 行）里既不好找也不好测。单独一个文件、零依赖，
 * **能被单独 import 断言**，不依赖宿主运行时、不依赖 DOM。
 *
 * ## 三条不能含糊的规矩
 *
 * 1. **找不到的节点原样保留**（不是删掉）。静默删掉等于吞掉用户输入 ——
 *    用户写了 `@[主图](n3)`，成品里那一段字凭空消失，而提示词的意思已经变了。
 * 2. **图片不能塞进提示词**。产物 id 塞进去只会让模型读到一个乱码串；
 *    要作为参考图单独传（`refs`），原文位置留一个 `[图: 名字]` 说明这里有个图。
 * 3. **顺序稳定**。同一个节点被提及两次只进一次 `refs`（去重），但位置按
 *    **第一次出现**排 —— 参考图的顺序会影响结果，不能靠对象键序碰运气。
 *
 * ## 一个已经定下的判断：名字为空**不算畸形**
 *
 * `@[](n2)` 这种写法**认可**（不是漏了校验）。理由是：**名字只是给人看的标签，
 * id 才是用来定位的东西**。名字空着、id 指得着，就按那个节点处理；显示时
 * 退回节点自己的 `name`（也没有就给空串）。
 *
 * 反过来做（把空名字判成畸形、原样保留）的代价是：界面上用户手删掉名字后
 * 那条提及突然"失效"，但原文还在提示词里 —— 比认不出来更难懂。
 *
 * 真正判成畸形的是**语法**有问题的那些：缺右括号、id 里带空格、名字里带换行。
 * 那几种原样保留，因为它们确实无法确定指向谁。
 */

/** 一个可被提及的节点（调用方从画布存档里取）。 */
export interface MentionTarget {
  /**
   * 节点是什么。
   *
   * · `text` —— 有正文（`text`），插进提示词
   * · `image` / `video` / `audio` —— 有产物 id（`artifact`），进 `refs`
   * · `config` 等其他 —— 没有可插的内容，按「找不到」处理（原样保留）
   */
  kind: 'text' | 'image' | 'video' | 'audio' | 'config' | 'other'
  /** 显示名（`@[这个名字](id)` 里的那个名字）。 */
  name?: string
  /** 文本节点的正文。 */
  text?: string
  /** 图片 / 视频 / 音频节点引用的产物 id。 */
  artifact?: string
}

/** 查节点的方式（调用方给一个函数，本文件不认识画布存档的形状）。 */
export type MentionLookup = (nodeId: string) => MentionTarget | undefined

/** 一次解析的结果。 */
export interface MentionResult {
  /** 替换后的提示词。 */
  prompt: string
  /** 被引用到的产物 id（**按第一次出现的顺序**，已去重）。 */
  refs: string[]
  /** 找不到的节点 id（**按出现顺序**，已去重）。 */
  missing: string[]
  /** 被引用到的文本节点（反查用：谁的话被拼进去了）。 */
  textNodes: string[]
}

/**
 * 提及的语法：`@[名字](节点id)`。
 *
 * ## 为什么名字允许嵌套方括号
 *
 * 节点名可能里带方括号（用户随手起的名字，如 `@[主图[新版]](n3)`）。
 * 用 `[^\]]*` 会在第一个 `]` 就断掉，于是整条提及认不出来、原文留着 ——
 * 用户看到的是「我 @ 了但它没生效」。
 *
 * 所以名字部分用**平衡计数**（见 `findMentionAt`），正则只负责找到开头。
 * `id` 部分限制成安全字符集（与画布节点 id 一致：字母数字与 `._-`）。
 */
const MENTION_HEAD = /@\[/g
/** 节点 id 的合法字符（与 `canvases.ts` 的 `isCanvasId` 同一套，但节点 id 允许更长）。 */
const NODE_ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 从 `start`（指向 `@[` 的 `@`）开始，尝试认出一条完整的提及。
 *
 * @param s - 原串。
 * @param start - `@` 的下标。
 * @returns 认出来给各段下标与内容；认不出给 `null`（**原文原样保留**）。
 */
function findMentionAt(s: string, start: number): { end: number, name: string, id: string } | null {
  /* `@[` 后面必须还有内容。 */
  if (s[start] !== '@' || s[start + 1] !== '[') return null
  let i = start + 2
  let depth = 1
  let name = ''
  /* ① 名字：平衡方括号。 */
  while (i < s.length) {
    const ch = s[i]
    if (ch === '[') { depth += 1; name += ch; i += 1; continue }
    if (ch === ']') {
      depth -= 1
      if (depth === 0) break
      name += ch
      i += 1
      continue
    }
    /* 名字里出现换行 → 这不是一条提及（一条提及不该跨行）。 */
    if (ch === '\n') return null
    name += ch
    i += 1
  }
  if (depth !== 0) return null
  /* 现在 `s[i] === ']'`，紧后面必须是 `(`。 */
  if (s[i] !== ']' || s[i + 1] !== '(') return null
  i += 2
  const idStart = i
  while (i < s.length && s[i] !== ')') {
    /* id 里出现空白或换行 → 不是提及。 */
    if (/\s/.test(s[i])) return null
    i += 1
  }
  if (s[i] !== ')') return null
  const id = s.slice(idStart, i)
  if (!NODE_ID_OK.test(id)) return null
  return { end: i + 1, name, id }
}

/**
 * 解析提示词里的 `@[名字](节点id)`。
 *
 * @param prompt - 原提示词。
 * @param lookup - 查节点（给 id，返回节点；查不到返回 `undefined`）。
 * @returns 替换后的提示词、引用到的产物 id、找不到的节点 id。
 */
export function resolveMentions(prompt: string, lookup: MentionLookup): MentionResult {
  const src = typeof prompt === 'string' ? prompt : ''
  const refs: string[] = []
  const missing: string[] = []
  const textNodes: string[] = []
  let out = ''
  let i = 0

  while (i < src.length) {
    /* 找下一个 `@[`。找不到就把剩下的整段收下、结束。 */
    MENTION_HEAD.lastIndex = i
    const head = MENTION_HEAD.exec(src)
    if (head === null) { out += src.slice(i); break }
    const at = head.index
    out += src.slice(i, at)

    const found = findMentionAt(src, at)
    if (found === null) {
      /* 畸形语法：原样保留那个 `@[`，从它后面继续找
       * （不整段吃下去 —— 后面可能还有一条合法的提及）。 */
      out += '@['
      i = at + 2
      continue
    }

    const target = lookup(found.id)
    /* ① 找不到 / 不是能引用的类型 → **原样保留**，并记下 missing。 */
    if (target === undefined || target.kind === 'config' || target.kind === 'other') {
      out += src.slice(at, found.end)
      if (!missing.includes(found.id)) missing.push(found.id)
      i = found.end
      continue
    }

    /* ② 文本节点 → 正文插进来。
     * ⚠️ 只插正文、**不带**任何标记：文本节点的意思就是「用这段话」，
     * 多包一层 `[文: …]` 会污染提示词语义。 */
    if (target.kind === 'text') {
      out += typeof target.text === 'string' ? target.text : ''
      if (!textNodes.includes(found.id)) textNodes.push(found.id)
      i = found.end
      continue
    }

    /* ③ 图 / 视频 / 音频 → 产物 id 进 refs，原文换成 `[图: 名字]`。
     * 没有产物 id（空节点）时按「找不到」处理：它引不出任何东西。 */
    const artifact = typeof target.artifact === 'string' ? target.artifact : ''
    if (artifact === '') {
      out += src.slice(at, found.end)
      if (!missing.includes(found.id)) missing.push(found.id)
      i = found.end
      continue
    }
    /* 名字为空时退回节点自己的 `name`（文件头那条判断：名字是标签、id 才是定位）。 */
    const label = found.name !== '' ? found.name : (target.name ?? '')
    out += '[图: ' + label + ']'
    if (!refs.includes(artifact)) refs.push(artifact)
    i = found.end
  }

  return { prompt: out, refs, missing, textNodes }
}

/**
 * 提示词里有哪些提及（**只解析、不替换**，界面做高亮用）。
 *
 * @param prompt - 提示词。
 * @returns 每条提及的名字与节点 id（按出现顺序；畸形的不算）。
 */
export function listMentions(prompt: string): { name: string, id: string }[] {
  const src = typeof prompt === 'string' ? prompt : ''
  const out: { name: string, id: string }[] = []
  let i = 0
  while (i < src.length) {
    MENTION_HEAD.lastIndex = i
    const head = MENTION_HEAD.exec(src)
    if (head === null) break
    const found = findMentionAt(src, head.index)
    if (found === null) { i = head.index + 2; continue }
    out.push({ name: found.name, id: found.id })
    i = found.end
  }
  return out
}
