import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { isUuid } from './eventSchema';

export type EncryptionFailureCode = 'key_storage_unavailable' | 'key_missing' | 'key_invalid' | 'authentication_failed';
export class EvidenceEncryptionError extends Error {
	constructor(readonly code: EncryptionFailureCode) { super('Local evidence encryption failed.'); this.name = 'EvidenceEncryptionError'; }
}
export interface EncryptionRequirements { keyIds: readonly string[] }
/** Transferred once to the worker; buffers are consumed and wiped when constructing KeyObjects. */
export interface EncryptionKeys { activeKeyId: string; keys: { keyId: string; bytes: ArrayBuffer }[] }
export interface EncryptedEvidence {
	encryptionVersion: 1;
	algorithm: 'AES-256-GCM';
	keyId: string;
	nonce: string;
	tag: string;
	ciphertext: string;
}
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
function decode(value: unknown, size?: number): Buffer {
	if (typeof value !== 'string' || value.length > Math.ceil(MAX_PLAINTEXT_BYTES / 3) * 4
		|| size !== undefined && value.length !== Math.ceil(size / 3) * 4
		|| value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) { throw new EvidenceEncryptionError('authentication_failed'); }
	const bytes = Buffer.from(value, 'base64');
	if (bytes.toString('base64') !== value || size !== undefined && bytes.length !== size) { throw new EvidenceEncryptionError('authentication_failed'); }
	return bytes;
}

/** Used only on the storage worker in production. No plaintext in error messages/causes. */
export class EvidenceCipher {
	private readonly keys = new Map<string, KeyObject>();
	readonly activeKeyId: string;
	constructor(material: EncryptionKeys) {
		try {
			if (!isUuid(material.activeKeyId) || !Array.isArray(material.keys) || material.keys.length < 1 || material.keys.length > 32) { throw new Error(); }
			this.activeKeyId = material.activeKeyId;
			for (const entry of material.keys) {
				if (!isUuid(entry.keyId) || this.keys.has(entry.keyId) || !(entry.bytes instanceof ArrayBuffer) || entry.bytes.byteLength !== 32) { throw new Error(); }
				this.keys.set(entry.keyId, createSecretKey(new Uint8Array(entry.bytes)));
			}
			if (!this.keys.has(this.activeKeyId)) { throw new Error(); }
		} catch { this.keys.clear(); throw new EvidenceEncryptionError('key_invalid'); }
		finally { for (const entry of Array.isArray(material?.keys) ? material.keys : []) { if (entry?.bytes instanceof ArrayBuffer) { new Uint8Array(entry.bytes).fill(0); } } }
	}
	hasKey(keyId: string): boolean { return this.keys.has(keyId); }
	private aad(eventId: string, keyId: string, domain: 'event' | 'approval' | 'consent' | 'revocation' | 'finalization' | 'archive' | 'disclosure'): Buffer {
		if (!isUuid(eventId)) { throw new EvidenceEncryptionError('authentication_failed'); }
		// Domain separation and immutable indexing/format metadata. Mutable ack/sequence are not event payloads.
		return Buffer.from(JSON.stringify([`ai-developer-tracker.sqlite-${domain}`, 1, 'AES-256-GCM', keyId, eventId]));
	}
	encrypt(eventId: string, plaintext: string, domain: 'event' | 'approval' | 'consent' | 'revocation' | 'finalization' | 'archive' | 'disclosure' = 'event'): EncryptedEvidence {
		const bytes = Buffer.from(plaintext, 'utf8');
		try {
			if (bytes.length > MAX_PLAINTEXT_BYTES) { throw new Error(); }
			const nonce = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, nonce, { authTagLength: 16 });
			cipher.setAAD(this.aad(eventId, this.activeKeyId, domain));
			const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
			return { encryptionVersion: 1, algorithm: 'AES-256-GCM', keyId: this.activeKeyId,
				nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
		} catch { throw new EvidenceEncryptionError('authentication_failed'); }
		finally { bytes.fill(0); }
	}
	decrypt(eventId: string, value: unknown, domain: 'event' | 'approval' | 'consent' | 'revocation' | 'finalization' | 'archive' | 'disclosure' = 'event'): unknown {
		let plaintext: Buffer | undefined;
		try {
			if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(); }
			const envelope = value as EncryptedEvidence;
			if (Object.keys(envelope).length !== 6 || Object.keys(envelope).some(key => !['encryptionVersion', 'algorithm', 'keyId', 'nonce', 'tag', 'ciphertext'].includes(key))
				|| envelope.encryptionVersion !== 1 || envelope.algorithm !== 'AES-256-GCM' || !isUuid(envelope.keyId)) { throw new Error(); }
			const key = this.keys.get(envelope.keyId);
			if (!key) { throw new EvidenceEncryptionError('key_missing'); }
			const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.nonce, 12), { authTagLength: 16 });
			decipher.setAAD(this.aad(eventId, envelope.keyId, domain)); decipher.setAuthTag(decode(envelope.tag, 16));
			// Do not parse or deliver any plaintext until authentication succeeds.
			const first = decipher.update(decode(envelope.ciphertext));
			try { plaintext = Buffer.concat([first, decipher.final()]); } finally { first.fill(0); }
			if (plaintext.length > MAX_PLAINTEXT_BYTES) { throw new Error(); }
			return JSON.parse(plaintext.toString('utf8')) as unknown;
		} catch (error) { throw error instanceof EvidenceEncryptionError ? error : new EvidenceEncryptionError('authentication_failed'); }
		finally { plaintext?.fill(0); }
	}
	dispose(): void { this.keys.clear(); }
}
