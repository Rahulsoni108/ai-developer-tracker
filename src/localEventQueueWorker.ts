import { parentPort, workerData } from 'node:worker_threads';
import { LocalEventQueue, safeQueueError, type QueueHealth } from './localEventQueue';
import type { QueueReply, QueueRequest } from './asyncLocalEventQueue';

/** Private storage thread. Its messages never include filesystem/SQLite error details. */
async function run(): Promise<void> {
	const port = parentPort;
	if (!port) { return; }
	let queue: LocalEventQueue;
	let health: QueueHealth;
	try { queue = await LocalEventQueue.open(workerData.storage, workerData.folders, workerData.options); health = await queue.getHealth(); }
	catch (error) { port.postMessage({ type: 'failed', code: safeQueueError(error).code } satisfies QueueReply); port.close(); return; }
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
					case 'enqueue': await queue.enqueue(request.argument); break;
					case 'getPending': value = await queue.getPending(request.argument as number); break;
					case 'markAcknowledged': await queue.markAcknowledged(request.argument as string[]); break;
					case 'getPendingCount': value = await queue.getPendingCount(); break;
					case 'getHealth': value = await queue.getHealth(); break;
					case 'beginSession': await queue.beginSession(request.argument as string); break;
					case 'finishSession': {
						const argument = request.argument as { sessionId: string; status: 'completed' | 'cancelled' };
						await queue.finishSession(argument.sessionId, argument.status); break;
					}
					case 'getRecordingSessions': value = await queue.getRecordingSessions(request.argument as number); break;
					case 'close': await queue.close(); break;
					default: throw new Error('Unsupported queue operation.');
				}
				port.postMessage({ type: 'result', id: request.id, ok: true, value } satisfies QueueReply);
			} catch (error) { port.postMessage({ type: 'result', id: request.id, ok: false, code: safeQueueError(error).code } satisfies QueueReply); }
			finally { if (request.operation === 'close') { port.close(); } }
			if (request.operation !== 'close') {
				try { await notifyHealth(); } catch (error) { port.postMessage({ type: 'failed', code: safeQueueError(error).code } satisfies QueueReply); }
			}
		});
	});
	port.postMessage({ type: 'ready', health } satisfies QueueReply);
}
void run();
