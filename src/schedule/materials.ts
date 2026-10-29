/** 素材库（宿主半，契约 BA，2026-10-25）。
 *
 * # 核心：**读目录，不建索引**
 *
 * 素材库就是一个平铺目录（`data/ecom-workbench/materials/`）。
 * 放进目录就算有，删掉就消失，不另存任何清单文件。
 *
 * 为什么不做索引：计划 §三 4.2 定了「素材库 = 一个目录」。做索引就要维护两处一致
 * —— 用户手工往目录里丢一张图，索引里没有，界面就看不到；那是最烦人的一种错。
 * 代价写在计划 §4.3 里：**目录被手工清空时素材会立刻全消失，没有回收站**。
 *
 * ## 与 `artifacts/` 是两个不互相搬的池子
 *
 * 产物是「我们生成出来的」，素材是「外面找来的参考图」。产物要当素材用，
 * 是**复制一份进 `materials/`**，不是引用（计划 §附 四个纪律第 3 条）。
 *
 * ## ⚠️ 上传走 base64 + JSON，代价是**大于 6 MB 的文件传不了**
 *
 * 不做 multipart 的理由（`src/index.ts` 那条路由旁的注释已写）：
 * 这一侧的请求体读取只有 `readJsonBody` 一条路，上限 8 MB；base64 编码会膨胀约 1/3，
 * 所以实际能传的文件上限约 6 MB。素材是参考图级别，够用。
 *
 * **这个代价明确记在这里，别当成 bug**：要传更大的文件，得先给 `readJsonBody`
 * 加流式处理或另写一条 multipart 路由 —— 那是另一件事。
 *
 * # 文本素材（票 34，2026-10-28）
 *
 * 素材现在分三类：图片、视频、文本。前两类是**二进制文件**，文本是**一条素材一个文件**
 * 的结构化记录（`<id>.text.json`，里面是标题 + 正文）。
 *
 * ## 为什么仍然是「不建索引」
 *
 * 文本素材**没有**一份总清单。每个 `.text.json` 就是那一条素材本身：
 * 删掉这个文件，那条素材就没了，和删掉一张图完全一样。
 *
 * 换个说法：目录里放的是「素材」，不是「素材的名字」。索引文件（一份 JSON 里装着
 * 所有条目的清单）会让「手工丢进去的看不到」那个老毛病回来，所以那样做不行。
 *
 * ## 为什么用 `.text.json` 这个后缀，而不是丢进子目录
 *
 * - 子目录会破坏「平铺目录」这条：改名、删、取字节三条路都要多一层路径处理，
 *   而 `isMaterialSafe` 本来就靠「不许出现 `/`」当安全边界，开一个口子不划算；
 * - 后缀必须能一眼认出来，且**不能和普通 `.json` 混** —— 目录里的 `data.json`
 *   那种东西仍然要被忽略（“不是素材”），只有 `.text.json` 才算。
 *
 * ## 代价（明写出来）
 *
 * 1. **列一次要把每个文本素材读出来解析**。图片视频只看 `stat`，文本要看内容 ——
 *    几百条文本素材时列表会比现在慢一点。正文上限卡在 64 KB（见 `saveTextMaterial`），
 *    所以总量可控。
 * 2. **文件坏了那条素材要显式说出来**。解析失败时列表仍然列出它、并带一句
 *    「内容读不出来」，而不是静默跳过 —— 静默跳过正是「目录里有但看不见」那个
 *    老毛病的另一个版本。
 */
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { materialsDir, mimeOf } from './artifacts.ts'

/** 素材的类型（票 34 加 `text`；前两类是老的两类，判定规则一个字节没改）。 */
export type MaterialKind = 'image' | 'video' | 'text'

/** 素材库里列出来的东西。 */
export interface Material {
  /** 文件名（含扩展名）。 */
  name: string
  /** 字节数。 */
  bytes: number
  /** 修改时间（ms）。 */
  mtime: number
  /** 显示用地址（走 `GET /api/ecom-workbench/material/<name>`）。 */
  url: string
  /** 类型。界面按它分三组（票 34）。 */
  kind: MaterialKind
  /** 文本素材的标题（只有 `kind === 'text'` 才有这个键）。 */
  title?: string
  /** 文本素材的正文（只有 `kind === 'text'` 才有这个键）。 */
  content?: string
  /** 文本素材的字符数（正文长度；只有 `kind === 'text'`）。 */
  chars?: number
  /** 这条素材有问题时的一句话（例如 `.text.json` 解析失败）。 */
  problem?: string
}

/** 认哪些扩展名（计划 §6.2 第一条：第一版只认图片与视频，其余忽略）。 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'])

/** 文本素材的文件名后缀（见文件头「为什么用这个后缀」）。 */
export const TEXT_MATERIAL_SUFFIX = '.text.json'

/** 正文上限（字符）。 */
export const TEXT_MATERIAL_MAX_CHARS = 64 * 1024
/** 标题上限（字符）。 */
export const TEXT_MATERIAL_MAX_TITLE = 200

