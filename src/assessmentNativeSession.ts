import { canonicalSha256 } from './canonicalJson';
import { exactObject } from './railsControlResponse';
import { utcTime } from './evidenceConsent';
import { validWorkflowSourceBundle, type WorkflowSourceBundle, type WorkflowSourceRequest } from './assessmentWorkflowContract';

export const NATIVE_SESSION_VERSION = 'assessment-ai-session.v1';
export interface NativeSessionIdentity { sourceSessionId: string; workspaceId: string; sourceFileReference: string; createdAt: string }
export interface NativeSessionCapabilities {
	authorization_version: typeof NATIVE_SESSION_VERSION; coding_session_id: string; server_time: string;
	modes: { extension_launched: ('codex' | 'claude')[]; native_confirmed: ['codex'] };
	requires_explicit_confirmation: true; prospective_only: true;
}
export interface NativeSourceBundle extends Omit<WorkflowSourceBundle, 'intent'> {
	intent: WorkflowSourceRequest & { authorization_version: typeof NATIVE_SESSION_VERSION; connection_mode: 'native_confirmed';
		approval_action: 'approve_native_assessment_session'; identity_digest: string;
		source_identity: { source_file_reference: string; created_at: string } };
}
export function validNativeCapabilities(value: unknown, codingSessionId: string): value is NativeSessionCapabilities {
	return exactObject(value, ['authorization_version', 'coding_session_id', 'server_time', 'modes', 'requires_explicit_confirmation', 'prospective_only'])
		&& value.authorization_version === NATIVE_SESSION_VERSION && value.coding_session_id === codingSessionId && utcTime(value.server_time)
		&& value.requires_explicit_confirmation === true && value.prospective_only === true
		&& exactObject(value.modes, ['extension_launched', 'native_confirmed'])
		&& Array.isArray(value.modes.extension_launched) && canonicalSha256([...value.modes.extension_launched].sort()) === canonicalSha256(['claude', 'codex'])
		&& Array.isArray(value.modes.native_confirmed) && canonicalSha256(value.modes.native_confirmed) === canonicalSha256(['codex']);
}
export function nativeIdentityDigest(codingSessionId: string, bundle: NativeSourceBundle): string {
	const intent = bundle.intent;
	return canonicalSha256({ coding_session_id: codingSessionId, local_recording_session_id: bundle.disclosure.local_recording_session_id,
		source: intent.source, source_session_id: intent.source_session_id, workspace_id: intent.workspace_id, source_identity: intent.source_identity });
}
export function validNativeSourceBundle(value: unknown): value is NativeSourceBundle {
	if (!exactObject(value, ['intent', 'disclosure', 'processing']) || !exactObject(value.intent,
		['workflow_consent_id', 'request_id', 'workspace_id', 'source', 'source_session_id', 'authorization_version', 'connection_mode', 'approval_action', 'identity_digest', 'source_identity'])) { return false; }
	const { authorization_version, connection_mode, approval_action, identity_digest, source_identity, ...intent } = value.intent;
	return authorization_version === NATIVE_SESSION_VERSION && connection_mode === 'native_confirmed' && approval_action === 'approve_native_assessment_session'
		&& intent.source === 'codex' && typeof identity_digest === 'string' && /^[a-f0-9]{64}$/.test(identity_digest)
		&& exactObject(source_identity, ['source_file_reference', 'created_at']) && typeof source_identity.source_file_reference === 'string'
		&& /^codex-file:[a-f0-9]{64}$/.test(source_identity.source_file_reference) && utcTime(source_identity.created_at)
		&& validWorkflowSourceBundle({ ...value, intent });
}
