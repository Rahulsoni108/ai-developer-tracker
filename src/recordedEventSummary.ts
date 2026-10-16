import type { RecordedEventSummary } from './localEventQueue';
import { PRIVACY_EVENT_TYPES } from './privacyFilter';

export const RECORDED_EVENT_SUMMARY_COMMAND = 'ai-developer-tracker.showRecordedEventSummary';
export const RECORDED_EVENT_SUMMARY_TITLE = 'Latest recording — retained pending event counts';
export const RECORDED_EVENT_SUMMARY_FAILURE = 'Unable to summarize retained events safely. Local storage or event decryption/validation is unavailable. No event contents were displayed.';

/** Defense at the display boundary: never interpolate arbitrary response keys or exception text. */
export function formatRecordedEventSummary(summary: RecordedEventSummary): string {
	if (!summary || !Number.isSafeInteger(summary.total) || summary.total < 0 || !summary.counts
		|| typeof summary.counts !== 'object' || Array.isArray(summary.counts)) { throw new Error('Invalid event summary.'); }
	const counts = Object.entries(summary.counts);
	if (counts.some(([type, count]) => !(PRIVACY_EVENT_TYPES as readonly string[]).includes(type)
		|| !Number.isSafeInteger(count) || count! < 1) || counts.reduce((sum, [, count]) => sum + count!, 0) !== summary.total) {
		throw new Error('Invalid event summary.');
	}
	const lines = [RECORDED_EVENT_SUMMARY_TITLE, '', `Total retained pending events: ${summary.total}`];
	if (!summary.total) { lines.push('', 'No retained pending events, or no non-cancelled recording session exists.'); }
	else { lines.push('', ...counts.sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => `${type}: ${count}`)); }
	lines.push('', 'Acknowledged event types are unavailable after their payloads are cleared. This is not a complete historical recording count.');
	return lines.join('\n');
}

/** The command uses only the existing worker; failures never invoke recording controls. */
export async function showRecordedEventSummary(queue: { getRecordedEventSummary(): Promise<RecordedEventSummary> } | undefined,
	output: { clear(): void; appendLine(value: string): void; show(preserveFocus?: boolean): void }): Promise<RecordedEventSummary | undefined> {
	try {
		if (!queue) { throw new Error('Queue unavailable.'); }
		const summary = await queue.getRecordedEventSummary();
		const formatted = formatRecordedEventSummary(summary);
		output.clear(); output.appendLine(formatted); output.show(true); return summary;
	} catch {
		output.clear(); output.appendLine(RECORDED_EVENT_SUMMARY_TITLE + '\n\n' + RECORDED_EVENT_SUMMARY_FAILURE); output.show(true);
		return undefined;
	}
}