/** 从文件名取扩展名（小写，不带点）。 */
function extOf(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
}

/**
 * 这个文件名是不是素材库认的类型。
 *
 * ⚠️ **不含文本素材** —— 文本走 `isTextMaterialName`。这条函数的判据
 * 被老测试钉着（`isMaterialName('c.txt')` 必须是 false），
 * 而文本素材是 `.text.json`，两条判据各管一类，不混。
 *
 * @param name - 文件名。
 * @returns 认就 true。
 */
export function isMaterialName(name: string): boolean {
  const ext = extOf(name)
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)
}

/**
 * 这个文件名是不是文本素材。
 * @param name - 文件名。
 * @returns 是就 true。
 */
export function isTextMaterialName(name: string): boolean {
  return name.endsWith(TEXT_MATERIAL_SUFFIX)
}

/**
 * 由文件名判类型（`kind` 字段的来源）。
 * @param name - 文件名。
 * @returns 类型；两类都不认给 `null`。
 */
export function kindOfName(name: string): MaterialKind | null {
  if (isTextMaterialName(name)) return 'text'
  const ext = extOf(name)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return null
}

/**
 * 文件名合不合法。
 *
 * ⚠️ **这是安全边界**：名字来自 URL，不清洗的话 `../../browser-prefs.json`
 * 能读到目录外面去。规则：只许字母数字与 `. _ -`，且**不许出现 `..`**、
 * 不许以点开头（`/\.\./` 与隐藏文件都挡掉）。
 *
 * @param name - 待查名字。
 * @returns 合法为 true。
 */
export function isMaterialSafe(name: string): boolean {
  if (name === '' || name.length > 200) return false
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false
  if (name.includes('..')) return false
  if (name.startsWith('.')) return false
  return true
}

/**
 * 列素材（按修改时间倒序，新的在前）。
 *
 * 目录不存在给空数组 —— 新装的工作台就是这个状态，那不是错误。
 * @returns 素材数组。
 */
