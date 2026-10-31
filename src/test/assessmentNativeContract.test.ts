import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RailsWorkflowConsentClient } from '../railsWorkflowConsentClient';
import { nativeIdentityDigest, validNativeSourceBundle, type NativeSourceBundle } from '../assessmentNativeSession';

suite('Native assessment Rails interoperability', () => {
 async function fixture() { return JSON.parse(await readFile(join(__dirname, '../../src/test/fixtures/rails-native-session.v1.json'), 'utf8')); }
 function auth(value: Awaited<ReturnType<typeof fixture>>) {
  const scope = value.data.authorization;
  return { connection: { mode: 'rails' as const, codingSessionId: scope.coding_session_id,
   apiOrigin: scope.upload.receipt.destination_origin, uploadEndpoint: scope.upload.receipt.destination_origin + '/api/v2/coding_session/extension/events',
   credentialExpiresAt: scope.upload.receipt.expires_at }, credential: 'adt_ext_' + 'x'.repeat(43) };
 }
 test('accepts the exact Ruby response, identity digest and read-only native lookup', async () => {
  const value = await fixture(); const bundle = value.data.authorization.request as NativeSourceBundle;
  assert.equal(validNativeSourceBundle(bundle), true);
  assert.equal(nativeIdentityDigest(auth(value).connection.codingSessionId, bundle), bundle.intent.identity_digest);
  const paths: string[] = [];
  const client = new RailsWorkflowConsentClient({ send: async request => {
   paths.push(request.endpoint.pathname);
   if (paths.length === 2) { assert.deepEqual(JSON.parse(request.body), { workflow_consent_id: bundle.intent.workflow_consent_id, request_id: bundle.intent.request_id }); }
   return { status: 200, headers: {}, contentType: 'application/json', body: JSON.stringify(value) };
  } });
  const result = await client.enrollNative(auth(value), bundle, AbortSignal.timeout(1000));
  assert.equal(result.state, 'active'); assert.equal(result.disclosure.request.approved_source_sessions[0].source_session_id, bundle.intent.source_session_id);
  assert.deepEqual(await client.recoverNative(auth(value), bundle, AbortSignal.timeout(1000)), result);
  assert.ok(paths[1].endsWith('/native_sources/status'));
 });
 test('fails closed on a changed identity, consent, mode, version or scope', async () => {
  for (const field of ['digest', 'mode', 'version', 'receipt', 'workspace']) {
   const value = await fixture(); const original = structuredClone(value.data.authorization.request);
   if (field === 'digest') { value.data.identity_digest = 'a'.repeat(64); }
   if (field === 'mode') { value.data.connection_mode = 'extension_launched'; }
   if (field === 'version') { value.data.authorization_version = 'assessment-ai-session.v2'; }
   if (field === 'receipt') { value.data.authorization.disclosure.receipt.upload_consent_id = '00000000-0000-4000-8000-000000000000'; }
   if (field === 'workspace') { value.data.authorization.disclosure.receipt.approved_workspace_ids = ['f'.repeat(64)]; }
   const client = new RailsWorkflowConsentClient({ send: async () => ({ status: 200, headers: {}, contentType: 'application/json', body: JSON.stringify(value) }) });
   await assert.rejects(client.enrollNative(auth(value), original, AbortSignal.timeout(1000)));
  }
 });
 test('never contacts Rails for malformed, wrong-assessment or changed native identity requests', async () => {
  const value = await fixture(); const bundle = value.data.authorization.request;
  const client = new RailsWorkflowConsentClient({ send: async () => { assert.fail('Invalid request must not leave the extension'); } });
  await assert.rejects(client.enrollNative({ ...auth(value), connection: { ...auth(value).connection, codingSessionId: '999999' } }, bundle, AbortSignal.timeout(1000)));
  bundle.intent.source_identity.source_file_reference = 'codex-file:' + 'e'.repeat(64);
  await assert.rejects(client.enrollNative(auth(value), bundle, AbortSignal.timeout(1000)));
 });
});
