import type { FinalizationScope } from './assessmentFinalization';
import type { AssessmentApprovalBinding } from './assessmentEventApproval';
import type { UploadPrivacyContext } from './uploadPrivacyContext';
import type { EvidenceConsentState } from './evidenceConsent';
import type { TrackerEvent } from './eventSchema';
import type { UploadPauseReason } from './uploadState';
import { parentPort, workerData } from 'node:worker_threads';
import { LocalEventQueue, safeQueueError, type QueueHealth, type CleanupScope, type CleanupResult } from './localEventQueue';
import { LocalDiagnosticFiles } from './localDiagnosticFiles';
import type { KeySupplyReply, QueueReply, QueueRequest } from './asyncLocalEventQueue';
import type { PrivacyReasonCode } from './privacyFilter';
import { EvidenceEncryptionError, type EncryptionKeys, type EncryptionRequirements } from './evidenceEncryption';

/** Private storage thread. Its messages never include filesystem/SQLite error details. */
async function run(): Promise<void> {
	const port = parentPort;
	if (!port) { return; }
	let queue: LocalEventQueue;
	let health: QueueHealth;
	const keyProvider = (requirements: EncryptionRequirements) => new Promise<EncryptionKeys>((resolve, reject) => {
		const timeout = setTimeout(() => { port.off('message', supplied); reject(new EvidenceEncryptionError('key_storage_unavailable')); }, 15000);
		const supplied = (reply: KeySupplyReply) => {
			if (reply.type !== 'keys_supplied' && reply.type !== 'keys_failed') { return; }
			clearTimeout(timeout); port.off('message', supplied);
			if (reply.type === 'keys_supplied') {
				// SecretStorage can await while another worker starts; use fresh host ownership information.
				options.liveOwnerIds = reply.liveOwnerIds; resolve(reply.keys);
			}
			else { reject(new EvidenceEncryptionError(['key_missing', 'key_invalid'].includes(reply.code) ? reply.code as 'key_missing' | 'key_invalid' : 'key_storage_unavailable')); }
		};
		port.on('message', supplied); port.postMessage({ type: 'keys_required', requirements } satisfies QueueReply);
	});
	const options = { ...workerData.options, keyProvider };
	try { queue = await LocalEventQueue.open(workerData.storage, workerData.folders, options); health = await queue.getHealth(); }
	catch (error) { port.postMessage({ type: 'failed', code: safeQueueError(error).code } satisfies QueueReply); port.close(); return; }
	const files = workerData.diagnosticDirectories ? new LocalDiagnosticFiles(workerData.diagnosticDirectories, workerData.folders) : undefined;
	const removeFiles = async (databaseResult: CleanupResult, mode: 'legacy' | 'all' | 'expired', cutoff?: string) => {
		await queue.assertMaintenanceHeld();
		let deletedFiles = 0; let filesFailed = false; let storageFailed = false;
		try { deletedFiles = await files?.remove(mode, cutoff) ?? 0; }
		catch { filesFailed = true; } // Some unlink operations may already have completed.
		if (databaseResult.deletedRecords > 0 || databaseResult.deletedSessions > 0) { try { await queue.compactMaintenance(); } catch { storageFailed = true; } }
		return { ...databaseResult, deletedFiles, filesFailed, storageFailed };
	};
	let pending = Promise.resolve();
	let lastHealth = health;
	let lastUpdate = Date.now();
	let warned = health.status !== 'healthy';
	let fullReported = health.status === 'full';
	const notifyHealth = async () => {
		const current = await queue.getHealth();
		if (current.status === 'warning' && !warned || current.status === 'full' && !fullReported || Date.now() - lastUpdate >= 1000) {
			warned ||= current.status !== 'healthy'; fullReported ||= current.status === 'full';
			lastHealth = current; lastUpdate = Date.now();
			port.postMessage({ type: 'health', health: lastHealth } satisfies QueueReply);
		}
	};
	port.on('message', (request: QueueRequest) => {
		pending = pending.then(async () => {
			try {
				let value: unknown;
				switch (request.operation) {
					case 'freezeFinalization': { const args = request.argument as { scope: FinalizationScope; existingOnly: boolean };
						value = await queue.freezeFinalization(args.scope, args.existingOnly); break; }
					case 'getUploadRetryState': value = await queue.getUploadRetryState(); break;
					case 'configureUpload': await queue.configureUpload(request.argument as string); break;
					case 'claimUploadAttempt': {
						const args = request.argument as { endpointHash: string; now: number; recoveryAt: number };
						value = await queue.claimUploadAttempt(args.endpointHash, args.now, args.recoveryAt); break;
					}
					case 'finishUploadAttempt': {
						const args = request.argument as { nextAttemptAt: number; pauseReason: UploadPauseReason | null; resetAttempts: boolean };
						await queue.finishUploadAttempt(args.nextAttemptAt, args.pauseReason, args.resetAttempts); break;
					}
					case 'prepareBatch': {
						const args = request.argument as { maxEvents: number; maxBytes: number; localSessionId?: string };
						value = await queue.prepareBatch(args.maxEvents, args.maxBytes, args.localSessionId); break;
					}
					case 'markDelivered': {
						const args = request.argument as { batchId: string; acknowledgedEventIds: string[] };
						await queue.markDelivered(args.batchId, args.acknowledgedEventIds); break;
					}
					case 'releaseBatch': await queue.releaseBatch(request.argument as string); break;
					case 'getDeliveryStatus': value = await queue.getDeliveryStatus(); break;
					case 'enqueueApproved': {
						const args = request.argument as { event: unknown; context: UploadPrivacyContext };
						await queue.enqueueApproved(args.event, args.context); break;
					}
					case 'getAssessmentUploadContext': {
						const args = request.argument as { event: TrackerEvent; binding: AssessmentApprovalBinding };
						value = await queue.getAssessmentUploadContext(args.event, args.binding); break;
					}
					case 'getUploadPrivacyContext': value = await queue.getUploadPrivacyContext(request.argument as TrackerEvent); break;
					case 'revokeEvidenceApprovals': await queue.revokeEvidenceApprovals(request.argument as string); break;
					case 'getEvidenceConsent': value = await queue.getEvidenceConsent(request.argument as string); break;
					case 'setEvidenceConsent': await queue.setEvidenceConsent(request.argument as EvidenceConsentState); break;
					case 'enqueue': await queue.enqueue(request.argument); break;
					case 'getPending': value = await queue.getPending(request.argument as number); break;
					case 'markAcknowledged': await queue.markAcknowledged(request.argument as string[]); break;
					case 'getRecordedEventSummary': value = await queue.getRecordedEventSummary(); break;
					case 'getSessionEvidenceStatus': value = await queue.getSessionEvidenceStatus(request.argument as string[]); break;
					case 'getPendingCount': value = await queue.getPendingCount(); break;
					case 'getHealth': value = await queue.getHealth(); break;
					case 'beginSession': await queue.beginSession(request.argument as string); break;
					case 'finishSession': {
						const argument = request.argument as { sessionId: string; status: 'completed' | 'cancelled' };
						await queue.finishSession(argument.sessionId, argument.status); break;
					}
					case 'getRecordingSessions': value = await queue.getRecordingSessions(request.argument as number); break;
					case 'recordPrivacyRejection': {
						const argument = request.argument as { sessionId: string; reasons: PrivacyReasonCode[] };
						await queue.recordPrivacyRejection(argument.sessionId, argument.reasons); break;
					}
					case 'getPrivacyHealth': value = await queue.getPrivacyHealth(request.argument as string); break;
					case 'getLocalDataSummary': value = { ...await queue.getLocalDataSummary(), ...await files?.summary() ?? { legacyLogCount: 0, diagnosticFileCount: 0 } }; break;
					case 'acquireMaintenance': await queue.acquireMaintenance(); break;
					case 'releaseMaintenance': await queue.releaseMaintenance(); break;
					case 'deleteEvidence': value = await removeFiles(await queue.deleteEvidence(request.argument as CleanupScope), request.argument as CleanupScope); break;
					case 'expireAcknowledged': value = await removeFiles(await queue.expireAcknowledged(request.argument as string), 'expired', request.argument as string); break;
					case 'close': await queue.close(); break;
					default: throw new Error('Unsupported queue operation.');
				}
				port.postMessage({ type: 'result', id: request.id, ok: true, value } satisfies QueueReply);
			} catch (error) { port.postMessage({ type: 'result', id: request.id, ok: false, code: safeQueueError(error).code } satisfies QueueReply); }
			finally { if (request.operation === 'close') { port.close(); } }
			if (request.operation !== 'close' && request.operation !== 'getRecordedEventSummary' && request.operation !== 'getSessionEvidenceStatus') {
				try { await notifyHealth(); } catch (error) { port.postMessage({ type: 'failed', code: safeQueueError(error).code } satisfies QueueReply); }
			}
		});
	});
	port.postMessage({ type: 'ready', health } satisfies QueueReply);
}
void run();
