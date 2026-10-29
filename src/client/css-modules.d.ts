/** CSS Modules 的类型声明。
 *
 * 构建时由 tsdown 的 lightningcss 把 `x.module.css` 编译成「哈希后的类名映射」，
 * 运行时默认导出就是一个 { 本地类名: 哈希类名 } 的对象。
 * 这里给 TypeScript 一个最小声明，编辑器才不会对 `import css from './x.module.css'` 报红。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
