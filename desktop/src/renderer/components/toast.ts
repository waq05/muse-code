/**
 * 全局一次性反馈层（Toast）。
 *
 * 一个容器节点挂在 document.body 上（类名 .dsc-toasts，样式在 primitives.css，
 * 层级走 --dsc-z-toast），全渲染层共用这一条提示通路：以前侧栏一条 notice 条、
 * 设置面板一块 settings-note、插件页又一条 notice，同一个「写成功了」要说三遍。
 *
 * 成功用 --dsc-green（--dsc-toast-ok-ms 内自动消失），失败用 --dsc-red
 * （停得更久，并带一个关闭按钮）；动画只走 var(--dsc-dur) var(--dsc-ease)。
 */

/** 成功提示停留时长：短到不打断操作，长到能读完一句中文。 */
const OK_MS = 2200;
/** 失败提示停留时长：要能看清原因再动手修，所以久一些，还带关闭按钮。 */
const ERR_MS = 6000;
/** 同屏最多堆几条，超了就顶掉最早的成功提示。 */
const MAX_STACK = 4;

/** 退场动画的收尾等待，对应 --dsc-dur-slow（180ms）。 */
const EXIT_MS = 200;

const ICON_OK =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2 7.1 10.1 10.8 6"/></svg>';
const ICON_ERR =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v4"/><path d="M8 11.4h.01"/></svg>';

let container: HTMLElement | null = null;

/** 懒建容器：第一次要提示时才挂到 body 上。 */
function ensureContainer(): HTMLElement {
  if (container !== null && container.isConnected) return container;
  container = document.createElement('div');
  container.className = 'dsc-toasts';
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);
  return container;
}

/** 收掉一条：先走退场动效，再从 DOM 里摘掉。 */
function dismiss(node: HTMLElement): void {
  if (node.dataset.leaving === '1') return;
  node.dataset.leaving = '1';
  node.style.transition = `opacity var(--dsc-dur) var(--dsc-ease), transform var(--dsc-dur) var(--dsc-ease)`;
  node.style.opacity = '0';
  node.style.transform = 'translateY(4px)';
  window.setTimeout(() => node.remove(), EXIT_MS);
}

function push(tone: 'success' | 'danger', text: string, ms: number, closable: boolean): void {
  const root = ensureContainer();
  // 堆太满时顶掉最早的一条成功提示，失败的那条不许被挤掉（错误要看清）。
  while (root.children.length >= MAX_STACK) {
    const first = root.firstElementChild as HTMLElement | null;
    if (first === null) break;
    if (first.dataset.tone === 'danger' && tone === 'success') break;
    first.remove();
  }
  const node = document.createElement('div');
  node.className = 'dsc-toast';
  node.dataset.tone = tone;
  node.innerHTML = `${tone === 'success' ? ICON_OK : ICON_ERR}<span class="dsc-toast__text"></span>`;
  node.querySelector('.dsc-toast__text')!.textContent = text;
  if (closable) {
    const close = document.createElement('button');
    close.className = 'dsc-toast__close';
    close.type = 'button';
    close.setAttribute('data-tip', '关闭这条提示');
    close.setAttribute('aria-label', '关闭这条提示');
    close.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5"/><path d="M11.5 4.5 4.5 11.5"/></svg>';
    close.addEventListener('click', () => dismiss(node));
    node.appendChild(close);
  }
  root.appendChild(node);
  window.setTimeout(() => dismiss(node), ms);
}

/** 成功回执：绿边、约 2.2s 自动消失。 */
export function toastOk(text: string): void {
  push('success', text, OK_MS, false);
}

/** 失败回执：红边、停得久，并带关闭按钮。 */
export function toastErr(text: string): void {
  push('danger', text, ERR_MS, true);
}
