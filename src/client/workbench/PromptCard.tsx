/** 提示词卡片 —— **照抄**参考项目的 `prompt-card.tsx`。
 *
 * ## 抄自哪里、改了什么（照抄三条纪律的第 ③ 条）
 *
 * 抄自 `refs-projects/infinite-canvas/web/src/components/prompts/prompt-card.tsx`（43 行）。
 * 改动：
 *   ① `antd` 的 `Card` / `Tag` / `Button` **保留**（用户 m03555 已批准用组件库；
 *      卡片间距、圆角、hover 抬升、Tag 配色全是 antd 默认值，自己写就是「又发明一套」）
 *   ② 去掉 i18n（`useTranslation`），中文硬编码
 *   ③ 图标换成我们自己的 `icons.tsx`（**不引 `@ant-design/icons`**）
 *   ④ 封面比例从参考项目的 `aspect-square` / `aspect-[4/3]` 统一成 **`aspect-[4/3]`**：
 *      我们右列窄（默认 320~900px，三列时每格才约 100~280px），
 *      正方形会让卡片变得很高、一屏看不到两张。
 *   ⑤ `formatPromptDate` 删掉：我们的 `PromptEntry` 只有上游给的**字符串**时间
 *      （`createdAt: string`），不像参考项目有 `updatedAt: number` 可格式化 ——
 *      原样显示上游字符串反而更诚实。
 *   ⑥ 加 `data-ewb-pl-card` 一族钩子：jsdom 里 CSS Modules 类名是空的，
 *      断言只能挂 data 属性（与 `content-nodes.tsx` 同一套做法）。
 *
 * ## 为什么图片放在卡片上（这一单的根）
 *
 * 原来图片只在「展开之后」才挂（`PromptLibrary.tsx:433-436`），
 * 用户看到的是列表文字、图藏着 —— 而 584 条**每一条都有 `coverUrl`**。
 * 参考项目的做法是「卡片 + 一次 20 条 + 翻页」：既不白拉 584 张图，又能看到图。
 *
 * ## ⚠️ 按需引入（照抄纪律第 ① 条）
 *
 * 只从 `antd` 解构需要的三个组件。**绝不** `import antd from 'antd'` ——
 * `tests/antd-smoke.mjs` 有源码断言钉住这一条（裸根入口会解析到 CJS 整包）。
 */
import { Button, Card, Tag } from 'antd'
import type { PromptEntry } from './prompt-sources/index.ts'
import { FileTextIcon } from './icons.tsx'
import { renderEmphasis } from './emphasis-render.tsx'

/** 卡片入参。 */
export interface PromptCardProps {
  /** 这一条提示词。 */
  entry: PromptEntry
  /** 点开看大图与完整正文。 */
  onOpen: () => void
  /** 复制正文（**带 `**` 的原文**，不是渲染后的）。 */
  onCopy: () => void
  /** 所属源的许可（显示在卡片底部；CC BY 4.0 是法律要求）。 */
  license: string
}

/**
 * 一条提示词卡片。
 *
 * ## 配色走令牌（票 36，2026-10-28）
 *
 * 原来卡面颜色全部来自 antd 的默认值。而本项目**没有 `ConfigProvider`**
 * （全仓 0 处），antd 永远用它自己的亮色算法 —— 于是暗色主题下卡片是一整块白，
 * 与页面底完全不搭。用户原话：「提示词库没有针对主题进行背景颜色的适配」。
 *
 * 修法是把卡面这三层颜色逐个钉到 dsh 的语义令牌上（`--dsw-alias-*`），
 * 令牌自带亮暗两套值，所以**只写一次就同时跟两套主题**：
 *   · `root`  → 卡片底 / 描边 / 正文字色
 *   · `Tag`   → 标签的底 / 字 / 边
 *   · `Button`→ 复制按钮
 * 参考项目 `prompt-card.tsx` 用的是 `bg-stone-100 / dark:bg-stone-900` 那套
 * Tailwind 硬编码双写（见 `refs-projects/infinite-canvas`）—— 我们不用它，
 * 因为那是"两套写死"，主题换代色值就得跟着改；令牌是一处。
 *
 * ## 为什么不用 `ConfigProvider` 统改
 *
 * 它会一次影响**全部** antd 组件（配置页那几个 tab 也在用，归别的票在改），
 * 属于扩范围。这张票只碰提示词库与渠道两处，所以逐处钉色。
 *
 * @param props - 条目与两个动作。
 * @returns 卡片。
 */
