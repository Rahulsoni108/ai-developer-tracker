import type { AssessmentView } from './assessmentController';
import type { RecordingController } from './recording';

export type RecordingStartChoice = 'Start Assessment' | 'Start Manual Recording';
/** The status-bar and palette manual command share this guard. Never infer assessment consent. */
export async function startRecordingCommand(recording: RecordingController, assessment: () => AssessmentView,
	choose: () => Promise<RecordingStartChoice | undefined>, startAssessment: () => Promise<unknown>): Promise<void> {
	if (recording.isRecording || recording.isStarting) { return; }
	const view = assessment();
	if (view.mode === 'rails' && view.state !== 'unpaired') {
		const choice = await choose();
		if (choice === 'Start Assessment') { await startAssessment(); return; }
		if (choice !== 'Start Manual Recording') { return; }
	}
	// Manual captures retain their own recording ID and cannot pass the assessment-start guard.
	await recording.start();
}

/** Stops only local capture and drains it; never calls assessment submission or alters its binding. */
export async function stopRecordingCommand(recording: RecordingController, flushStopped: (id?: string) => Promise<void>): Promise<string | undefined> {
	const id = recording.sessionId;
	recording.stop();
	await flushStopped(id);
	return id;
}
