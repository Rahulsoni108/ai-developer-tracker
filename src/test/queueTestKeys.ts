import type { Uri } from 'vscode';
import { LocalEventQueue, type QueueOptions } from '../localEventQueue';
import { AsyncLocalEventQueue } from '../asyncLocalEventQueue';
import { supplyEvidenceKeys, type EvidenceSecretStorage } from '../evidenceKeyStorage';
export { EVIDENCE_KEY_SECRET } from '../evidenceKeyStorage';

// Test-only SecretStorage double. Keys are generated at runtime and never written to fixture files.
const values = new Map<string, string>();
export const testSecrets: EvidenceSecretStorage = {
	get: async name => values.get(name), store: async (name, value) => { values.set(name, value); }
};
type StorageUri = Pick<Uri, 'scheme' | 'fsPath'>;
export function openTestQueue(storage: StorageUri, folders: readonly { uri: StorageUri }[], options: QueueOptions = {}) {
	return LocalEventQueue.open(storage, folders, { ...options, keyProvider: requirements => supplyEvidenceKeys(testSecrets, requirements) });
}
export function openTestWorkerQueue(storage: StorageUri, folders: readonly { uri: StorageUri }[], options: Pick<QueueOptions, 'maxStorageBytes'> = {}) {
	return AsyncLocalEventQueue.open(storage, folders, options, testSecrets);
}
