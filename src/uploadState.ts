/** Only safe counters, deadlines and an endpoint digest are persisted, never URLs or credentials. */
export type UploadPauseReason = 'authentication' | 'configuration' | 'protocol' | 'privacy' | 'storage';
export interface UploadRetryState {
	endpointHash: string;
	attempts: number;
	nextAttemptAt: number;
	pauseReason: UploadPauseReason | null;
	busy: boolean;
}
