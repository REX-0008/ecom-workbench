/** 节点卡片 → 画布的**一句话通知**：我刚刚撑高（或缩回）了。
 *
 * ## 为什么用一个模块级的回调，而不是 window 事件
 *
 * 一开始用的是 `window.dispatchEvent(new CustomEvent(...))`，在真浏览器里没问题，
 * 但测试环境（jsdom）里 `CustomEvent` 不在全局上 —— 节点一渲染就抛
 * 「parameter 1 is not of type Event」，`dom-render` 整个崩掉。
 * 也可以改成 `Event`，但那样还得在 window 上挂自定义属性传参，更绕。
 *
 * 这里就是一个订阅位：反正**同时只有一个画布**，一个回调够了。
 * 不碰 DOM ⇒ 测试环境、真机行为完全一致，也不用担心事件冒泡那些细则。
 */

/** 当前的订阅者（画布）。同一时刻只有一个。 */
let listener: ((id: string) => void) | null = null

/**
 * 换一个订阅者（画布挂载时设，卸载时传 null）。
 * @param fn - 收到通知要做什么；null = 退订。
 */
export function setExpandShiftListener(fn: ((id: string) => void) | null): void {
  listener = fn
}

/**
 * 报到：id 这个节点的展开态刚变化完，画面已经按新高度排好了。
 * @param id - 节点 id。
 */
export function pingExpandShift(id: string): void {
  if (listener !== null) listener(id)
}
