/**
 * 全局确认框（Confirm）。
 *
 * 破坏性操作（删端点、归档、永久删除）动手前先把后果说清楚，等用户点一次
 * 「确认」再继续。结构走原语层现成的 .dsc-overlay + .dsc-overlay__card
 * （样式在 primitives.css），这里只管行为：
 *   - 返回 Promise：true = 点了确认，false = 取消 / Esc / 点遮罩；
 *   - 同一时刻只挂一张：后到的确认直接判前一张取消；
 *   - 打开时焦点落「取消」（防回车误确认），关掉后焦点还给触发按钮；
 *   - Esc 在捕获阶段就拦下并停止传播，压在它下面的设置面板不会跟着关掉。
 */

/** 一张确认框的内容。危险操作把 danger 置 true，主按钮走 --dsc-red 档。 */
export interface ConfirmSpec {
  /** 标题：一句话说清要动什么，如「删除端点「deepseek」？」。 */
  title: string;
  /** 说明：写清后果与去向（「会删除 xxx，30 天后清空，之后找不回」），不要写「确定吗」。 */
  detail: string;
  /** 主按钮文字，用动词：「归档」「删除」「永久删除」。 */
  confirmLabel: string;
  /** 不可逆/丢数据 → 主按钮走危险档。可逆操作留 false（品牌色主按钮）。 */
  danger?: boolean;
}

/** 当前挂着的确认框；再来一张时先把这张判取消收掉。 */
let active: { settle(): void } | null = null;

/**
 * 弹一张确认框，等用户决定。
 *
 * @param spec 标题、后果说明、主按钮文字与危险档
 * @returns true = 用户点了确认；false = 取消（含 Esc、点遮罩、被新框顶掉）
 */
export function confirmAction(spec: ConfirmSpec): Promise<boolean> {
  active?.settle();

  return new Promise<boolean>((resolve) => {
    const lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement('div');
    overlay.className = 'dsc-overlay dsc-confirm';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'dsc-overlay__card';
    card.style.setProperty('--card-w', '24rem');

    const body = document.createElement('div');
    body.className = 'dsc-confirm__body';
    const title = document.createElement('h3');
    title.className = 'dsc-confirm__title';
    title.id = 'dsc-confirm-title';
    title.textContent = spec.title;
    const detail = document.createElement('p');
    detail.className = 'dsc-confirm__detail';
    detail.id = 'dsc-confirm-detail';
    detail.textContent = spec.detail;
    body.append(title, detail);

    const actions = document.createElement('div');
    actions.className = 'dsc-confirm__actions';
    const cancel = document.createElement('button');
    cancel.className = 'dsc-btn';
    cancel.type = 'button';
    cancel.dataset.variant = 'secondary';
    cancel.dataset.size = 'sm';
    cancel.textContent = '取消';
    const proceed = document.createElement('button');
    proceed.className = 'dsc-btn';
    proceed.type = 'button';
    proceed.dataset.variant = spec.danger === true ? 'destructive' : 'primary';
    proceed.dataset.size = 'sm';
    proceed.textContent = spec.confirmLabel;
    actions.append(cancel, proceed);

    card.append(body, actions);
    overlay.append(card);
    overlay.setAttribute('aria-labelledby', 'dsc-confirm-title');
    overlay.setAttribute('aria-describedby', 'dsc-confirm-detail');

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 捕获阶段拦下：压在确认框下面的面板（设置等）不该跟着关。
        event.stopPropagation();
        settle(false);
        return;
      }
      if (event.key !== 'Tab') return;
      // 焦点环留在两个按钮之间，别 Tab 进被盖住的背景页面。
      // 框里可聚焦的就这两颗，Tab 和 Shift+Tab 都是「换到另一颗」。
      event.preventDefault();
      (document.activeElement === cancel ? proceed : cancel).focus();
    };
    const onBackdrop = (event: Event): void => {
      if (event.target === overlay) settle(false);
    };

    const self = { settle: () => settle(false) };
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.removeEventListener('pointerdown', onBackdrop);
      overlay.remove();
      if (active === self) active = null;
      // 焦点还给触发它的那颗按钮；按钮已经不在了（列表刷新）就算了。
      if (lastFocus !== null && lastFocus.isConnected) lastFocus.focus();
      resolve(ok);
    };
    let settled = false;
    active = self;

    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', onBackdrop);
    cancel.addEventListener('click', () => settle(false));
    proceed.addEventListener('click', () => settle(true));

    document.body.appendChild(overlay);
    cancel.focus();
  });
}
