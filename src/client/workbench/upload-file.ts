/** 素材上传的纯函数（契约 CG，2026-10-26）。
 *
 * ## 为什么从组件里抽出来
 *
 * 上一轮（BB）核查报告的缺口：ContentLibrary 的上传按钮**真实选文件那一下
 * 没被自动化走过** —— jsdom 造不出带文件的 `FileList`
 * （`DataTransfer` 没实现），所以只能验「源码里写了拦截」。
 *
 * 现在把关卡与编码拆成不依赖 DOM 的纯函数：输入是一个
 * `{ name, size, type, base64 }` 对象（**不是 `File`**），这样就能真跑断言。
 *
 * 组件那边只做一件事：把 `File` 用 `FileReader` 读成 base64，然后调 `prepareUpload`。
 * 界面行为一个字没改 —— 这是「抽函数 + 补测试」，不是重写。
 *
 * ## 校验顺序为什么是「类型 → 空 → 太大 → base64」
 *
 * 这个顺序是**用户看到的第一个错误最有用的那个**：
 * · 选了 `.txt` 先告诉他类型不对（比「太大」更可能是真原因）；
 * · 都通过了才去看 base64 有没有坏（那是技术要求，不是用户能修的事）。
 */

/** 上传体积上限（字节）。与 `src/schedule/materials.ts` 文件头那条代价对齐：
 * 宿主读请求体上限 8 MB，base64 涨约 1/3，所以原文件约 6 MB 封顶。 */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024

/** 认的图片扩展名（与 `src/schedule/materials.ts` 的 `IMAGE_EXT` 同一份清单）。 */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp']
/** 认的视频扩展名。 */
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']

/**
 * 字节写成给人看的一句。
 * @param n - 字节数。
 * @returns 如 `1.2 MB`。
 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return String(Math.round(n)) + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(2) + ' MB'
}

/**
 * 文件名里有没有危险成分。
 *
 * ⚠️ 客户端这一层只做**提示性**检查，真正挡穿越的是宿主
 * （`src/schedule/materials.ts` 的 `isMaterialSafe`）。但这里也要挡：
 * 让用户在上传前就看到「这个名字不能用」，而不是传上去才收到 400。
 *
 * @param name - 文件名。
 * @returns 不安全的原因；安全给空串。
 */
export function unsafeNameWhy(name: string): string {
  if (name === '') return '文件名是空的'
  if (name.length > 200) return '文件名太长（超过 200 字）'
  if (name.includes('..')) return '文件名里不能有「..」'
  if (/[\\/]/.test(name)) return '文件名里不能有路径分隔符'
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return '文件名只能用字母、数字与 . _ -（中文名请先改一下）'
  if (name.startsWith('.')) return '文件名不能以点开头'
  return ''
}

/** 一个待上传的文件（**不依赖 DOM**：测试直接造这个对象）。 */
export interface UploadCandidate {
  /** 文件名。 */
  name: string
  /** 字节数（原文件大小，不是 base64 长度）。 */
  size: number
  /** mime（`image/png` 之类，可空）。 */
  type?: string
  /** base64 内容（不带 `data:` 前缀）。 */
  base64: string
}

/** 准备好的上传体（直接能当 `POST /materials` 的 body）。 */
export interface PreparedUpload {
  /** 文件名。 */
  name: string
  /** base64 内容。 */
  base64: string
}

/** 一次上传准备的结果。 */
export type PrepareResult =
  | { ok: true, upload: PreparedUpload }
  | { ok: false, why: string }

/**
 * 上传前的把关（**纯函数**，真的能被断言）。
 *
 * ## 为什么单独抽出来
 *
 * 它原来住在 `ContentLibrary.tsx` 的 `input.onchange` 里，只能靠人点。
 * 现在它是纯函数：喂一个对象，看它放不放行。
 *
 * @param file - 见 `UploadCandidate`。
 * @returns 通过给 `upload`（可以直接 POST），不通过给 `why`（人话）。
 */
export function prepareUpload(file: UploadCandidate): PrepareResult {
  const name = String(file.name ?? '')

  /* ① 名字（先看，因为它决定后面能不能落盘）。 */
  const nameWhy = unsafeNameWhy(name)
  if (nameWhy !== '') return { ok: false, why: nameWhy }

  /* ② 类型。 */
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (!IMAGE_EXT.includes(ext) && !VIDEO_EXT.includes(ext)) {
    return {
      ok: false,
      why: '只收图片与视频文件（收到：' + (ext === '' ? '没有扩展名' : '.' + ext) + '）',
    }
  }

  /* ③ 空文件。 */
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, why: '这个文件是空的' }

  /* ④ 太大。**说清为什么是 6 MB 而不是 8 MB** —— 不然用户会觉得这个上限很随便。 */
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      why: '文件太大：' + humanBytes(file.size) + '，上限 ' + humanBytes(MAX_UPLOAD_BYTES)
        + '。上传走的是文本编码的请求体（另有 8 MB 的总上限），大约是原文件的 1.33 倍，'
        + '所以能传的原文件约 6 MB。更大的文件要等二进制上传那条路做好。',
    }
  }

  /* ⑤ base64 本身。读取失败会传空串进来；解码出 0 字节说明那串是坏的。 */
  const b64 = String(file.base64 ?? '')
  if (b64 === '') return { ok: false, why: '文件读不出来（内容为空）' }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, why: '文件内容不是合法的 base64（可能读取时被截断了）' }
  }

  return { ok: true, upload: { name, base64: b64 } }
}

/**
 * 从 `data:` 网址里取出 base64（`FileReader.readAsDataURL` 给的就是那个形状）。
 *
 * 为什么单独一个函数：组件里那段 `s.slice(s.indexOf(',') + 1)` 是
 * **最容易写错又最难验**的一行（jsdom 里跑不到）。抽出来就能喂各种形状。
 *
 * @param dataUrl - `data:<mime>;base64,<内容>`。
 * @returns base64 部分；不是这个形状就原样返回（让后面的校验去拦）。
 */
export function base64FromDataUrl(dataUrl: string): string {
  const s = String(dataUrl ?? '')
  const i = s.indexOf(',')
  return i < 0 ? s : s.slice(i + 1)
}

/**
 * 从文件名猜 mime（组件的预览与 `File.type` 为空时兜底用）。
 *
 * @param name - 文件名。
 * @returns mime；猜不到给 `application/octet-stream`。
 */
export function mimeOfName(name: string): string {
  const lower = String(name ?? '').toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  }
  return table[ext] ?? 'application/octet-stream'
}
