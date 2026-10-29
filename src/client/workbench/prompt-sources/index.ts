/** 提示词源的**内置兜底副本**（契约 AZ，2026-10-25）。
 *
 * ## 这里是干什么的
 *
 * 内容板块的「提示词库」从外部源（GitHub 上的 JSON 集合）拉数据。那些源会挂：
 * 仓库改名、删库、网络不通。**源挂了不能让人打不开提示词库**。
 *
 * 所以每个源在代码里留一份**截断过的副本**：断网也能看到、能复制一条。
 * 网络通的时候照旧从上游拉最新，这份只是兜底。
 *
 * ## 为什么放 `src/` 而不是数据目录
 *
 * 兜底副本必须**跟代码一起打包**：换机、清数据目录、重装插件都不能丢。
 * 放数据目录（`data/ecom-workbench/prompt-cache/`）是**缓存**，那是另一个东西，会过期、会清。
 *
 * ## 截断规则（契约 AZ 定的）
 *
 * - 每个源**最多 200 条**；
 * - 单文件**不超过 300 KB**，超了从尾部继续削；
 * - **只截断，不改结构**：每一条的内部字段一个都不动，这样将来跟上游对账能对上。
 *
 * 被截断的源在下面 `truncatedFrom` 里写明原文条数 —— **不写这一条，读的人会以为上游只有这么多**。
 *
 * ## 怎么更新（以后重新拉）
 *
 * 见 `docs/调研-提示词源与兜底副本.md` 的「怎么更新」一节。README 没写到这里，
 * 因为更新步骤会随源变化，放在文档里更好改。
 */
import awesomeGptImage from './awesome-gpt-image.json'
import awesomeGpt4o from './awesome-gpt4o-image-prompts.json'
import bananaPromptQuicker from './banana-prompt-quicker.json'
import youmindGptImage2 from './youmind-gpt-image-2.json'
import youmindNanoBananaPro from './youmind-nano-banana-pro.json'

/** 一条提示词（**上游的结构**，字段名照抄，不翻译不改名）。
 *
 * ⚠️ 这五个源的字段**完全一致**，所以只声明一份。将来若某个源加了字段，
 * 在这里补成可选即可，不要为每个源各写一个类型。
 */
export interface PromptEntry {
  /** 上游给的稳定 id（`源名:哈希`）。 */
  id: string
  /** 属于哪个源。 */
  sourceId: string
  /** 标题（一行）。 */
  title: string
  /** 提示词正文 —— 这是**唯一**要复制给模型的那段。 */
  prompt: string
  /** 补充说明，可能是空串。 */
  description: string
  /** 效果图地址（GitHub 附件链接），可能是空串。 */
  coverUrl: string
  /** 参考图地址列表。 */
  referenceImageUrls: string[]
  /** 可筛的标签（如「摄影与照片级写实」、作者名）。 */
  tags: string[]
  /** 原作者。 */
  author: string
  /** 原帖地址。 */
  sourceUrl: string
  /** 上游的时间字段，可能是空串。 */
  createdAt: string
  /** 上游的图模式字段，可能是空串。 */
  imageMode: string
  /** 上游标注的模型名。 */
  imageModel: string
}

/** 一个内置源的清单项。 */
export interface BuiltinPromptSource {
  /** 源的稳定 id（与缓存文件名、上游 `sourceId` 同一套）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 上游地址（**运行时从这拉最新**；这里的内置副本是该地址的截断快照）。 */
  url: string
  /** 上游仓库主页（给人看的）。 */
  homepage: string
  /** 上游仓库的许可（照实抄，见文档里的核对记录）。 */
  license: string
  /** 内置副本的条目数（**现数**，不是上游总数）。 */
  count: number
  /** 上游原文的条目数（现数）。与 `count` 不等即表示**这份是截断过的**。 */
  upstreamCount: number
  /** 内置的条目本身。 */
  entries: readonly PromptEntry[]
}

/** 上游源的公共前缀（五个源都挂在同一个索引仓下）。 */
const REGISTRY_BASE = 'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources'

/**
 * 五个内置源。
 *
 * 选这五个的理由见文档；一句话：**许可清楚 + 条目多 + 有 tags 可筛 + 中文占比高**。
 * 被排除的三个源（两个无许可、一个条目结构不同）也在文档里写明了。
 */
export const BUILTIN_PROMPT_SOURCES: readonly BuiltinPromptSource[] = [
  {
    id: 'awesome-gpt-image',
    name: 'Awesome GPT Image',
    url: REGISTRY_BASE + '/awesome-gpt-image.json',
    homepage: 'https://github.com/ZeroLu/awesome-gpt-image',
    license: 'MIT',
    count: (awesomeGptImage as PromptEntry[]).length,
    upstreamCount: 53,
    entries: awesomeGptImage as PromptEntry[],
  },
  {
    id: 'awesome-gpt4o-image-prompts',
    name: 'Awesome GPT-4o',
    url: REGISTRY_BASE + '/awesome-gpt4o-image-prompts.json',
    homepage: 'https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts',
    license: 'MIT',
    count: (awesomeGpt4o as PromptEntry[]).length,
    upstreamCount: 76,
    entries: awesomeGpt4o as PromptEntry[],
  },
  {
    id: 'youmind-gpt-image-2',
    name: 'YouMind GPT Image 2',
    url: REGISTRY_BASE + '/youmind-gpt-image-2.json',
    homepage: 'https://github.com/YouMind-OpenLab/awesome-gpt-image-2',
    license: 'CC BY 4.0',
    count: (youmindGptImage2 as PromptEntry[]).length,
    upstreamCount: 126,
    entries: youmindGptImage2 as PromptEntry[],
  },
  {
    id: 'youmind-nano-banana-pro',
    name: 'YouMind Nano Banana Pro',
    url: REGISTRY_BASE + '/youmind-nano-banana-pro-prompts.json',
    homepage: 'https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts',
    license: 'CC BY 4.0',
    count: (youmindNanoBananaPro as PromptEntry[]).length,
    upstreamCount: 129,
    entries: youmindNanoBananaPro as PromptEntry[],
  },
  {
    id: 'banana-prompt-quicker',
    name: 'Banana Prompt Quicker',
    url: REGISTRY_BASE + '/banana-prompt-quicker.json',
    homepage: 'https://github.com/glidea/banana-prompt-quicker',
    license: 'MIT',
    /* ⚠️ **这一个被截断了**：上游 323 条，受 200 条上限只留了前 200 条。
     * `count` 与 `upstreamCount` 不等就是标记，界面要据此提示「内置副本只到第 200 条」。 */
    count: (bananaPromptQuicker as PromptEntry[]).length,
    upstreamCount: 323,
    entries: bananaPromptQuicker as PromptEntry[],
  },
]

/**
 * 按 id 取一个内置源。
 *
 * @param id - 源 id。
 * @returns 那个源；没有就 undefined（**不抛错**：外部传进来的 id 可能是用户自己填的源）。
 */
export function builtinSourceById(id: string): BuiltinPromptSource | undefined {
  return BUILTIN_PROMPT_SOURCES.find(s => s.id === id)
}

/**
 * 把所有内置源摊平成一张表（供离线检索用）。
 *
 * @returns 每条都带上 `sourceId`（上游本来就带，这里不再补）。
 */
export function allBuiltinEntries(): readonly PromptEntry[] {
  return BUILTIN_PROMPT_SOURCES.flatMap(s => s.entries)
}
