import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveContext } from '../apps/extension/scope.ts';

// DOM fixture mirrors the two distinct "全部" controls and the observed list
// settings dialog. No customer messages or private Vue state are needed.
function contextFixture(withFilters = true) {
  let selectedView = '我的', selectedStatus = '未读', filterOpen = false, menuOpen = false, modalOpen = false;
  const clicks: string[] = [];
  const el = (textContent: string, action = () => {}, shown = () => true): any => ({
    textContent, value: '', checked: false,
    getBoundingClientRect: () => ({ width: shown() ? 10 : 0 }),
    click() { clicks.push(textContent); action(); },
    querySelector: () => null, querySelectorAll: () => [],
  });
  const root = el('root'), list = el('list'), search = el('search');
  list.parentElement = root; list.closest = () => root; list.contains = () => false;
  root.querySelector = (selector: string) => selector.includes('input') ? search : null;
  const my = el('我的'), all = el('侧栏全部', () => selectedView = '全部'), status = el('全部', () => selectedStatus = '全部');
  my.querySelector = () => el('我的'); all.querySelector = () => el('全部');
  const memberRule = el('members');
  memberRule.querySelectorAll = (selector: string) => selector.includes('[title]') ? [{ getAttribute: () => '接待成员' }] : selector.includes('__item__text') ? [el(selectedView === '全部' ? '全部' : 'Me')] : [];
  const popup = el('filters', () => {}, () => filterOpen), cancelFilter = el('取消', () => filterOpen = false);
  popup.querySelectorAll = (selector: string) => selector === 'button' ? [cancelFilter] : selector === '.filter-item__row' ? [memberRule] : [];
  const filterButton = el('筛选', () => filterOpen = true);
  const radio = el('radio'), descending = el('按消息时间倒序排序', () => radio.checked = true);
  descending.querySelector = () => radio;
  const modal = el('dialog', () => {}, () => modalOpen), confirm = el('确定', () => modalOpen = false);
  modal.querySelector = () => el('列表设置');
  modal.querySelectorAll = (selector: string) => selector === 'label' ? [descending] : selector === 'button' ? [confirm] : [];
  const more = el('更多', () => menuOpen = true), settings = el('列表设置', () => { menuOpen = false; modalOpen = true; }, () => menuOpen);
  const document = {
    querySelector(selector: string): any {
      if (selector === '#dynamic_scroller_list') return list;
      if (selector === '.view-list__area__item--active') return selectedView === '全部' ? all : my;
      if (selector === '.session-list__filter__tabs__item--active') return el(selectedStatus);
      if (selector.includes('icon-filter')) return withFilters ? filterButton : null;
      if (selector.includes('icon-more')) return more;
      return null;
    },
    querySelectorAll(selector: string): any[] {
      if (selector === '.view-list__area__item') return [my, all];
      if (selector === '.session-list__filter__tabs__item') return [status];
      if (selector === '.filter-popover') return [popup];
      if (selector.includes('.arco-dropdown-option') || selector.includes('.arco-trigger-content')) return [settings];
      if (selector === '.arco-modal') return [modal];
      return [];
    },
  };
  return { document, clicks, radio };
}
async function withDocument<T>(document: unknown, action: () => Promise<T>): Promise<T> {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  try { return await action(); }
  finally { if (old) Object.defineProperty(globalThis, 'document', old); else Reflect.deleteProperty(globalThis, 'document'); }
}
test('new date jobs select the left All view, all statuses and descending order while confirming all members', async () => {
  const ui = contextFixture();
  const scope = await withDocument(ui.document, () => archiveContext(true));
  assert.equal(scope.view, '全部'); assert.equal(scope.status, '全部'); assert.equal(scope.sort, 'desc');
  assert.deepEqual(JSON.parse(scope.rules!).rules[0].members, ['全部']);
  assert.ok(ui.clicks.includes('侧栏全部') && ui.clicks.includes('全部') && ui.clicks.includes('按消息时间倒序排序'));
  assert.equal(ui.radio.checked, true); assert.ok(!ui.clicks.includes('我的'));
});
test('an All label without inspectable filters cannot be presented as verified full-member scope', async () => {
  const ui = contextFixture(false);
  await assert.rejects(withDocument(ui.document, () => archiveContext(false)), /无法核对/);
});
