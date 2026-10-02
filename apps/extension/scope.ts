import type { BatchOptions } from '../../packages/shared/model.ts';
export const tidy = (value: string): string => value.replace(/\s+/g, ' ').replace(/\s*\d+\+?\s*$/, '').trim();
export function pageContext(): BatchOptions['scope'] {
  const list = document.querySelector('#dynamic_scroller_list');
  if (!list) throw new Error('未找到客户列表；请确认已登录并处于聊天页');
  const root = list.closest('.session-list__area') || list.parentElement!;
  const controls = [...root.querySelectorAll('button,[aria-checked="true"],.el-select__selected-item')].filter(node => !list.contains(node));
  const search = root.querySelector<HTMLInputElement>('.session-list__filter__search input') || [...root.querySelectorAll<HTMLInputElement>('input')].find(node => /搜索|search|客户名称/i.test(node.placeholder));
  return { view: viewName(document.querySelector('.view-list__area__item--active')), status: tidy(document.querySelector('.session-list__filter__tabs__item--active')?.textContent || ''), search: search?.value || '', filters: (document.querySelector('.session-list__filter__header__icon__item__count')?.textContent || '0') + '|' + controls.map(node => tidy(node.textContent || '')).filter(Boolean).join('|') };
}
export function viewName(node: Element | null): string { return node?.querySelector('.view-list__area__item__left__name')?.textContent?.trim() || tidy(node?.textContent || ''); }
export function sameScope(a: BatchOptions['scope'], b: BatchOptions['scope']): boolean { const { rules: _a, sort: _sortA, ...left } = a, { rules: _b, sort: _sortB, ...right } = b; return JSON.stringify(left) === JSON.stringify(right); }
const delay = () => new Promise(resolve => setTimeout(resolve, 120));
const visible = (node: Element) => node.getBoundingClientRect().width > 0;
const exactVisible = (root: Element | Document, selector: string, text: string): HTMLElement | undefined => [...root.querySelectorAll<HTMLElement>(selector)].find(node => visible(node) && node.textContent?.trim() === text);
export async function ensureDescending(): Promise<void> {
  const more = document.querySelector<HTMLElement>('.session-list__filter__header__icon__item:has(.icon-more)');
  if (!more) throw new Error('未找到列表排序设置，未采用日期截止优化');
  more.click(); await delay();
  const settings = exactVisible(document, '.arco-trigger-content span,.arco-trigger-content div', '列表设置') || exactVisible(document, 'span', '列表设置');
  if (!settings) throw new Error('未找到“列表设置”入口'); settings.click();
  const end = Date.now() + 8_000; let modal: Element | undefined;
  while (Date.now() < end) { modal = [...document.querySelectorAll('.arco-modal')].find(node => visible(node) && node.querySelector('.arco-modal-title')?.textContent?.trim() === '列表设置'); if (modal) break; await delay(); }
  if (!modal) throw new Error('列表排序对话框未加载');
  const label = exactVisible(modal, 'label', '按消息时间倒序排序'), radio = label?.querySelector<HTMLInputElement>('input[type="radio"]');
  if (!radio) { cancel(modal); throw new Error('未识别消息时间倒序选项'); }
  if (!radio.checked) { label!.click(); await delay(); }
  if (!radio.checked) { cancel(modal); throw new Error('未能启用消息时间倒序'); }
  const confirm = exactVisible(modal, 'button', '确定'); if (!confirm) throw new Error('未找到列表设置确认按钮'); confirm.click(); await delay();
}
export async function archiveContext(dateMode: boolean): Promise<BatchOptions['scope']> {
  const end = Date.now() + 20_000;
  while (!document.querySelector('#dynamic_scroller_list') && Date.now() < end) await delay();
  const all = [...document.querySelectorAll<HTMLElement>('.view-list__area__item')].filter(node => viewName(node) === '全部');
  if (all.length !== 1) throw new Error('未找到左侧“全部”会话视图');
  if (pageContext().view !== '全部') { all[0].click(); await delay(); }
  const status = [...document.querySelectorAll<HTMLElement>('.session-list__filter__tabs__item')].find(node => tidy(node.textContent || '') === '全部');
  if (pageContext().status !== '全部') { if (!status) throw new Error('未找到全部会话状态'); status.click(); await delay(); }
  let scope: BatchOptions['scope'] | undefined;
  while (Date.now() < end) {
    scope = await inspectScope();
    if (!scope.rules) throw new Error('无法核对“全部”视图的筛选详情，请关闭其他弹层或刷新后重试');
    const rules = scope.rules ? JSON.parse(scope.rules) : null;
    if (scope.view === '全部' && scope.status === '全部' && !rules?.rules?.some((row: any) => row.fields?.includes('接待成员') && row.members?.some((name: string) => name !== '全部'))) break;
    await delay();
  }
  if (!scope || scope.view !== '全部') throw new Error('全部会话视图未就绪');
  if (scope.search) throw new Error('全部会话仍有搜索条件，请清空客户搜索后开始');
  if (scope.rules && JSON.parse(scope.rules).rules?.some((row: any) => row.fields?.includes('接待成员') && row.members?.some((name: string) => name !== '全部'))) throw new Error('全部视图仍限制接待成员，请取消该筛选后开始');
  if (dateMode) { await ensureDescending(); scope = { ...scope, sort: 'desc' }; }
  return scope;
}
async function waitForAccountSelection(picker: Element): Promise<void> {
  const end = Date.now() + 4_000;
  while (!picker.querySelector('.arco-radio-checked,.arco-checkbox-checked,.arco-checkbox-indeterminate')) {
    if (Date.now() >= end) throw new Error('社媒账号筛选尚未加载完成，请稍后继续');
    await delay();
  }
}
function cancel(root?: Element | null): void { [...(root?.querySelectorAll<HTMLButtonElement>('button') || [])].find(button => button.textContent?.trim() === '取消')?.click(); }
export async function inspectScope(): Promise<BatchOptions['scope']> {
  const base = pageContext(), button = document.querySelector<HTMLElement>('.session-list__filter__header__icon__item:has(.icon-filter)');
  if (!button) return base;
  let popup = [...document.querySelectorAll('.filter-popover')].find(visible), opened = false;
  try {
    if (!popup) { button.click(); opened = true; await delay(); popup = [...document.querySelectorAll('.filter-popover')].find(visible); }
    if (!popup) throw new Error('无法读取筛选详情，请关闭其他弹层后重试');
    const account = popup.querySelector<HTMLElement>('.channel-account-select'); let accounts: unknown = null;
    if (account) {
      account.click(); await delay();
      const picker = [...document.querySelectorAll('.select-trigger__content')].find(visible);
      if (!picker) throw new Error('无法读取社媒账号筛选');
      try {
        await waitForAccountSelection(picker);
        if (picker.querySelector('.select-trigger__channel-item .arco-radio-checked')) accounts = 'all';
        else {
          if (picker.querySelector('.arco-checkbox-indeterminate')) throw new Error('当前仅选择了部分社媒账号，自动核对尚未支持此条件；请先选择全部账号或整个渠道再采集');
          accounts = [...picker.querySelectorAll('.select-trigger__channel-item')].filter(row => row.querySelector('.arco-checkbox-checked')).map(row => row.querySelector('.select-trigger__name')?.textContent?.trim()).sort();
        }
      } finally { cancel(picker); }
    }
    // The member tags render after the account picker and the popup's initial frame.
    await delay();
    const memberEnd = Date.now() + 8_000;
    while ([...popup.querySelectorAll('.filter-item__row')].some(row => row.querySelector('.member-select-tags__wrap--disabled') && !row.querySelector('.member-select-tags__wrap__row__item__text'))) {
      if (Date.now() >= memberEnd) throw new Error('接待成员筛选尚未显示，请保持采集页可见后继续');
      await delay();
    }
    const rules = [...popup.querySelectorAll('.filter-item__row')].map(row => ({ fields: [...row.querySelectorAll('.arco-select-view[title]')].map(node => node.getAttribute('title')), members: [...row.querySelectorAll('.member-select-tags__wrap__row__item__text')].map(node => node.textContent?.trim()), values: [...row.querySelectorAll<HTMLInputElement>('input:not(.arco-select-view-input)')].map(node => node.value) }));
    return { ...base, rules: JSON.stringify({ rules, accounts }) };
  } finally { if (opened) cancel(popup); }
}
