import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createConnection } from 'node:net';

/** Claude's command-hook entrypoint. Never prints, persists input, or returns a hook decision. */
export async function forwardClaudeHook(configPath: string, input: NodeJS.ReadableStream): Promise<void> {
	let config: { socket: string; token: string; sourceSessionId: string; expiresAt: number };
	try {
		const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.nlink !== 1 || info.size > 8192 || process.platform !== 'win32' && (info.mode & 0o077) !== 0) { return; }
			config = JSON.parse(await handle.readFile('utf8'));
		} finally { await handle.close(); }
		if (!config || config.expiresAt < Date.now() || typeof config.socket !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) { return; }
	} catch { return; } // Inactive/revoked: do not read stdin at all.
	try {
		await new Promise<void>(resolve => {
			const socket = createConnection(config.socket); const timeout = setTimeout(() => socket.destroy(), 4000);
			let ready = false;
			socket.once('connect', () => socket.write(JSON.stringify({ token: config.token, probe: true }) + '\n'));
			socket.on('data', chunk => {
				if (ready || chunk.toString('utf8') !== 'ready\n') { return; } ready = true;
				void (async () => {
					const chunks: Buffer[] = []; let size = 0;
					for await (const chunk of input) {
						const bytes = Buffer.from(chunk); size += bytes.length;
						if (size > 1024 * 1024 || socket.destroyed) { socket.destroy(); return; } chunks.push(bytes);
					}
					const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					if (data?.session_id !== config.sourceSessionId || data.agent_id || socket.destroyed) { socket.destroy(); return; }
					socket.end(JSON.stringify({ token: config.token, data }) + '\n');
				})().catch(() => socket.destroy());
			});
			socket.on('error', () => {}); socket.once('close', () => { clearTimeout(timeout); resolve(); });
		});
	} catch { /* Fail passive, without logging input, paths or credentials. */ }

}
if (require.main === module) {
	const timeout = setTimeout(() => process.exit(0), 5000);
	void forwardClaudeHook(process.argv[2] ?? '', process.stdin).catch(() => {}).finally(() => { clearTimeout(timeout); process.exit(0); });
}
