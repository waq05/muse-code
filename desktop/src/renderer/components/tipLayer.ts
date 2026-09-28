/**
 * 全局悬浮提示层。
 *
 * 一个委托监听器服务所有 [data-tip] 元素，气泡节点挂在 document.body 上用 fixed
 * 定位。画在元素自己身上（CSS ::after）的做法会被 .sidebar-scroll 这类 overflow
 * 容器裁掉，侧栏的行就吃过这个亏。
 *
 * 出现延时读令牌的 --dsc-tip-delay，气泡样式在 primitives.css 的 .dsc-tip。
 */

/** 气泡与目标的间距，与原先 CSS 版的 6px 保持同一档。 */
const GAP = 6;
/** 气泡离窗口边缘的最小距离。 */
const EDGE = 8;

/** 读 --dsc-tip-delay（形如 200ms / 0.2s）；读不到就按 200ms。 */
function showDelay(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsc-tip-delay').trim();
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) {
    return 200;
  }
  return raw.endsWith('s') && !raw.endsWith('ms') ? value * 1000 : value;
}

/**
 * 装上悬浮提示层，返回卸载函数。
 *
 * @returns 移除监听器与气泡节点的清理函数
 */
export function installTipLayer(): () => void {
  const bubble = document.createElement('div');
  bubble.className = 'dsc-tip';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.appendChild(bubble);

  let target: HTMLElement | null = null;
  let timer: number | undefined;

  const cancel = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const hide = (): void => {
    cancel();
    target = null;
    bubble.hidden = true;
  };

  const show = (owner: HTMLElement, text: string): void => {
    bubble.textContent = text;
    bubble.hidden = false;
    const box = owner.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const place = owner.getAttribute('data-tip-place') ?? 'top';
    let x: number;
    let y: number;
    if (place === 'right') {
      x = box.right + GAP;
      y = box.top + box.height / 2 - size.height / 2;
    } else if (place === 'bottom') {
      x = box.left + box.width / 2 - size.width / 2;
      y = box.bottom + GAP;
    } else {
      x = box.left + box.width / 2 - size.width / 2;
      y = box.top - size.height - GAP;
    }
    x = Math.min(Math.max(x, EDGE), window.innerWidth - size.width - EDGE);
    y = Math.min(Math.max(y, EDGE), window.innerHeight - size.height - EDGE);
    // 位移走 transform，避免逐帧改 left/top 触发重排。
    bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const ownerOf = (node: EventTarget | null): HTMLElement | null => {
    const start = node instanceof Element ? node : null;
    const hit = start?.closest('[data-tip]');
    return hit instanceof HTMLElement ? hit : null;
  };

  const textOf = (owner: HTMLElement): string => owner.getAttribute('data-tip') ?? '';

  const onOver = (event: MouseEvent): void => {
    const owner = ownerOf(event.target);
    if (owner === null || owner === target) {
      return;
    }
    const text = textOf(owner);
    if (text === '') {
      return;
    }
    cancel();
    target = owner;
    timer = window.setTimeout(() => show(owner, text), showDelay());
  };

  const onOut = (event: MouseEvent): void => {
    if (target === null) {
      return;
    }
    // 移到自己的子节点上不算离开，否则一行里换个图标气泡就闪一下。
    const goingTo = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (target.contains(goingTo)) {
      return;
    }
    hide();
  };

  const onFocusIn = (event: FocusEvent): void => {
    const owner = ownerOf(event.target);
    if (owner === null) {
      return;
    }
    const text = textOf(owner);
    if (text === '') {
      return;
    }
    // 键盘走位没有鼠标路过乱闪的问题，立刻给出提示。
    cancel();
    target = owner;
    show(owner, text);
  };

  const onFocusOut = (): void => hide();
  // 气泡按悬停瞬间的矩形定位，一滚动就对不上，因此滚动、拖动、切窗口都直接收起。
  const onDismiss = (): void => hide();
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      hide();
    }
  };

  document.addEventListener('mouseover', onOver);
  document.addEventListener('mouseout', onOut);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('scroll', onDismiss, { capture: true, passive: true });
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', onDismiss);

  return (): void => {
    hide();
    document.removeEventListener('mouseover', onOver);
    document.removeEventListener('mouseout', onOut);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('scroll', onDismiss, { capture: true });
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', onDismiss);
    bubble.remove();
  };
}
