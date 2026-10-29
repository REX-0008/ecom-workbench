/** 客户端 tsc 的**补充声明**（2026-10-24 契约 AK 重写）。
 *
 * ## 这份文件原来叫什么、为什么改了
 *
 * 原来它叫「最小 React / JSX 声明」，头一句写着「**只求让解析通过**，
 * 从而让 TS2448（用在定义之前）这一类错显出来」。那时本机没有 `@types/react`，
 * 于是它自己造了一份很粗的 react / `@xyflow/react` 声明。
 *
 * 代价是 `check:client` 长期红着 143 条**假报**（`Cannot find namespace 'React'`、
 * `data` 被索引签名吞掉导致 `Property 'x' does not exist` 等等）——
 * 一个永远红的关卡等于没有关卡，没人会去看它。
 *
 * ## 现在是什么
 *
 * 装上了真的 `@types/react@18` / `@types/react-dom@18`（devDependencies），
 * 而 `@xyflow/react` 本来就自带完整 `.d.ts`。所以这里**不再假装声明它们**，
 * 只留打包器那两类「类型系统不认识的东西」：
 *
 *   · `*.module.css` / `*.css` —— CSS Modules 的导出是构建期生成的，
 *     tsc 看不见，只能当 `Record<string, string>`；
 *   · `elkjs/lib/elk.bundled.js` —— 只有 JS 没有类型声明，且它的 API 面很大。
 *
 * ⚠️ **不要再往这里加 react / xyflow 的假声明**。假的声明会让类型检查
 * 变成「看起来在查、其实什么都查不到」—— 那种关卡比没有更糟：
 * 它会让人以为改了东西没问题（见本次 143 条假报的由来）。
 * 缺什么包就去装真的。
 */

declare module '*.module.css' {
  const css: Record<string, string>
  export default css
}

declare module '*.css'

/* ⚠️ `elkjs` 原来也被这句盖掉了：
 *
 *   declare module 'elkjs/lib/elk.bundled.js' { const ELK: unknown; export default ELK }
 *
 * 而 `elkjs` **自带真类型**（`lib/elk.bundled.d.ts` 直接 `export from './elk-api'`）。
 * 一句 `const ELK: unknown` 把它盖成了 unknown，于是
 * `InstanceType<typeof ELK>` 与 `new ELK()` 全报「不可构造」。
 *
 * 删掉这条假声明，让它自己的 `.d.ts` 生效 —— 这是本次从 143 条降到 0 的关键几处之一。
 * 教训同顶部：**别的地方已经有真类型时，假声明比没有更糟**。 */
