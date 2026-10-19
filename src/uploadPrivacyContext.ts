import type { PrivacyContext } from './privacyFilter';

/** Trusted, cloneable capture-time admission; path proofs are created by successful persistence filtering. */
export interface UploadPrivacyContext extends PrivacyContext {
	/** Present only after authenticated durable approval verification. Upload re-filtering must preserve these exact bytes. */
	exactEventDigest?: string;
	verifiedToolPaths?: { path: string; workspaceId: string; relativePath: string }[];
}