export async function listMaterials(): Promise<Material[]> {
  const dir = materialsDir()
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const out: Material[] = []
  for (const name of names) {
    const kind = kindOfName(name)
    /* 认不出类型的（`note.txt`、普通 `data.json`）一律忽略 —— 目录里本来就可能
     * 有别的东西，那不是错误，也不该出现在素材列表里。 */
    if (!isMaterialSafe(name) || kind === null) continue
    const s = await stat(join(dir, name)).catch(() => null)
    if (s === null || !s.isFile()) continue
    const base: Material = {
      name, bytes: s.size, mtime: s.mtimeMs,
      url: '/api/ecom-workbench/material/' + encodeURIComponent(name),
      kind,
    }
    if (kind !== 'text') { out.push(base); continue }
    /* 文本素材要把内容读出来（见文件头「代价」第 1 条）。 */
    const rec = await readTextRecord(join(dir, name))
    if (rec === null) {
      /* ⚠️ **不许静默跳过**：文件在、内容坏了，要显式说出来。
       * 静默跳过就是「目录里有但看不见」那个老毛病换了个壳。 */
      out.push({ ...base, title: name, content: '', chars: 0, problem: '内容读不出来（文件可能坏了）' })
      continue
    }
    out.push({
      ...base,
      title: rec.title,
      content: rec.content,
      chars: rec.content.length,
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** 落盘的一条文本素材。 */
interface TextRecord {
  /** 标题。 */
  title: string
  /** 正文。 */
  content: string
}

/**
 * 读一条文本素材的记录文件。
 *
 * @param file - 完整路径。
 * @returns 记录；读不出 / 不是合法形状给 `null`（调用方负责把它说出来）。
 */
async function readTextRecord(file: string): Promise<TextRecord | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { title?: unknown, content?: unknown }
    const title = typeof raw.title === 'string' ? raw.title : ''
    const content = typeof raw.content === 'string' ? raw.content : ''
    /* 两个都不是字符串的文件按「读不出来」处理 —— 宁可说坏了，也不要
     * 显示一条空标题空正文的素材让人以为内容丢了。 */
    if (typeof raw.title !== 'string' && typeof raw.content !== 'string') return null
    return { title, content }
  } catch { return null }
}

/**
 * 存一个素材（base64 → 文件）。
 *
 * @param name - 文件名（必须带扩展名，且是认的类型）。
 * @param base64 - base64 文本。
 * @returns 落定后的素材信息。
 * @throws 名字不合法 / 类型不认 / 内容不是合法 base64 时抛错。
 */
export async function saveMaterial(name: string, base64: string): Promise<Material> {
  if (!isMaterialSafe(name)) throw new Error('文件名不合法（只许字母、数字与 . _ - ，且不许含 ..）：' + name)
  /* ⚠️ 文本素材**不走这条路**：它的内容是标题 + 正文（结构化），不是 base64 字节。
   * 混进来的话会写出一个后缀是 `.text.json`、内容却是 PNG 字节的文件 ——
   * 那种东西列表里读不出来，只会显示「内容读不出来」。 */
  if (isTextMaterialName(name)) {
    throw new Error('文本素材请走存文本的那条路（标题 + 正文，不是 base64）：' + name)
  }
  if (!isMaterialName(name)) throw new Error('只收图片与视频文件：' + name)
  if (typeof base64 !== 'string' || base64 === '') throw new Error('没有给文件内容（base64）')
  const data = Buffer.from(base64, 'base64')
  /* 空 Buffer 说明那串 base64 是坏的（解码失败不会抛错，会得到空或垃圾）。
   * 静默写一个 0 字节文件最难查：界面显示「有一张图」但打不开。 */
  if (data.length === 0) throw new Error('内容不是合法的 base64（解出来是空的）')
  const dir = materialsDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, data)
  const s = await stat(file)
  const kind = kindOfName(name)
  return {
    name, bytes: s.size, mtime: s.mtimeMs,
    url: '/api/ecom-workbench/material/' + encodeURIComponent(name),
    kind: kind === null ? 'image' : kind,
  }
}

/**
 * 存一条文本素材（标题 + 正文 → 一个 `.text.json`）。
 *
 * ## 为什么单独一条路，而不是给 `saveMaterial` 加参数
 *
 * 两者的**输入根本不是一回事**：一个是 base64 字节，一个是两段文本。
 * 硬塞进一个函数，签名里就要出现「这两组参数互斥」这种没法用类型表达的东西，
 * 而错误分支会翻倍。分开之后每条路的校验各管自己。
 *
 * ## 文件名怎么来
 *
 * 调用方可以给 `name`（要带 `.text.json` 后缀，会被校验）；不给就按时间戳造一个。
 * 造出来的名字**不含标题**：标题里有空格、引号、中文标点，塞进文件名要么被
 * `isMaterialSafe` 挡掉，要么就要放宽那条安全边界 —— 不值得。标题存在文件**内容**里。
 *
 * @param input - `{ title, content, name? }`。
 * @returns 落定后的素材信息。
 * @throws 标题或正文缺 / 超长 / 名字不合法时抛错。
 */
export async function saveTextMaterial(input: {
  /** 标题（可以空，落盘时回落成「未命名文本」）。 */
  title?: unknown
  /** 正文。 */
  content?: unknown
  /** 文件名（可选，要带 `.text.json`）。 */
  name?: unknown
}): Promise<Material> {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.trim() === '') throw new Error('正文是空的（文本素材要有一段正文）')
  if (content.length > TEXT_MATERIAL_MAX_CHARS) {
    throw new Error('正文太长（上限 ' + String(TEXT_MATERIAL_MAX_CHARS) + ' 字符，这次 '
      + String(content.length) + '）')
  }
  if (title.length > TEXT_MATERIAL_MAX_TITLE) {
    throw new Error('标题太长（上限 ' + String(TEXT_MATERIAL_MAX_TITLE) + ' 字符，这次 '
      + String(title.length) + '）')
  }
  /* 名字由调用方给时按素材名规则校验（同一条安全边界，不另开）。 */
  const given = typeof input.name === 'string' ? input.name.trim() : ''
  let name: string
  if (given !== '') {
    if (!isMaterialSafe(given)) throw new Error('文件名不合法（只许字母、数字与 . _ - ，且不许含 ..）：' + given)
    if (!isTextMaterialName(given)) throw new Error('文本素材的文件名要以 ' + TEXT_MATERIAL_SUFFIX + ' 结尾：' + given)
    name = given
  } else {
    name = 'text-' + String(Date.now()) + TEXT_MATERIAL_SUFFIX
  }

  const record: TextRecord = { title: title === '' ? '未命名文本' : title, content }
  const dir = materialsDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  /* 缩进 2 空格：这几个文件是**给人也能看懂**的（用户可能手工打开看一眼），
   * 而它一条一文件，体积不是问题。 */
  await writeFile(file, JSON.stringify(record, null, 2), 'utf8')
  const s = await stat(file)
  return {
    name, bytes: s.size, mtime: s.mtimeMs,
    url: '/api/ecom-workbench/material/' + encodeURIComponent(name),
    kind: 'text',
    title: record.title,
    content: record.content,
    chars: content.length,
  }
}

/**
 * 读一个素材的字节（`GET /material/<name>` 用）。
 *
 * @param name - 文件名。
 * @returns 字节与 mime；名字非法或文件不存在给 `null`。
 */
export async function loadMaterial(name: string): Promise<{ data: Buffer, mime: string } | null> {
  if (!isMaterialSafe(name)) return null
  try {
    const data = await readFile(join(materialsDir(), name))
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
    return { data, mime: mimeOf(ext) }
  } catch { return null }
}

/**
 * 删一个素材。
 *
 * @param name - 文件名。
 * @returns 删掉了就 true（本来就没有给 false，调用方据此回 404）。
 */
export async function deleteMaterial(name: string): Promise<boolean> {
  if (!isMaterialSafe(name)) return false
  const file = join(materialsDir(), name)
  const s = await stat(file).catch(() => null)
  if (s === null || !s.isFile()) return false
  await unlink(file)
  return true
}
