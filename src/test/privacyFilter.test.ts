import * as assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { applyPatch, createTwoFilesPatch, parsePatch } from 'diff';
import { createChangeEvent, createCodexEvent, createFileEvent, createRelationshipEvent, validateEvent,
	type CodexEventType, type TrackerEvent } from '../eventSchema';
import { isSensitivePath, PrivacyFilter, REDACTED_VALUE, type PrivacyContext, type PrivacyResult } from '../privacyFilter';

const sessionId = randomUUID();
const sourceSessionId = 'confirmed-codex-session';
const workspaceId = 'approved-workspace';
const context = (): PrivacyContext => ({ recordingActive: true, sessionId, approvedWorkspaceIds: [workspaceId],
	confirmedCodexSessions: [{ sourceSessionId, workspaceId }], codexContentConsent: true });
const sourceRecord = { sourceFileReference: 'codex-file:' + 'a'.repeat(64), recordIndex: 1, generation: 0,
	byteOffset: 0, byteLength: 200, recordType: 'response_item' as const };
const message = (text: string, eventType: 'ai.prompt.submitted' | 'ai.response.completed' = 'ai.prompt.submitted') => createCodexEvent({
	eventType, sessionId, sourceSessionId, workspaceId, correlationId: 'turn-01', payload: { text, sourceRecord } });
const tool = (input: string, output = 'completed', eventType: CodexEventType = 'ai.tool.completed') => createCodexEvent({
	eventType, sessionId, sourceSessionId, workspaceId, correlationId: 'call-01', payload: { toolName: 'exec_command', callId: 'call-01',
		input, output, status: eventType === 'ai.tool.started' ? 'running' : eventType === 'ai.tool.failed' ? 'failed'
			: eventType === 'ai.tool.incomplete' ? 'incomplete' : 'succeeded', matched: true, sourceRecord,
		...(eventType === 'ai.tool.incomplete' ? { incompleteReason: 'recording_stopped' as const } : {}) } });
const file = (relativePath = 'src/app.ts') => createFileEvent({ source: 'vscode', eventType: 'file.saved', sessionId, workspaceId, payload: { relativePath } });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function eventFrom(result: PrivacyResult): TrackerEvent { assert.notEqual(result.status, 'rejected'); assert.ok('event' in result); return result.event; }
function textFrom(result: PrivacyResult): string { const event = eventFrom(result); assert.ok('text' in event.payload); return event.payload.text; }

