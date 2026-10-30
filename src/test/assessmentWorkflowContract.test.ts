import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RailsWorkflowConsentClient } from '../railsWorkflowConsentClient';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../canonicalJson';
import { type AssessmentProcessorPolicy } from '../processorPolicy';
import { validWorkflowPolicy, validWorkflowStartRequest, validWorkflowSourceRequest, workflowIntentDigest, workflowConsentNotice,
	WORKFLOW_CONSENT_VERSION, validWorkflowStartBundle, type WorkflowPolicy, type WorkflowStartRequest } from '../assessmentWorkflowContract';

function policy(): WorkflowPolicy {
	const body = { version: 'assessment-processor-policy.v1' as const, available: true as const, purpose: 'assessment_performance_evaluation' as const,
		consent_version: 'assessment-ai-processing.v2' as const, retention_policy_version: 'assessment-report-retention.v1' as const,
		processor: { id: 'synthetic', name: 'Synthetic Processor', description: 'Synthetic only', external: true as const },
		processor_scope: { backend: 'direct' as const, provider: 'openai_compatible' as const, model: 'synthetic-model', origin: 'https://synthetic.invalid', configuration_digest: 'a'.repeat(64) },
		categories: ['ai_interactions', 'code_changes', 'tool_activity'], evaluation_enabled: true,
		terms: { provider_data_policy: 'operator_approved_no_training' as const, withdrawal: 'blocks_undispatched_requests' as const,
			reports_after_withdrawal: 'retain_until_expiry' as const, report_retention_days: 30, prepared_input_persistence: 'none' as const, prospective_only: true as const } };
	const processor: AssessmentProcessorPolicy = { ...body, policy_digest: canonicalSha256(body), coding_session_id: '42', server_time: '2030-01-01T10:00:00.000Z' };
	return { consent_version: WORKFLOW_CONSENT_VERSION, source_mode: 'extension_launched_only', providers: ['claude', 'codex'], processor_policy: processor };
}
function request(): WorkflowStartRequest {
	return { request_id: randomUUID(), local_recording_session_id: randomUUID(), consent_version: WORKFLOW_CONSENT_VERSION,
		approval_action: 'approve_assessment_workflow', approved_workspace_ids: ['b'.repeat(64), 'a'.repeat(64)],
		providers: ['claude', 'codex'], processing_policy_digest: policy().processor_policy.policy_digest };
}
suite('Assessment workflow contract foundation', () => {
 test('accepts the exact authenticated Rails explicit-purpose fixture without field or receipt invention', async () => {
  const fixture = JSON.parse(await readFile(join(__dirname, '../../src/test/fixtures/rails-workflow-consent.v1.json'), 'utf8'));
  const start = fixture.start.data; const auth = { connection: { mode: 'rails' as const, codingSessionId: start.coding_session_id,
   apiOrigin: start.upload.receipt.destination_origin, uploadEndpoint: start.upload.receipt.destination_origin + '/api/v2/coding_session/extension/events',
   credentialExpiresAt: start.upload.receipt.expires_at }, credential: 'adt_ext_' + 'x'.repeat(43) };
  const client = new RailsWorkflowConsentClient({ send: async request => ({ status: 200, headers: {}, contentType: 'application/json',
   body: JSON.stringify(request.endpoint.pathname.endsWith('/policy') ? fixture.policy : fixture.start) }) });
  assert.ok(validWorkflowStartBundle(start.request));
  assert.ok(validWorkflowPolicy(await client.policy(auth, AbortSignal.timeout(1000)), auth.connection.codingSessionId));
  const result = await client.start(auth, start.request, AbortSignal.timeout(1000));
  assert.equal(result.state, 'active'); assert.equal(result.confirmations.length, 1);
  assert.equal(result.disclosure.request.upload_consent_id, result.upload.receipt!.consent_id);
 });
	test('requires the exact advertised capability and authenticated assessment policy', () => {
		assert.ok(validWorkflowPolicy(policy(), '42'));
		for (const invalid of [undefined, {}, { ...policy(), consent_version: 'assessment-workflow.v2' },
			{ ...policy(), source_mode: 'all_local_chats' }, { ...policy(), providers: ['unknown'] },
			{ ...policy(), providers: ['codex', 'codex'] }, { ...policy(), processor_policy: { available: false } },
			{ ...policy(), extra: true }]) { assert.equal(validWorkflowPolicy(invalid, '42'), false); }
		assert.equal(validWorkflowPolicy(policy(), '43'), false);
	});
	test('rejects unavailable, disabled, stale or tampered processor policies', () => {
		const disabled = policy(); disabled.processor_policy.evaluation_enabled = false;
		assert.equal(validWorkflowPolicy(disabled, '42'), false);
		const tampered = policy(); tampered.processor_policy.processor_scope.model = 'other';
		assert.equal(validWorkflowPolicy(tampered, '42'), false);
	});
	test('start intent has no ownership, timestamp or blanket privacy bypass fields', () => {
		const good = request(); assert.ok(validWorkflowStartRequest(good));
		for (const change of [{ candidate_id: 1 }, { coding_session_id: '42' }, { consented_at: '2030-01-01' },
			{ privacyApproved: true }, { approval_action: 'approve_upload' }, { providers: [] },
			{ providers: ['codex', 'codex'] }, { providers: ['other'] }, { approved_workspace_ids: [] },
			{ approved_workspace_ids: ['../private'] }, { approved_workspace_ids: ['a'.repeat(64), 'a'.repeat(64)] },
			{ processing_policy_digest: 'invalid' }, { request_id: 'invalid' }]) {
			assert.equal(validWorkflowStartRequest({ ...good, ...change }), false);
		}
	});
	test('source enrollment accepts only explicit, bounded identities, never wildcard/history scopes', () => {
		const good = { workflow_consent_id: randomUUID(), request_id: randomUUID(), workspace_id: 'a'.repeat(64), source: 'codex', source_session_id: randomUUID() };
		assert.ok(validWorkflowSourceRequest(good));
		for (const change of [{ source_session_id: '*' }, { source: 'other' }, { workspace_id: '../private' },
			{ session_id: '42' }, { captured_before: true }, { source_session_id: 'old-chat-name' }]) {
			assert.equal(validWorkflowSourceRequest({ ...good, ...change }), false);
		}
	});
	test('canonical intent binds assessment, HTTPS destination, recording, policy and exact scope', () => {
		const good = request(); const before = structuredClone(good);
		const digest = workflowIntentDigest('42', 'https://assessment.invalid', good);
		assert.equal(digest, workflowIntentDigest('42', 'https://assessment.invalid', { ...good, providers: [...good.providers].reverse(), approved_workspace_ids: [...good.approved_workspace_ids].reverse() }));
		assert.notEqual(digest, workflowIntentDigest('43', 'https://assessment.invalid', good));
		assert.notEqual(digest, workflowIntentDigest('42', 'https://other.invalid', good));
		for (const change of [{ local_recording_session_id: randomUUID() }, { providers: ['codex'] as const }, { processing_policy_digest: 'f'.repeat(64) }]) {
			assert.notEqual(digest, workflowIntentDigest('42', 'https://assessment.invalid', { ...good, ...change, providers: [...(change.providers ?? good.providers)] }));
		}
		assert.deepEqual(good, before);
		for (const origin of ['http://assessment.invalid', 'https://user:password@assessment.invalid', 'https://assessment.invalid/path', 'https://assessment.invalid?token=value']) {
			assert.throws(() => workflowIntentDigest('42', origin, good), /Invalid workflow destination/);
		}
	});
	test('one notice explicitly identifies separate purposes, provider and prospective limitations', () => {
		const notice = workflowConsentNotice(policy(), '42', 'assessment.invalid', 2);
		for (const term of ['record', 'upload', 'recruiters', 'Synthetic Processor', 'synthetic-model', '30 days', 'separate permissions',
			'prospectively', 'previous conversation history', 'Native chats', 'Cancel', 'withdrawal', 'encrypted']) { assert.ok(notice.includes(term), term); }
		assert.throws(() => workflowConsentNotice(policy(), '43', 'assessment.invalid', 2));
		assert.throws(() => workflowConsentNotice(policy(), '42', 'https://user:password@invalid', 2));
	});
});
