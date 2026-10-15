import { randomBytes, randomUUID } from 'node:crypto';
import type { SecretStorage } from 'vscode';
import { isUuid } from './eventSchema';
import { EvidenceEncryptionError, type EncryptionKeys, type EncryptionRequirements } from './evidenceEncryption';

export const EVIDENCE_KEY_SECRET = 'ai-developer-tracker.evidence-keyring.v1';
export type EvidenceSecretStorage = Pick<SecretStorage, 'get' | 'store'>;
interface StoredKeyring { version: 1; activeKeyId: string; keys: { keyId: string; key: string }[] }
let provisioning: Promise<void> = Promise.resolve();
function parse(value: string): StoredKeyring {
	try {
		if (Buffer.byteLength(value) > 16384) { throw new Error(); }
		const ring = JSON.parse(value) as StoredKeyring;
		if (!ring || Object.keys(ring).some(key => !['version', 'activeKeyId', 'keys'].includes(key)) || ring.version !== 1 || !isUuid(ring.activeKeyId)
			|| !Array.isArray(ring.keys) || !ring.keys.length || ring.keys.length > 32) { throw new Error(); }
		const ids = new Set<string>();
		for (const entry of ring.keys) {
			if (!entry || Object.keys(entry).length !== 2 || !isUuid(entry.keyId) || ids.has(entry.keyId) || typeof entry.key !== 'string'
				|| !/^[A-Za-z0-9+/]{43}=$/.test(entry.key)) { throw new Error(); }
			const bytes = Buffer.from(entry.key, 'base64');
			try { if (bytes.length !== 32 || bytes.toString('base64') !== entry.key) { throw new Error(); } } finally { bytes.fill(0); }
			ids.add(entry.keyId);
		}
		if (!ids.has(ring.activeKeyId)) { throw new Error(); }
		return ring;
	} catch { throw new EvidenceEncryptionError('key_invalid'); }
}

/** SecretStorage stays on the host; only transferable key bytes cross the private worker channel. */
export function supplyEvidenceKeys(secrets: EvidenceSecretStorage | undefined, requirements: EncryptionRequirements): Promise<EncryptionKeys> {
	const supplying = provisioning.then(async () => {
		try {
			if (!secrets || requirements.keyIds.length > 32 || requirements.keyIds.some(id => !isUuid(id))) { throw new EvidenceEncryptionError('key_storage_unavailable'); }
			let stored = await secrets.get(EVIDENCE_KEY_SECRET);
			if (stored === undefined) {
				if (requirements.keyIds.length) { throw new EvidenceEncryptionError('key_missing'); }
				const bytes = randomBytes(32); const id = randomUUID();
				try { stored = JSON.stringify({ version: 1, activeKeyId: id, keys: [{ keyId: id, key: bytes.toString('base64') }] } satisfies StoredKeyring); }
				finally { bytes.fill(0); }
				await secrets.store(EVIDENCE_KEY_SECRET, stored);
				// Do not enable encryption until storage persistence/readback succeeds.
				if (await secrets.get(EVIDENCE_KEY_SECRET) !== stored) { throw new EvidenceEncryptionError('key_storage_unavailable'); }
			}
			const ring = parse(stored);
			if (requirements.keyIds.some(id => !ring.keys.some(key => key.keyId === id))) { throw new EvidenceEncryptionError('key_missing'); }
			return { activeKeyId: ring.activeKeyId, keys: ring.keys.map(entry => {
				const bytes = Buffer.from(entry.key, 'base64'); const transfer = new ArrayBuffer(32);
				new Uint8Array(transfer).set(bytes); bytes.fill(0);
				return { keyId: entry.keyId, bytes: transfer };
			}) };
		} catch (error) { throw error instanceof EvidenceEncryptionError ? error : new EvidenceEncryptionError('key_storage_unavailable'); }
	});
	provisioning = supplying.then(() => {}, () => {});
	return supplying;
}
