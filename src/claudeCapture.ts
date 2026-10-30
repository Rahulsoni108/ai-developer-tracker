import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RecordingController } from './recording';
import { CLAUDE_HOOKS, ClaudeEventParser } from './claudeEventParser';

export interface ClaudeLaunch { root: string; sourceSessionId: string; pluginDirectory: string }
export interface ClaudeCaptureOptions {
	storageDirectory: string;
	bridgePath: string;
	nodeExecutable: string;
	assertOutsideWorkspaces(path: string): Promise<void>;
	authorizeSource?(recordingId: string, workspaceId: string, sourceSessionId: string): Promise<void>;
}
interface Capture { sourceSessionId: string; token: string; directory: string; socketDirectory?: string; server: Server; sockets: Set<Socket>; }
/** Per-launch hook plugin; never reads or modifies a user's existing Claude configuration. */
export class ClaudeCapture {
	private readonly captures = new Set<Capture>();
	private readonly lifecycle: { dispose(): void };
	private revoking: Promise<void> = Promise.resolve();
	private generation = 0;
	constructor(private readonly recording: RecordingController, readonly parser: ClaudeEventParser, private readonly options: ClaudeCaptureOptions) {
		this.lifecycle = recording.addLifecycleListener({ prepare: async () => {}, started: () => {},
			stopped: () => { void this.revoke(); }, cancelled: () => {} });
	}
	async create(root: string, workspaceId: string): Promise<ClaudeLaunch> {
		const recordingSessionId = this.recording.sessionId; const generation = this.generation;
		if (!recordingSessionId || !this.recording.isRecording || this.captures.size >= 8) { throw new Error('Claude capture unavailable.'); }
		await this.options.assertOutsideWorkspaces(this.options.storageDirectory);
		await mkdir(this.options.storageDirectory, { recursive: true, mode: 0o700 });
		const directory = await mkdtemp(join(this.options.storageDirectory, 'claude-capture-'));
		await chmod(directory, 0o700);
		const sourceSessionId = randomUUID(); const token = randomBytes(32).toString('hex');
		let socketDirectory: string | undefined; let capture: Capture | undefined;
		try {
			let socketPath: string;
			if (process.platform === 'win32') { socketPath = '\\\\.\\pipe\\ai-claude-' + randomUUID(); }
			else {
				socketDirectory = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ai-claude-'));
				await chmod(socketDirectory, 0o700); await this.options.assertOutsideWorkspaces(socketDirectory); socketPath = join(socketDirectory, 's');
			}
			const sockets = new Set<Socket>();
			const server = createServer({ allowHalfOpen: true }, socket => {
				if (sockets.size >= 16 || !this.parser.canCapture(sourceSessionId)) { socket.destroy(); return; }
				sockets.add(socket); socket.setTimeout(3500, () => socket.destroy());
				let data = Buffer.alloc(0); let handled = false;
				socket.on('data', chunk => {
					if (handled) { return; } data = Buffer.concat([data, chunk]);
					if (data.length > 1024 * 1024 + 512) { socket.destroy(); return; }
					const end = data.indexOf(10); if (end < 0) { return; }
					try {
						const message = JSON.parse(data.subarray(0, end).toString('utf8')); data = Buffer.alloc(0);
						if (typeof message.token !== 'string' || message.token.length !== token.length || !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))) { socket.destroy(); return; }
						if (!this.parser.canCapture(sourceSessionId)) { socket.destroy(); return; }
						if (message.probe === true) { socket.write('ready\n'); return; } handled = true;
						void this.parser.handle(sourceSessionId, message.data).then(() => socket.end(), () => socket.destroy());
					} catch { socket.destroy(); }
				});
				socket.on('error', () => {}); socket.on('end', () => { if (!handled) { socket.end(); } }); socket.on('close', () => sockets.delete(socket));
			});
			server.on('error', () => {});
			capture = { sourceSessionId, token, directory, socketDirectory, server, sockets }; this.captures.add(capture);
			await this.options.authorizeSource?.(recordingSessionId, workspaceId, sourceSessionId);
			if (generation !== this.generation || !this.recording.isRecording || this.recording.sessionId !== recordingSessionId) { throw new Error('Claude capture unavailable.'); }
			await this.parser.approve({ sourceSessionId, workspaceId, root, recordingSessionId });
			await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
			if (process.platform !== 'win32') { await chmod(socketPath, 0o600); }
			const configPath = join(directory, 'runtime.json');
			await writeFile(configPath, JSON.stringify({ socket: socketPath, token, sourceSessionId, expiresAt: Date.now() + 8 * 3600000 }), { mode: 0o600, flag: 'wx' });
			await mkdir(join(directory, '.claude-plugin')); await mkdir(join(directory, 'hooks'));
			await writeFile(join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'aidt-' + sourceSessionId, version: '0.0.1', description: 'Consented local assessment capture' }), { mode: 0o600 });
			const hooks = Object.fromEntries(CLAUDE_HOOKS.map(kind => [kind, [{ hooks: [{ type: 'command', command: this.options.nodeExecutable,
				args: [this.options.bridgePath, configPath], timeout: 5 }] }]]));
			await writeFile(join(directory, 'hooks', 'hooks.json'), JSON.stringify({ hooks }), { mode: 0o600 });
			if (generation !== this.generation || !this.recording.isRecording || this.recording.sessionId !== recordingSessionId) { throw new Error('Claude capture unavailable.'); }
			return { root, sourceSessionId, pluginDirectory: directory };
		} catch {
			if (capture) { await this.remove(capture); } else { await rm(directory, { recursive: true, force: true }); if (socketDirectory) { await rm(socketDirectory, { recursive: true, force: true }); } }
			throw new Error('Claude capture unavailable.');
		}
	}
	private async remove(capture: Capture): Promise<void> {
		this.captures.delete(capture); for (const socket of capture.sockets) { socket.destroy(); }
		if (capture.server.listening) { await new Promise<void>(resolve => capture.server.close(() => resolve())); }
		await rm(capture.directory, { recursive: true, force: true });
		if (capture.socketDirectory) { await rm(capture.socketDirectory, { recursive: true, force: true }); }
	}
	revoke(): Promise<void> {
		++this.generation; this.parser.revoke();
		const captures = [...this.captures]; this.revoking = this.revoking.then(async () => {
			for (const capture of captures) { try { await this.remove(capture); } catch { /* Stale endpoints have no live parser approval. */ } }
			await this.parser.finishRecording();
		}); return this.revoking;
	}
	async dispose(): Promise<void> { this.lifecycle.dispose(); await this.revoke(); }
}
