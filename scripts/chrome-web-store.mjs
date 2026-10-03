import { appendFile, readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compareVersions, versionParts } from './validate-release.mjs';

const ORIGIN = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SUCCESS_STATES = new Set(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

function authenticationBody(env) {
  if (!env.CWS_SERVICE_ACCOUNT_KEY?.trim()) {
    return new URLSearchParams({ client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET, refresh_token: env.CWS_REFRESH_TOKEN, grant_type: 'refresh_token' });
  }

  // Use only the key and identity from the JSON; never follow its endpoint URLs.
  // Keep parse/crypto errors private because they can contain credential values.
  try {
    const account = JSON.parse(env.CWS_SERVICE_ACCOUNT_KEY);
    if (account?.type !== 'service_account' || typeof account.client_email !== 'string'
      || !/^[a-zA-Z0-9-]+@[a-zA-Z0-9-]+\.iam\.gserviceaccount\.com$/.test(account.client_email)
      || typeof account.private_key !== 'string' || typeof account.private_key_id !== 'string'
      || !/^[a-zA-Z0-9_-]+$/.test(account.private_key_id)) throw new Error();
    const key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== 'rsa') throw new Error();
    const issued = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: account.private_key_id });
    const claims = encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/chromewebstore', aud: TOKEN_URL, iat: issued, exp: issued + 3600 });
    const unsigned = `${header}.${claims}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    return new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
  } catch {
    throw new Error('Invalid CWS_SERVICE_ACCOUNT_KEY. Use the complete service account JSON key from Google Cloud.');
  }
}

function validateItem(data, name, extensionId) {
  if (data?.name !== name || data?.itemId !== extensionId) throw new Error('Chrome Web Store returned a different or invalid item.');
  return data;
}

export async function runStore({ mode, extensionId, version, zip, env = process.env, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollLimit = 30 }) {
  if (!['check', 'publish'].includes(mode)) throw new Error('Choose --check or --publish explicitly.');
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid extension ID.');
  versionParts(version);
  const required = env.CWS_SERVICE_ACCOUNT_KEY?.trim()
    ? ['CWS_PUBLISHER_ID']
    : ['CWS_PUBLISHER_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}. CWS_SERVICE_ACCOUNT_KEY can replace the three OAuth credentials. See docs/releasing.md.`);
  if (!/^[a-zA-Z0-9_-]+$/.test(env.CWS_PUBLISHER_ID)) throw new Error('Invalid publisher ID.');
  const name = `publishers/${env.CWS_PUBLISHER_ID}/items/${extensionId}`;

  async function jsonRequest(url, options, label) {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch { throw new Error(`${label}: network request failed or timed out. No automatic mutation retry was made.`); }
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}. Check the API credentials and the Web Store dashboard.`);
    try { return await response.json(); }
    catch { throw new Error(`${label}: invalid JSON response.`); }
  }

  const auth = await jsonRequest(TOKEN_URL, {
    method: 'POST', body: authenticationBody(env),
  }, 'Authentication');
  if (typeof auth.access_token !== 'string' || !auth.access_token) throw new Error('Authentication did not return an access token.');
  const headers = { Authorization: `Bearer ${auth.access_token}` };
  const fetchItem = async () => validateItem(await jsonRequest(`${ORIGIN}/v2/${name}:fetchStatus`, { headers }, 'Fetch status'), name, extensionId);
  const current = await fetchItem();
  const published = current.publishedItemRevisionStatus;
  const submitted = current.submittedItemRevisionStatus;
  const publishedVersions = published?.distributionChannels?.map(channel => channel.crxVersion) ?? [];

  if (mode === 'check') return { result: 'CONNECTION_VERIFIED', extensionId, publishedVersions, publishedState: published?.state ?? null, submissionState: submitted?.state ?? null, takenDown: current.takenDown ?? false, warned: current.warned ?? false };
  if (!zip?.length) throw new Error('Extension ZIP is empty or missing.');
  if (current.takenDown || current.warned) throw new Error('The item needs attention in the Web Store dashboard before publishing.');
  // The API omits this revision for an existing, currently unpublished item.
  // Its publisher and item ID have already been verified by fetchItem().
  if (published != null && !publishedVersions.length) throw new Error('Could not verify the version of the existing published revision.');
  for (const previous of publishedVersions) {
    if (compareVersions(version, previous) < 0) throw new Error('The release version is older than a published version.');
  }
  if (publishedVersions.some(previous => compareVersions(version, previous) === 0)) return { result: 'ALREADY_PUBLISHED', extensionId, version };
  if (submitted?.state === 'PENDING_REVIEW') {
    const versions = submitted.distributionChannels?.map(channel => channel.crxVersion) ?? [];
    if (versions.length && versions.every(previous => compareVersions(version, previous) === 0)) return { result: 'ALREADY_SUBMITTED', extensionId, version };
    throw new Error('Another submission is under review. Finish or cancel it in the dashboard first.');
  }
  if (submitted?.state === 'STAGED') throw new Error('An approved staged submission already exists. Resolve it in the dashboard first.');

  const uploaded = validateItem(await jsonRequest(`${ORIGIN}/upload/v2/${name}:upload`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip', 'X-Goog-Upload-Protocol': 'raw' }, body: zip,
  }, 'Upload'), name, extensionId);
  if (uploaded.crxVersion && uploaded.crxVersion !== version) throw new Error('The uploaded version does not match the release version.');
  let uploadState = uploaded.uploadState;
  for (let attempt = 0; ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(uploadState) && attempt < pollLimit; attempt++) {
    await sleep(2_000);
    uploadState = (await fetchItem()).lastAsyncUploadState;
  }
  if (!['SUCCEEDED', 'UPLOAD_SUCCEEDED'].includes(uploadState)) throw new Error('Upload did not finish successfully. Check the dashboard before retrying.');

  const submission = validateItem(await jsonRequest(`${ORIGIN}/v2/${name}:publish`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
  }, 'Submit for review'), name, extensionId);
  if (!SUCCESS_STATES.has(submission.state)) throw new Error('Submission was not confirmed. Check its state in the Web Store dashboard.');
  return { result: submission.state, extensionId, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argument = process.argv[2];
    if (!['--check', '--publish'].includes(argument) || process.argv.length !== 3) throw new Error('Usage: node scripts/chrome-web-store.mjs --check|--publish');
    const root = new URL('../', import.meta.url);
    const config = JSON.parse(await readFile(new URL('.github/chrome-web-store.json', root), 'utf8'));
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    const result = await runStore({ mode: argument.slice(2), extensionId: config.extensionId, version: manifest.version, zip: argument === '--publish' ? await readFile(new URL('dist/openai-status-reader.zip', root)) : undefined });
    // Only known result fields are logged. Credentials and raw API responses stay out of logs.
    const summary = JSON.stringify(result, null, 2);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Chrome Web Store\n\n\`\`\`json\n${summary}\n\`\`\`\n\nPENDING_REVIEW means submitted, not yet published.\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