export function PromptCard({ entry, onOpen, onCopy, license }: PromptCardProps): React.JSX.Element {
  return (
    <Card
      hoverable
      className="flex h-full flex-col overflow-hidden"
      data-ewb-pl-card-root={entry.id}
      styles={{
        root: {
          background: 'var(--dsw-alias-bg-layer-1)',
          borderColor: 'var(--dsw-alias-border-l2)',
          color: 'var(--dsw-alias-label-primary)',
        },
        body: { display: 'flex', flex: 1, flexDirection: 'column', padding: 0 },
      }}
      cover={(
        <button
          type="button"
          data-ewb-pl-card-cover={entry.id}
          className="block w-full cursor-pointer text-left"
          onClick={onOpen}
        >
          {entry.coverUrl === ''
            ? (
              /* ★ 无图占位：**虚线框 + 图标 + 文字**，不是色块。
               * 色块会被当成「图没加载出来」，这里要说清「本来就没有」。 */
              <span
                data-ewb-pl-card-noimg={entry.id}
                className="grid aspect-[4/3] w-full place-items-center border border-dashed border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-tertiary)]"
              >
                <span className="flex flex-col items-center gap-1">
                  <FileTextIcon size={22} />
                  <span className="font-mono text-ewb-caption">无效果图</span>
                </span>
              </span>
            )
            : (
              <img
                data-ewb-pl-card-img={entry.id}
                src={entry.coverUrl}
                alt={entry.title}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
            )}
        </button>
      )}
    >
      <button
        type="button"
        data-ewb-pl-card-body={entry.id}
        className="block w-full flex-1 cursor-pointer text-left"
        onClick={onOpen}
      >
        <div className="p-2.5">
          {/* 标题：一行省略（参考项目 `line-clamp-1`）。 */}
          <h2
            data-ewb-pl-card-title={entry.id}
            className="line-clamp-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]"
            title={entry.title}
          >{entry.title === '' ? '（没有标题）' : entry.title}</h2>
          {/* 描述 / 正文摘要：3 行省略（参考项目 `line-clamp-3`）。
           * ⚠️ 走 `renderEmphasis`：8 条正文带 140 处 `**`，直出就是两颗星。
           * 有 description 时优先用 description（参考项目也是这个顺序）。 */}
          <div
            data-ewb-pl-card-desc={entry.id}
            className="mt-1.5 line-clamp-3 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]"
          >{renderEmphasis(entry.description !== '' ? entry.description : entry.prompt)}</div>
          {/* 标签：最多 3 个（参考项目全铺，我们右列窄，铺开会把卡片撑高）。 */}
          {Array.isArray(entry.tags) && entry.tags.length > 0
            ? (
              <div data-ewb-pl-card-tags={entry.id} className="mt-2 flex flex-wrap gap-1">
                {entry.tags.slice(0, 3).map(t => (
                  <Tag
                    key={t}
                    className="m-0 text-ewb-caption"
                    style={{
                      color: 'var(--dsw-alias-label-secondary)',
                      background: 'var(--dsw-alias-interactive-bg-hover)',
                      borderColor: 'var(--dsw-alias-border-l2)',
                    }}
                  >{t}</Tag>
                ))}
              </div>
            )
            : null}
        </div>
      </button>
      {/* 底部：许可 + 作者 + 复制。
       * ★ 署名是法律要求（CC BY 4.0），**每个源都显示**，不按源特判 ——
       * 许可将来会变，按源特判的代码不会跟着变。 */}
      <div className="mt-auto flex items-center gap-2 px-2.5 pb-2.5">
        <span
          data-ewb-pl-card-license={entry.id}
          className="min-w-0 flex-1 truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
          title={entry.author === '' ? license : license + ' · ' + entry.author}
        >{license}{entry.author === '' ? '' : ' · ' + entry.author}</span>
        {/* ⚠️ 钩子挂在**外层 span** 上，不挂在 antd `Button` 上：
         * 自定义组件的 props 类型里没有 `data-*` 索引签名，写上去 TS 会报错；
         * 而 `Button` 的点击会冒泡到这个 span，所以两种点法（点字 / 点边）都只触发一次。 */}
        <span data-ewb-pl-copy={entry.id} className="shrink-0" onClick={onCopy}>
          <Button
            size="small"
            style={{
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              borderColor: 'var(--dsw-alias-border-l2)',
            }}
          >复制</Button>
        </span>
      </div>
    </Card>
  )
}
