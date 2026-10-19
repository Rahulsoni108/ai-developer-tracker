import { request, Agent } from 'node:https';

export interface UploadHttpResponse { status: number; retryAfter?: string; contentType?: string; body: string }
export interface UploadHttpRequest { endpoint: URL; token?: string; body: string; signal: AbortSignal; method?: 'POST' | 'DELETE' | 'GET' }
export interface UploadTransport { send(request: UploadHttpRequest): Promise<UploadHttpResponse> }
export class UploadTransportError extends Error {
	constructor(readonly category: 'network' | 'configuration' | 'protocol') { super('HTTPS event request failed.'); }
}
export function validatedUploadEndpoint(value: string): URL {
	try {
		if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) { throw new Error(); }
		const url = new URL(value);
		if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.search) { throw new Error(); }
		return url;
	} catch { throw new UploadTransportError('configuration'); }
}

/** No redirects, proxies, raw diagnostics or certificate bypass. Agent is private to this transport. */
export class HttpsEventTransport implements UploadTransport {
	private readonly agent: Agent;
	/** Optional trust root supports local HTTPS tests; certificate/hostname validation is always enabled. */
	constructor(trustRoot?: string) {
		this.agent = new Agent({ keepAlive: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: trustRoot });
	}
	send(input: UploadHttpRequest): Promise<UploadHttpResponse> {
		const endpoint = validatedUploadEndpoint(input.endpoint.href);
		if (input.token !== undefined && !/^[\x21-\x7e]{1,8192}$/.test(input.token)) { return Promise.reject(new UploadTransportError('configuration')); }
		return new Promise((resolve, reject) => {
			const req = request(endpoint, { method: input.method ?? 'POST', agent: this.agent, rejectUnauthorized: true, signal: input.signal,
				maxHeaderSize: 16384, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
					'Content-Length': Buffer.byteLength(input.body), ...(input.token === undefined ? {} : { 'Authorization': `Bearer ${input.token}` }) } }, response => {
				const chunks: Buffer[] = []; let bytes = 0;
				response.on('data', (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > 128 * 1024) { req.destroy(); reject(new UploadTransportError('protocol')); return; }
					chunks.push(chunk);
				});
				response.on('end', () => resolve({ status: response.statusCode ?? 0, retryAfter: response.headers['retry-after'],
					contentType: response.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
				response.on('error', () => reject(new UploadTransportError('network')));
				response.on('aborted', () => reject(new UploadTransportError('network')));
			});
			req.on('error', error => {
				const code = (error as NodeJS.ErrnoException).code ?? '';
				const category = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code) ? 'configuration' : 'network';
				reject(new UploadTransportError(category));
			});
			req.end(input.body);
		});
	}
	dispose(): void { this.agent.destroy(); }
}
