import type { PrivacyContext } from './privacyFilter';

/** Trusted, cloneable capture-time admission; path proofs are created by successful persistence filtering. */
export interface UploadPrivacyContext extends PrivacyContext {
	verifiedToolPaths?: { path: string; workspaceId: string; relativePath: string }[];
}