suite('Centralized privacy filter', () => {
	const filter = new PrivacyFilter();
	const dummySecrets = [
		['OpenAI project key', 'sk-proj-' + 'DummyValue123456789'.repeat(2)],
		['OpenAI service key', 'sk-svcacct-' + 'DummyValue123456789'.repeat(2)],
		['OpenAI legacy key', 'sk-' + 'DummyValue123456789'.repeat(2)],
		['Anthropic-style key', 'sk-ant-api03-' + 'DummyValue123456789'.repeat(2)],
		['provider key ending in hyphens', 'sk-proj-' + 'DummyValue123456789'.repeat(2) + '--'],
		['AWS access key', 'AKIA' + 'A1B2C3D4E5F6G7H8'],
		['GitHub token', 'ghp_' + 'DummyValue123456789'.repeat(2)],
		['Google-style key', 'AIza' + 'DummyValue123456789'.repeat(2)],
		['Slack-style token', 'xoxb-' + '1234567890-dummy-token-987654321'],
		['JWT-shaped token', 'eyJhbGciOiJub25lIn0.eyJkdW1teSI6dHJ1ZX0.dummySignature123']
	];
	for (const [name, secret] of dummySecrets) {
		test(`redacts ${name} while preserving message context`, () => {
			const result = filter.filter(message(`Connect using ${secret} then run tests.`), context());
			assert.equal(result.status, 'redacted'); assert.equal(textFrom(result), `Connect using ${REDACTED_VALUE} then run tests.`);
		});
	}

	test('redacts bearer/basic authorization, cookie headers and credential-bearing URLs', () => {
		const values = ['Authorization: Bearer dummyBearer0123456789', 'Bearer dummyBearer0123456789',
			'Authorization: Basic ZHVtbXk6cGFzc3dvcmQ=', 'Cookie: session=dummyCookie123; other=dummyCookie456',
			'https://dummyuser:dummyPassword@service.example/resource'];
		for (const value of values) {
			const result = filter.filter(message('Before\n' + value + '\nAfter'), context());
			assert.equal(result.status, 'redacted'); const text = textFrom(result);
			assert.ok(text.startsWith('Before\n')); assert.ok(text.endsWith('\nAfter')); assert.ok(text.includes(REDACTED_VALUE));
			assert.ok(!/dummyBearer|ZHVtbXk|dummyCookie|dummyPassword|dummyuser/.test(text));
		}
	});

	test('redacts password and credential assignments without removing surrounding code', () => {
		for (const input of ['const password = "dummyPass123"; doWork();', "client_secret='dummyPass123'; doWork();",
			'PASSWORD=dummyPass123\nkeep=true', 'https://service.example?api_key=dummyPass123&mode=test',
			'const dbPassword = `dummyPass123`; doWork();']) {
			const result = filter.filter(message(input), context()); assert.equal(result.status, 'redacted');
			assert.ok(!textFrom(result).includes('dummyPass123')); assert.ok(textFrom(result).includes(REDACTED_VALUE));
		}
	});

	test('filters nested objects and arrays including numeric credentials without mutating inputs', () => {
		const input = { host: 'service.example', items: [{ api_key: 'dummyGenericSecret' }, { password: 123456, enabled: false }],
			credentials: { username: 'dummyuser', password: 'dummyPass123' }, publicKey: 'public-not-secret' };
		const snapshot = JSON.stringify(input); const result = filter.filterContent(input);
		assert.equal(result.status, 'redacted'); assert.ok('value' in result);
		const serialized = JSON.stringify(result.value);
		assert.ok(!/dummyGenericSecret|123456|dummyuser|dummyPass123/.test(serialized));
		assert.ok(serialized.includes('service.example')); assert.ok(serialized.includes('public-not-secret'));
		assert.equal(JSON.stringify(input), snapshot);
	});

	test('filters structured JSON strings in tool inputs and outputs recursively', () => {
		const input = JSON.stringify({ cmd: 'run-tests', headers: { Authorization: 'Bearer dummyBearer0123456789' },
			args: [{ password: 'dummyPass123' }], nested: JSON.stringify({ client_secret: 'dummyClientSecret' }) });
		const output = JSON.stringify({ data: [{ access_token: 'dummyAccessToken' }], ok: true });
		const result = filter.filter(tool(input, output), context()); assert.equal(result.status, 'redacted');
		const payload = eventFrom(result).payload; assert.ok('input' in payload && 'output' in payload);
		assert.equal(JSON.parse(payload.input!).cmd, 'run-tests'); assert.equal(JSON.parse(payload.output!).ok, true);
		assert.ok(!/dummyBearer|dummyPass|dummyClient|dummyAccess/.test(JSON.stringify(payload)));
	});

	test('handles private-key blocks, including multiple variants and CRLF, without leaking bodies', () => {
		for (const kind of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
			const value = `Before\r\n-----BEGIN ${kind}-----\r\nDUMMY_PRIVATE_BODY_012345\r\n-----END ${kind}-----\r\nAfter`;
			const result = filter.filter(message(value), context()); assert.equal(result.status, 'redacted');
			const text = textFrom(result); assert.ok(!text.includes('DUMMY_PRIVATE_BODY')); assert.ok(!text.includes('BEGIN'));
			assert.ok(text.startsWith('Before\r\n')); assert.ok(text.endsWith('\r\nAfter'));
			assert.equal(text.split('\r\n').length, value.split('\r\n').length);
		}
	});

	test('rejects incomplete private keys and incomplete quoted credentials', () => {
		for (const text of ['-----BEGIN PRIVATE KEY-----\nDUMMY_PRIVATE_BODY', '-----BEGIN RSA PRIVATE KEY----\nDUMMY_PRIVATE_BODY',
			'password="dummyPassWithoutClosingQuote']) {
			const result = filter.filter(message(text), context()); assert.equal(result.status, 'rejected'); assert.ok(!('event' in result));
			assert.ok(!JSON.stringify(result).includes('DUMMY')); assert.ok(!JSON.stringify(result).includes('dummyPass'));
		}
	});

	test('excludes sensitive, dependency, generated and own-storage paths including encoded variants', () => {
		for (const path of ['.env', '.env.local', 'config/.ENV.production', 'keys/private.pem', 'keys/id_rsa', '.aws/credentials',
			'src/secrets.json', 'credentials.json', 'node_modules/pkg/index.js', 'vendor/package/file.ts', '.git/config', 'dist/app.js',
			'event-queue.v1.sqlite-wal', 'events.v1.jsonl', 'src/%2eenv', 'src/%252eenv', 'config/.ｅｎｖ']) {
			assert.equal(isSensitivePath(path), true, path);
			assert.equal(filter.filter(file(path), context()).status, 'rejected', path);
		}
		assert.equal(filter.filter(file('src/environment.ts'), context()).status, 'accepted');
	});

	test('rejects sensitive structured tool paths without parsing or executing commands', () => {
		const input = JSON.stringify({ path: '.env', command: 'do-not-execute-anything' });
		assert.equal(filter.filter(tool(input), context()).status, 'rejected');
		assert.equal(filter.filter(tool(JSON.stringify({ path: '../private.txt' })), context()).status, 'rejected');
		assert.equal(filter.filter(tool(JSON.stringify({ path: '/outside/app.ts' })), context()).status, 'rejected');
		const approved = { ...context(), resolveToolPath: (path: string) => path === '/workspace/app.ts' ? 'src/app.ts' : undefined };
		assert.equal(filter.filter(tool(JSON.stringify({ path: '/workspace/app.ts' })), approved).status, 'accepted');
	});

	test('honors the supplied eligible-file guard and fails closed if it throws', () => {
		assert.equal(filter.filter(file(), { ...context(), isApprovedRelativePath: () => false }).status, 'rejected');
		assert.deepEqual(filter.filter(file(), { ...context(), isApprovedRelativePath: () => { throw new Error('PRIVATE PATH'); } }),
			{ status: 'rejected', reasonCodes: ['boundary_check_failed'] });
	});

	test('preserves all event and correlation identifiers and original objects', () => {
		const input = tool('password="dummyPass123"'); const original = JSON.stringify(input);
		const result = filter.filter(input, context()); const filtered = eventFrom(result);
		for (const key of ['eventId', 'sessionId', 'source', 'timestamp', 'sourceSessionId', 'correlationId', 'workspaceId', 'eventType', 'schemaVersion'] as const) {
			assert.equal(filtered[key], input[key]);
		}
		assert.ok('callId' in filtered.payload && 'callId' in input.payload); assert.equal(filtered.payload.callId, input.payload.callId);
		assert.equal(JSON.stringify(input), original); assert.equal(validateEvent(filtered).valid, true);
	});

	test('rejects secrets embedded in protected identifiers instead of changing identity', () => {
		const secret = dummySecrets[0][1];
		assert.equal(filter.filter({ ...message('safe'), correlationId: secret }, context()).status, 'rejected');
		const input = tool('safe'); assert.ok('callId' in input.payload); input.payload.callId = secret;
		assert.deepEqual(filter.filter(input, context()), { status: 'rejected', reasonCodes: ['sensitive_identifier'] });
	});

	test('redacts multipart responses and removes obsolete segmentation metadata', () => {
		const text = 'First part\npassword="dummyPass123"'; const input = message(text, 'ai.response.completed');
		assert.ok('text' in input.payload); input.payload.partLengths = [10, text.length - 11];
		const result = filter.filter(input, context()); const payload = eventFrom(result).payload;
		assert.equal(result.status, 'redacted'); assert.ok(!('partLengths' in payload)); assert.equal(validateEvent(eventFrom(result)).valid, true);
		assert.ok(result.reasonCodes.includes('multipart_metadata_removed'));
	});

	test('redacts added and removed diff lines without changing hunk counts or original content hashes', () => {
		const before = 'const password = "dummyOldPassword";\nconst keep = true;\n';
		const after = 'const password = "dummyNewPassword";\nconst keep = true;\n';
		const input = createChangeEvent({ eventType: 'file.diff', sessionId, workspaceId, payload: { relativePath: 'src/app.ts',
			diff: createTwoFilesPatch('before', 'after', before, after), beforeHash: hash(before), afterHash: hash(after), changeReason: 'edit' } });
		const result = filter.filter(input, context()); assert.equal(result.status, 'redacted'); assert.ok('event' in result);
		assert.equal(result.requiresReconstructionGap, true); const payload = result.event.payload; assert.ok('diff' in payload);
		assert.ok(!/dummyOldPassword|dummyNewPassword/.test(payload.diff)); assert.equal(payload.beforeHash, hash(before));
		assert.equal(payload.afterHash, hash(after)); assert.equal(validateEvent(result.event).valid, true);
		assert.ok('diff' in input.payload);
		const oldHunk = parsePatch(input.payload.diff)[0].hunks[0]; const newHunk = parsePatch(payload.diff)[0].hunks[0];
		assert.equal(oldHunk.oldLines, newHunk.oldLines); assert.equal(oldHunk.newLines, newHunk.newLines);
		assert.notEqual(applyPatch(before.replace('dummyOldPassword', REDACTED_VALUE), payload.diff), false);
	});

	test('redacts JSON-file diffs and baseline private keys while keeping patch structure', () => {
		for (const after of ['{\n  "password": "dummyJsonPassword"\n}\n',
			'-----BEGIN PRIVATE KEY-----\nDUMMY_PRIVATE_BODY\n-----END PRIVATE KEY-----\n']) {
			const input = createChangeEvent({ eventType: 'file.baseline', sessionId, workspaceId, payload: { relativePath: 'src/example.txt',
				diff: createTwoFilesPatch('before', 'after', '', after), beforeHash: hash(''), afterHash: hash(after), changeReason: 'create' } });
			const result = filter.filter(input, context()); assert.equal(result.status, 'redacted'); const event = eventFrom(result); assert.ok('diff' in event.payload);
			assert.ok(!/dummyJsonPassword|DUMMY_PRIVATE_BODY/.test(event.payload.diff)); assert.equal(validateEvent(event).valid, true);
			assert.notEqual(applyPatch('', event.payload.diff), false);
		}
	});

	test('preserves harmless content, template references, public keys and mentions of sensitive filenames', () => {
		for (const text of ['The password field is required.', 'const passwordLength = 12;', 'const password = process.env.PASSWORD;',
			'password="${PASSWORD}"', 'Use OPENAI_API_KEY and ANTHROPIC_API_KEY.', 'Do not change .env.', '[INFO] Tests passed.',
			'-----BEGIN PUBLIC KEY-----\nPUBLIC_EXAMPLE\n-----END PUBLIC KEY-----', 'sk-proj-example', 'Bearer token authentication is documented.']) {
			const result = filter.filter(message(text), context());
			assert.equal(result.status, 'accepted', text); assert.equal(textFrom(result), text);
		}
	});

	test('preserves harmless structured JSON formatting and redaction is idempotent', () => {
		const clean = '{\n  "passwordLength": 20, "password": "${PASSWORD}", "enabled": false\n}';
		const accepted = filter.filter(tool(clean), context()); assert.equal(accepted.status, 'accepted');
		assert.ok('input' in eventFrom(accepted).payload); assert.equal((eventFrom(accepted).payload as { input: string }).input, clean);
		const first = eventFrom(filter.filter(message('password="dummySecret123"'), context()));
		assert.equal(filter.filter(first, context()).status, 'accepted');
	});

	test('requires matching active recording, workspace, confirmed source-session and content consent', () => {
		const input = message('safe');
		for (const [override, code] of [[{ recordingActive: false }, 'recording_inactive'], [{ sessionId: randomUUID() }, 'session_not_approved'],
			[{ approvedWorkspaceIds: [] }, 'workspace_not_approved'], [{ confirmedCodexSessions: [] }, 'source_session_not_confirmed'],
			[{ confirmedCodexSessions: [{ sourceSessionId, workspaceId: 'another-workspace' }] }, 'source_session_not_confirmed'],
			[{ codexContentConsent: false }, 'content_consent_missing']] as const) {
			assert.deepEqual(filter.filter(input, { ...context(), ...override }), { status: 'rejected', reasonCodes: [code] });
		}
	});

	test('allowlists event types and rejects unsupported source mappings and malformed payloads', () => {
		assert.deepEqual(filter.filter({ ...file(), eventType: 'custom.secret' }, context()), { status: 'rejected', reasonCodes: ['unsupported_event_type'] });
		for (const value of [null, { ...message('safe'), payload: { text: 123 } }, { ...tool('safe'), payload: { input: { password: 'dummy' } } },
			{ ...file(), schemaVersion: 999 }]) { assert.equal(filter.filter(value, context()).status, 'rejected'); }
		assert.deepEqual(filter.filter({ ...file(), source: 'claude' }, context()), { status: 'rejected', reasonCodes: ['unsupported_source'] });
		assert.equal(filter.filter({ ...file(), source: 'codex' }, context()).status, 'rejected');
	});

	test('filters every supported Codex activity type and leaves safe relationship evidence unchanged', () => {
		for (const eventType of ['ai.tool.started', 'ai.tool.completed', 'ai.tool.failed', 'ai.tool.incomplete'] as const) {
			const result = filter.filter(tool('password="dummyPass123"', 'safe', eventType), context());
			assert.equal(result.status, 'redacted'); assert.equal(validateEvent(eventFrom(result)).valid, true);
		}
		const source = randomUUID(); const target = randomUUID();
		const relation = createRelationshipEvent({ sessionId, workspaceId, sourceSessionId, eventType: 'activity.relationship.created', payload: {
			relationshipId: 'b'.repeat(64), sourceEventId: source, targetEventId: target, relationshipType: 'tool_file_change', relativePath: 'src/app.ts',
			confidence: 'possible', explanationCode: 'timestamp_only', revision: 1, evidence: [{ eventId: source, kind: 'tool_start', sourceRecord }, { eventId: target, kind: 'time_window' }]
		} });
		const result = filter.filter(relation, context()); assert.equal(result.status, 'accepted');
		assert.equal(JSON.stringify(eventFrom(result)), JSON.stringify(relation));
	});

	test('rejects cycles, accessors, proxies, sparse arrays, prototypes and non-JSON data without invoking getters', () => {
		const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
		let reads = 0; const accessor = Object.defineProperty({}, 'password', { enumerable: true, get() { reads++; return 'PRIVATE'; } });
		for (const input of [cyclic, accessor, new Proxy({}, { ownKeys() { throw new Error('PRIVATE'); } }), Array(3), new Date(), Buffer.from('PRIVATE'),
			new Map(), { fn() {} }, { x: BigInt(1) }, { value: Infinity }, JSON.parse('{"__proto__":{"password":"PRIVATE"}}')]) {
			const result = filter.filterContent(input); assert.equal(result.status, 'rejected'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
		}
		assert.equal(reads, 0);
	});

	test('rejects malformed structured strings and duplicate JSON keys rather than leaking discarded values', () => {
		for (const input of ['{"password": "dummySecret"', '{"note":"sk-proj-' + 'DummyKey'.repeat(5) + '","note":"safe"}',
			'{"password":"dummyOne","pass\\u0077ord":"dummyTwo"}']) {
			assert.equal(filter.filter(tool(input), context()).status, 'rejected');
		}
	});

	test('enforces byte, node, depth, parse and output limits with safe reasons', () => {
		for (const [limited, value] of [[new PrivacyFilter({ maxStringBytes: 10 }), 'long dummy input value'],
			[new PrivacyFilter({ maxInputBytes: 10 }), { a: '1234567890', b: '1234567890' }],
			[new PrivacyFilter({ maxNodes: 5 }), [1, 2, 3, 4, 5]],
			[new PrivacyFilter({ maxDepth: 2 }), { a: { b: { c: 'deep' } } }],
			[new PrivacyFilter({ maxProcessingBytes: 5 }), 'abcdef'],
			[new PrivacyFilter({ maxOutputBytes: 10 }), { password: 'a' }],
			[new PrivacyFilter({ maxJsonParses: 1 }), JSON.stringify({ nested: JSON.stringify({ text: 'safe' }) })]] as const) {
			assert.deepEqual(limited.filterContent(value), { status: 'rejected', reasonCodes: ['processing_limit'] });
		}
	});

	test('limits diff lines before runtime schema parsing and handles large safe text efficiently', () => {
		const after = 'x\n'.repeat(100); const input = createChangeEvent({ eventType: 'file.diff', sessionId, workspaceId,
			payload: { relativePath: 'src/app.ts', diff: createTwoFilesPatch('before', 'after', '', after), beforeHash: hash(''), afterHash: hash(after), changeReason: 'edit' } });
		assert.deepEqual(new PrivacyFilter({ maxDiffLines: 10 }).filter(input, context()), { status: 'rejected', reasonCodes: ['processing_limit'] });
		const value = 'normal context '.repeat(10000); const result = filter.filter(message(value), context());
		assert.equal(result.status, 'accepted'); assert.equal(textFrom(result), value);
	});

	test('rejects invalid processing options without echoing values', () => {
		for (const options of [{ maxDepth: 0 }, { maxNodes: -1 }, { maxInputBytes: Infinity }, { maxStringBytes: 3 * 1024 * 1024 }]) {
			assert.throws(() => new PrivacyFilter(options), /^Error: Invalid privacy processing limits\.$/);
		}
	});

	test('filters command-line password/token flags and nested custom authentication headers', () => {
		const input = 'run --password "dummyPass123" --api-key dummyApiValue123 --mode test';
		const result = filter.filter(tool(input, JSON.stringify({ headers: { 'X-Auth-Token': 'dummyAuth123' }, nextToken: 'dummyNext123' })), context());
		assert.equal(result.status, 'redacted'); const serialized = JSON.stringify(eventFrom(result));
		assert.ok(!/dummyPass|dummyApi|dummyAuth|dummyNext/.test(serialized)); assert.ok(serialized.includes('--mode test'));
	});

	test('rejects ambiguous YAML credential blocks and handles multiple redacted key lines idempotently', () => {
		assert.equal(filter.filter(message('password: |\n  dummyMultilineSecret'), context()).status, 'rejected');
		const first = filter.filter(message('private_key="-----BEGIN PRIVATE KEY-----\nDUMMY_BODY\n-----END PRIVATE KEY-----"'), context());
		assert.equal(first.status, 'redacted'); assert.equal(filter.filter(eventFrom(first), context()).status, 'accepted');
	});

	test('rejects sensitive file evidence and identifiers in nested source references', () => {
		const input = tool('safe'); assert.ok('fileEvidence' in input.payload || 'toolName' in input.payload);
		(input.payload as { fileEvidence?: unknown[] }).fileEvidence = [{ relativePath: '.env', operation: 'read', kind: 'declared', origin: 'structured_arguments' }];
		assert.equal(filter.filter(input, context()).status, 'rejected');
	});

	test('checks structured file lists and credential stores and rejects unsafe resolver results', () => {
		assert.equal(filter.filter(tool(JSON.stringify({ files: ['src/app.ts', '.env'] })), context()).status, 'rejected');
		assert.equal(filter.filter(tool(JSON.stringify({ paths: ['src/app.ts', 'src/helper.ts'] })), context()).status, 'accepted');
		for (const path of ['.git-credentials', '.docker/config.json', '.gnupg/keyring', '.htpasswd']) {
			assert.equal(filter.filter(file(path), context()).status, 'rejected');
		}
		assert.equal(filter.filter(tool(JSON.stringify({ path: '/workspace/app.ts' })),
			{ ...context(), resolveToolPath: () => '%2foutside%2fapp.ts' }).status, 'rejected');
	});

	test('redacts short bearer credentials while retaining bare prose references to bearer tokens', () => {
		assert.equal(textFrom(filter.filter(message('Bearer x1_='), context())), 'Bearer ' + REDACTED_VALUE);
		assert.equal(filter.filter(message('Bearer tokens authenticate requests.'), context()).status, 'accepted');
		assert.equal(filter.filter(message('Authorization: Bearer token'), context()).status, 'redacted');
	});
});
