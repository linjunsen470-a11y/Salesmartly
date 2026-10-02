import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveEndpoint, assertMediaDownloadUrl } from '../packages/capture-core/endpoints.ts';
import { jobHeadline } from '../apps/extension/job-text.ts';

test('archive endpoints recognize history, pins and lists without treating text search as a history page', () => {
  assert.equal(archiveEndpoint('https://api.salesmartly.com/chat/chat-user/get-message-list'), 'history');
  assert.equal(archiveEndpoint('https://api-global.salesmartly.com/chat/chat-user/get-chat-history-message-list?page=2'), 'history');
  assert.equal(archiveEndpoint('https://api.salesmartly.com/chat/chat-user/get-pin-message-list'), 'pin');
  assert.equal(archiveEndpoint('https://api.salesmartly.com/chat/chat/get-chat-list'), 'list');
  assert.equal(archiveEndpoint('https://api.salesmartly.com/chat/chat/get-session-detail-list'), 'session');
  assert.equal(archiveEndpoint('https://app.salesmartly.com/chat/messages'), 'legacy');
  assert.equal(archiveEndpoint('https://api.salesmartly.com/chat/chat-user/get-chat-history-message-text-list'), null);
  assert.equal(archiveEndpoint('https://api.salesmartly.com/sys/company/company/get-gptbots-detail'), null);
  assert.equal(archiveEndpoint('https://example.com/chat/chat-user/get-message-list'), null);
});

test('confirmed media hosts are https CDNs and object storage only', () => {
  assert.doesNotThrow(() => assertMediaDownloadUrl('https://assets.salesmartly.com/a.jpg'));
  assert.doesNotThrow(() => assertMediaDownloadUrl('https://assets-cdn.salesmartly.com/a.jpg?x-oss-signature=1'));
  assert.doesNotThrow(() => assertMediaDownloadUrl('https://mix-ads.oss-accelerate.aliyuncs.com/a.jpg'));
  assert.throws(() => assertMediaDownloadUrl('http://assets.salesmartly.com/a.jpg'), /https/);
  assert.throws(() => assertMediaDownloadUrl('https://app.salesmartly.com/next/chat'), /已确认的文件域名/);
  assert.throws(() => assertMediaDownloadUrl('https://example.com/a.jpg'), /已确认的文件域名/);
});

test('a finished customer cap is labeled separately from a completed account range', () => {
  assert.equal(jobHeadline({ status: 'complete', options: { customerLimit: 5 }, totals: { total: 5 } }), '已完成设定的 5 位客户');
  assert.equal(jobHeadline({ status: 'complete', options: { customerLimit: 5 }, totals: { total: 3 } }), '消息采集完成');
  assert.equal(jobHeadline({ status: 'complete', options: { customerLimit: 0 }, totals: { total: 20 } }), '消息采集完成');
  assert.equal(jobHeadline({ status: 'partial', options: { customerLimit: 5 }, totals: { total: 5 } }), '已结束，部分范围未确认');
});
