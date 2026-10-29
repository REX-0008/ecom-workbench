/** 编组的**连贯规则**（纯运算，不碰 React / DOM，可脱离界面单测）。
 *
 * ## 这个文件为什么现在只剩一个函数
 *
 * 2026-10-13 编组换成**名单模型**（照 n8n 的 Canvas Groups）之后，
 * 原来那批**坐标换算**函数全部作废了：
 *   - `groupBoxOf` / `attachToGroup`：建框时算包围盒、把成员坐标改成**相对框**；
 *   - `ungroupNodes`：解散时再换成**绝对坐标**；
 *   - `fitAllGroups`：让框贴紧成员；
 *   - `childCountOf`：数框里几个成员。
 *
 * 新模型里**成员坐标永不改写**（框是渲染时算出来的），所以这些都不需要了。
 * 那一族「框跳走 / 贴边覆盖 / 相对绝对互转错」的 bug 也就**从根上不存在**
 * —— 我们曾为此踩过三次。
 *
 * 剩下的是**连贯规则**：用户 2026-10-11 定的
 * 「编组必须满足连贯……编组的意思类似于一个小工作流，他应该是一个连续的动作」。
 * 它与坐标无关，所以留在这里。
 */

/**
 * 算出「为了编组连贯，还该有谁一起进来」（用户 2026-10-11 要求）。
 *
 * 用户原话：
 *   「编组逻辑——编组必须满足连贯，即，当一个节点的前后都在一个编组里面，
 *     那么他自动进入编组——编组的意思类似于一个小工作流，
 *     他应该是一个连续的动作而不是几个独立的节点。」
 *
 * ## 这个函数在解决什么
 *
 * 用户选中几个节点要编组时，选中的**可能不是一段连贯的流程**。例如：
 *
 *   A → B → C → D
 *   用户只选了 A 和 C（漏了中间的 B）
 *
 * 如果就这么编组，框里会有 A、C 两个节点，但 B 夹在中间却不在框里 ——
 * 那不是「一个小工作流」，是两段孤立的节点拼在一起（连 B 的线会穿过框）。
 *
 * ## 判定规则（由用户那句话直接翻译过来）
 *
 * 「当一个节点的前后都在一个编组里，那么他自动进入编组」——
 * 也就是：**从已有成员出发，顺着连线往外走，只要某个节点的上游与下游都在集合里，
 * 它就该进来**。反过来：
 *
 *   - 只有一个邻居在框里（链的头尾）→ **不拉进来**（否则会无限扩散到整张图）
 *   - 两个邻居都在框里（夹在中间）→ **拉进来**（这是「连贯」的要求）
 *
 * ## 算法（反复扫描到不动为止）
 *
 * 一次扫描可能不够：把 B 拉进来之后，原本「只有一边在框里」的某个节点
 * 可能变成「两边都在框里」了，所以要多轮直到没有新增。
 *
 * ⚠️ 判据用**邻居是否在集合内**，不看边的方向 —— 一个节点可能有多个上游/下游，
 * 只要「至少一个上游在」且「至少一个下游在」就成立。
 *
 * @param picked - 用户选中的节点 id。
 * @param edges - 全部连线。
 * @returns 补齐后的节点 id 集合（**包含** picked 本身）。
 */
export function closeUnderTransit(
  picked: ReadonlySet<string>,
  edges: readonly { source: string, target: string }[],
): Set<string> {
  const got = new Set(picked)
  /* 反查表：每个节点的上游 / 下游（都比对自己是否在集合里）。 */
  const ups = new Map<string, Set<string>>()
  const downs = new Map<string, Set<string>>()
  for (const e of edges) {
    if (e.source === e.target) continue
    if (!downs.has(e.source)) downs.set(e.source, new Set())
    downs.get(e.source)?.add(e.target)
    if (!ups.has(e.target)) ups.set(e.target, new Set())
    ups.get(e.target)?.add(e.source)
  }

  /**
   * 从 `from` 顺着下游走，能到达 `to` 吗（中间可以经过任意节点）。
   *
   * ⚠️ **中间节点不要求已在集合里**（这条是修 BUG 的关键）：
   * A→B→C→D 只选 A、D 时，B 到 D 的路径要**穿过 C**，而 C 当时还不在集合里。
   * 如果限制「只能走集合内的节点」，这条路径就被判为不可达，B 与 C 都漏掉。
   * 所以这里允许穿过任何节点，只判断**终点**在不在集合里。
   *
   * 这不等于会无限扩散：调用方还有一个「**必须有上游在集合里**」的前置条件，
   * 保证只有「被夹住」的节点才走这条路；一头一尾不会被拉进来。
   *
   * @param from - 起点。
   * @param to - 终点。
   * @returns 能走到则 true。
   */
  const reachable = (from: string, to: string): boolean => {
    const seen = new Set<string>()
    const stack = [from]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      for (const nxt of downs.get(cur) ?? []) {
        if (nxt === to) return true
        if (seen.has(nxt)) continue
        seen.add(nxt)
        stack.push(nxt)
      }
    }
    return false
  }

  /* 所有出现过的节点（含只在边里出现的），它们是候选；picked 里的当然也要考虑。 */
  const all = new Set<string>([...picked, ...ups.keys(), ...downs.keys()])

  for (;;) {
    let grew = false
    for (const id of all) {
      if (got.has(id)) continue
      /* ① 相邻：上下游各有一个在集合里。 */
      const hasUp = [...(ups.get(id) ?? [])].some(x => got.has(x))
      const hasDown = [...(downs.get(id) ?? [])].some(x => got.has(x))
      let take = hasUp && hasDown
      /* ② 隔着几个：**有一个上游在集合里**，且从本节点**能走到**某个在集合里的节点。
       *    第一个条件保证它是「被夹住」而不是在头部（头部不该被拉）；
       *    第二个条件保证它与集合里的某个下游连得上。 */
      if (!take && hasUp && got.size > 0) {
        take = [...got].some(target => target !== id && reachable(id, target))
      }
      if (take) { got.add(id); grew = true }
    }
    if (!grew) break
  }
  return got
}
