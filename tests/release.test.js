import test from 'node:test';
import assert from 'node:assert/strict';
import { runStore } from '../scripts/chrome-web-store.mjs';
import { compareVersions, validateRelease, versionParts } from '../scripts/validate-release.mjs';

const extensionId = 'nfidmnbdgmlgnfapkdgckfhoneoogkkh';
const name = `publishers/test-publisher/items/${extensionId}`;
const env = { CWS_PUBLISHER_ID: 'test-publisher', CWS_CLIENT_ID: 'test-client', CWS_CLIENT_SECRET: 'test-secret', CWS_REFRESH_TOKEN: 'test-refresh' };
const identity = { name, itemId: extensionId };
const item = () => ({ ...identity, publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.1' }] } });
const upload = () => ({ ...identity, crxVersion: '2.0.0', uploadState: 'SUCCEEDED' });
const submission = () => ({ ...identity, state: 'PENDING_REVIEW' });

function mock(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, `Unexpected call: ${url}`);
    const response = responses.shift();
    return { ok: !response.httpError, status: response.httpError ?? 200, json: async () => response };
  };
  return { calls, fetchImpl };
}

const args = { mode: 'publish', extensionId, version: '2.0.0', zip: Buffer.from('test archive'), env, sleep: async () => {} };

test('release versions match both manifests and tags; Chrome limits are enforced', () => {
  const manifest = { manifest_version: 3, version: '2.0.0' };
  assert.equal(validateRelease(manifest, { version: '2.0.0' }, 'v2.0.0'), '2.0.0');
  for (const tag of ['v1.0.0', 'v2.0.0-beta', 'v02.0.0', 'v2.0.0;echo bad']) assert.throws(() => validateRelease(manifest, { version: '2.0.0' }, tag));
  assert.throws(() => validateRelease(manifest, { version: '1.0.0' }));
  for (const version of ['0.0.0', '65536.0.0', '01.0.0', '1.2.3.4.5']) assert.throws(() => versionParts(version));
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0.0'), 0);
});

test('missing credentials and invalid IDs stop before any network request', async () => {
  const { calls, fetchImpl } = mock([]);
  await assert.rejects(runStore({ ...args, env: {}, fetchImpl }), /Missing configuration/);
  await assert.rejects(runStore({ ...args, extensionId: 'bad/id', fetchImpl }), /Invalid extension ID/);
  assert.equal(calls.length, 0);
});

test('manual check only authenticates and reads status, without upload or publish', async () => {
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, item()]);
  const result = await runStore({ ...args, mode: 'check', zip: undefined, fetchImpl });
  assert.equal(result.result, 'CONNECTION_VERIFIED');
  assert.deepEqual(result.publishedVersions, ['1.0.1']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith(':fetchStatus'));
});

test('updates the existing item and submits for normal review after upload succeeds', async () => {
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, item(), upload(), submission()]);
  const result = await runStore({ ...args, fetchImpl });
  assert.equal(result.result, 'PENDING_REVIEW');
  assert.ok(calls[2].url.endsWith(`${name}:upload`));
  assert.equal(calls[2].options.body, args.zip);
  assert.equal(calls[2].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[3].options.body), { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
});

test('waits for async upload success before sending publish', async () => {
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, item(), { ...identity, uploadState: 'IN_PROGRESS' }, { ...identity, lastAsyncUploadState: 'IN_PROGRESS' }, { ...identity, lastAsyncUploadState: 'SUCCEEDED' }, submission()]);
  await runStore({ ...args, fetchImpl });
  assert.equal(calls.length, 6);
  assert.ok(calls[3].url.endsWith(':fetchStatus'));
  assert.ok(calls[5].url.endsWith(':publish'));
});

test('upload errors, unknown states, and wrong versions never reach publish', async () => {
  for (const payload of [{ ...identity, uploadState: 'FAILED' }, { ...identity, uploadState: 'NOT_FOUND' }, { ...upload(), crxVersion: '1.0.2' }]) {
    const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, item(), payload]);
    await assert.rejects(runStore({ ...args, fetchImpl }));
    assert.equal(calls.length, 3);
  }
});

test('async polling is bounded and timeout never publishes', async () => {
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, item(), { ...identity, uploadState: 'IN_PROGRESS' }, { ...identity, lastAsyncUploadState: 'IN_PROGRESS' }]);
  await assert.rejects(runStore({ ...args, fetchImpl, pollLimit: 1 }), /did not finish successfully/);
  assert.equal(calls.length, 4);
});

test('a different item response stops before upload', async () => {
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, { ...item(), itemId: 'another-item' }]);
  await assert.rejects(runStore({ ...args, fetchImpl }), /different or invalid item/);
  assert.equal(calls.length, 2);
});

test('rerunning an already published version performs no writes to the item', async () => {
  const current = item();
  current.publishedItemRevisionStatus.distributionChannels[0].crxVersion = '2.0.0';
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, current]);
  assert.equal((await runStore({ ...args, fetchImpl })).result, 'ALREADY_PUBLISHED');
  assert.equal(calls.length, 2);
});

test('a downgrade is rejected before uploading', async () => {
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, item()]);
  await assert.rejects(runStore({ ...args, version: '1.0.0', fetchImpl }), /older/);
  assert.equal(calls.length, 2);
});

test('rerunning the same pending version succeeds without a second submission', async () => {
  const current = item();
  current.submittedItemRevisionStatus = { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '2.0.0' }] };
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, current]);
  assert.equal((await runStore({ ...args, fetchImpl })).result, 'ALREADY_SUBMITTED');
  assert.equal(calls.length, 2);
});

test('different pending, staged, warned, and unpublished items need attention first', async () => {
  for (const overrides of [
    { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.2' }] } },
    { submittedItemRevisionStatus: { state: 'STAGED' } },
    { warned: true },
    { takenDown: true },
    { publishedItemRevisionStatus: undefined },
  ]) {
    const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, { ...item(), ...overrides }]);
    await assert.rejects(runStore({ ...args, fetchImpl }));
    assert.equal(calls.length, 2);
  }
});

test('HTTP errors do not expose raw response bodies or retry publication', async () => {
  const { calls, fetchImpl } = mock([{ access_token: 'test-access' }, item(), upload(), { httpError: 403, error: { message: env.CWS_CLIENT_SECRET } }]);
  await assert.rejects(runStore({ ...args, fetchImpl }), error => error.message.includes('HTTP 403') && !error.message.includes(env.CWS_CLIENT_SECRET));
  assert.equal(calls.length, 4);
});

test('unexpected submission status is never reported as published', async () => {
  const { fetchImpl } = mock([{ access_token: 'test-access' }, item(), upload(), { ...identity, state: 'REJECTED' }]);
  await assert.rejects(runStore({ ...args, fetchImpl }), /not confirmed/);
});
