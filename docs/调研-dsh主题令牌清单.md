# 调研 · dsh 的主题令牌清单（2026-10-08）

> 起因：用户定「**亮色主题要做，但主题色跟随 dsh 主题色，字号也是，使用 dsh 的字体/字号 token，不自己创造**」。
> 所以必须先查清 **dsh 到底提供了哪些 token**，我们只能映射过去，不能并排存两套。
> 方法：读 dsh 源码（`refs/deepseek-harness@62962ee4`）。**已核实**＝读到源码原文。

## 一、两个真源文件

| 文件 | 管什么 | 规模 |
| --- | --- | --- |
| `packages/client/ui-theme/src/styles/design-platform.css` | **颜色**：静态调色板 + 语义层 | 403 行；语义变量 **223 个** |
| `packages/client/ui-theme/src/styles/gradient-shadow-text.css` | **字号/行高/字重** | 字号档位 **30 条**（含 markdown 专用） |

**关键结构**：dsh 的颜色是**两层**——

```
--dsw-static-*  （静态调色板：blue-500 / neutral-100 / amber-400 …）
      ↓ 被引用
--dsw-alias-*   （语义层：bg-base / label-primary / border-l2 / button-primary-fill …）
```

**我们只能引用 `--dsw-alias-*` 这一层**（语义层），因为它才是「换主题时跟着变」的那层；
直接用 `--dsw-static-*` 就等于把颜色写死（亮暗切换不会变）。

## 二、字号 token（我们要用的档位）

**命名即尺寸**，非常好记：

| token | 值 | 我们该用在哪 |
| --- | --- | --- |
| `--dsw-font-xxxs-11-font-size` | 11px | 端口类型、进度百分比、最小徽标 |
| `--dsw-font-xxs-12-font-size` | 12px | 端口名、说明文字、表单标签 |
| `--dsw-font-xs-13-font-size` | 13px | 正文默认（节点摘要、按钮） |
| `--dsw-font-s-14-font-size` | 14px | 节点标题 |
| `--dsw-font-base-16-font-size` | 16px | 面板标题 |
| `--dsw-font-m-18-font-size` | **16px**（注意：名字是 18，值是 16） | 同上，优先用 base-16 |
| `--dsw-font-l-20-font-size` | 20px | 区块标题 |
| `--dsw-font-xl-24-font-size` | 24px | 页标题 |
| `--dsw-font-markdown-code-font-size` | 12px | 代码 |
| `--dsw-font-markdown-code-block-font-size` | 11px | 代码块 |

**还有「粗体」变体**（字重不同、字号相同）：`--dsw-font-xxxs-strong-11-font-size` 等，每个档位都有。

### ★ 一条重要发现：用户可调字号

dsh **允许用户调正文字号**，机制是：

```css
--dsh-content-font-size: 14px   /* 用户可调；主题 bootstrap 注入 */
--dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px)
```

- 正文类字号**不是写死的**，而是 `var(--dsh-content-font-size, 14px)`；
- markdown 的标题用 `calc(21px + var(--dsh-content-font-delta))`——**跟着用户的调节一起放大/缩小**。

**含义（对我们很重要）**：我们的画布如果要用 dsh 的字号体系，**正文类字号也应该跟着这个变量走**，
而不是取一个固定 13px。否则用户调大正文字号后，**画布里的字不跟着变**，观感割裂。

**落地做法（推断，待实施验证）**：
- 节点标题 / 正文 / 说明 → 用 `var(--dsh-content-font-size, 14px)` 与其派生；
- 纯装饰性的小字（端口类型）→ 用固定 token（`--dsw-font-xxxs-11-font-size`），因为它不属「正文」。

## 三、颜色语义层（我们要映射过去的槽位）

从 223 个 `--dsw-alias-*` 里挑出**画布真正需要的**：

| 我们要表达什么 | dsh 的 token |
| --- | --- |
| 画布底色 | `--dsw-alias-bg-base` |
| 面板 / 浮层底 | `--dsw-alias-bg-layer-1` ~ `-3`、`--dsw-alias-bg-overlay` |
| 主文字 | `--dsw-alias-label-primary` |
| 次文字 | `--dsw-alias-label-secondary` |
| 三级文字 | `--dsw-alias-label-tertiary` |
| 弱化文字 | `--dsw-alias-label-caption` |
| 边框（四级） | `--dsw-alias-border-l1` / `-l2` / `-l3` / `-l4` |
| 品牌 / 主色 | `--dsw-alias-brand-primary`、`--dsw-alias-brand-primary-new-color` |
| 交互悬停 | `--dsw-alias-interactive-bg-hover`、`-hover-accent` |
| 选中态 | `--dsw-alias-interactive-bg-active` |
| 遮罩 | `--dsw-alias-bg-mask-1` ~ `-3` |

**还有**：`--dsw-static-{green|amber|red|blue}-*` 这些用于**语义色**（成功/警告/错误/信息）。
它们虽是 static 名字，但**语义色本来就该固定**（成功永远是绿的），所以可以接受。

**注意**：文件里还有 `--dsw-alias-*-darkmode-*` 命名的变量（如 `--dsw-alias-border-l2-darkmode-thin`），
说明**亮暗两套值都存在**，由主题切换控制哪套生效——**我们不需要自己做亮暗切换，用语义层就自动跟随**。

## 四、对我们的直接结论

| # | 结论 |
| --- | --- |
| 1 | **亮色主题不需要我们自己造一套颜色**——dsh 的语义层已经覆盖亮暗两套，用它就自动切换 |
| 2 | 我们要做的是**把现有 `--v1-*` 自定义变量映射到 `--dsw-alias-*`**，而不是新写一套亮色值 |
| 3 | 字号必须改用 `--dsw-font-*` 档位，**尤其是正文类要跟随 `--dsh-content-font-size`**（否则用户调字号后画布不跟着变） |
| 4 | 此前那份「视觉令牌表」（对齐 Langflow/Activepieces 的值）**降级为参考**——最终值以 dsh 的 token 为准 |

## 五、出处

| 内容 | 路径 |
| --- | --- |
| 颜色（静态 + 语义） | `packages/client/ui-theme/src/styles/design-platform.css` |
| 字号 / 行高 / 字重 | `packages/client/ui-theme/src/styles/gradient-shadow-text.css` |
| 用户可调字号机制 | 同上，`--dsh-content-font-size` 与 `--dsh-content-font-delta` |
