import * as assert from 'node:assert/strict';
import { createTwoFilesPatch } from 'diff';
import { contentHash, extractToolFileEvidence, patchChangeHash, relativeToolPath } from '../toolFileEvidence';

suite('Structured tool file evidence', () => {
	const excluded = (path: string) => path.includes('.env') || path.startsWith('node_modules/');
	test('extracts applied patch paths and hashes without retaining code or commands', () => {
		const patch = createTwoFilesPatch('src/a.ts', 'src/a.ts', 'old\n', 'new\n');
		const result = extractToolFileEvidence({ type: 'patch_apply_end', changes: {
			'src/a.ts': { type: 'update', unified_diff: patch },
			'src/new.ts': { type: 'add', content: 'PRIVATE_NEW_CODE\n' },
			'src/gone.ts': { type: 'delete', content: 'PRIVATE_OLD_CODE\n' }
		} }, relativeToolPath, excluded, true);
		assert.equal(result.length, 3);
		assert.ok(result.every(item => item.kind === 'applied' && item.origin === 'patch_apply'));
		assert.equal(result[0].changeHash, patchChangeHash(createTwoFilesPatch('before', 'after', 'old\n', 'new\n')));
		assert.equal(result[1].beforeHash, contentHash('')); assert.equal(result[1].afterHash, contentHash('PRIVATE_NEW_CODE\n'));
		assert.equal(result[2].beforeHash, contentHash('PRIVATE_OLD_CODE\n')); assert.equal(result[2].afterHash, contentHash(''));
		assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
	});
	test('extracts only explicit allowlisted structured argument paths, never shell text', () => {
		const write = extractToolFileEvidence({ type: 'function_call', name: 'write_file',
			arguments: '{"path":"src/app.ts","content":"PRIVATE_CODE"}' }, relativeToolPath, excluded, false);
		assert.deepEqual(write, [{ relativePath: 'src/app.ts', operation: 'edit', kind: 'declared', origin: 'structured_arguments' }]);
		for (const input of [
			{ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"touch src/app.ts; DO_NOT_EXECUTE"}' },
			{ type: 'custom_tool_call', name: 'apply_patch', input: '*** Update File: src/app.ts\nPRIVATE_CODE' },
			{ type: 'function_call', name: 'write_file', arguments: 'write src/app.ts' }
			, { type: 'function_call', name: 'constructor', arguments: '{"path":"src/app.ts"}' }
		]) { assert.deepEqual(extractToolFileEvidence(input, relativeToolPath, excluded, false), []); }
	});
	test('respects relative cwd, exclusion rules, traversal, absolute paths and URI rejection', () => {
		assert.equal(relativeToolPath('src/app.ts', 'packages/app'), 'packages/app/src/app.ts');
		for (const path of ['../private.ts', '/private/file.ts', 'file:///private/file.ts', 'C:\\private.ts', 'a//b', 'a\u0000.ts']) {
			assert.equal(relativeToolPath(path), undefined);
		}
		const result = extractToolFileEvidence({ type: 'patch_apply_begin', changes: {
			'.env': { type: 'add', content: 'PRIVATE' }, 'node_modules/app.js': { type: 'delete', content: 'PRIVATE' },
			'../outside.ts': { type: 'add', content: 'PRIVATE' }, 'src/safe.ts': { type: 'add', content: 'safe\n' }
		} }, relativeToolPath, excluded, false);
		assert.deepEqual(result.map(item => item.relativePath), ['src/safe.ts']);
		assert.equal(result[0].kind, 'declared');
	});
	test('fingerprints exact edit blocks while rejecting malformed patches and preserving line positions', () => {
		const first = createTwoFilesPatch('before', 'after', 'a\nb\nc\n', 'a\nB\nc\n', undefined, undefined, { context: 1 });
		const second = createTwoFilesPatch('file.ts', 'file.ts', 'a\nb\nc\n', 'a\nB\nc\n', undefined, undefined, { context: 3 });
		assert.equal(patchChangeHash(first), patchChangeHash(second));
		assert.notEqual(patchChangeHash(first), patchChangeHash(createTwoFilesPatch('before', 'after', 'b\na\nc\n', 'B\na\nc\n')));
		assert.equal(patchChangeHash('not a patch'), undefined);
		assert.equal(patchChangeHash('@@ -1,10 +1,10 @@\n-old\n+new\n'), undefined);
	});
	test('ignores malformed structured changes and does not execute getters', () => {
		let accessed = false; const change = { type: 'add' };
		Object.defineProperty(change, 'content', { enumerable: true, get: () => { accessed = true; return 'PRIVATE'; } });
		assert.deepEqual(extractToolFileEvidence({ type: 'patch_apply_begin', changes: { 'src/a.ts': change } }, relativeToolPath, excluded, false), []);
		assert.equal(accessed, false);
	});
	test('bounds file evidence to 64 entries and represents moves conservatively', () => {
		const changes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['src/' + index + '.ts', { type: 'add', content: 'a\n' }]));
		assert.equal(extractToolFileEvidence({ type: 'patch_apply_begin', changes }, relativeToolPath, excluded, false).length, 64);
		const moved = extractToolFileEvidence({ type: 'patch_apply_end', changes: {
			'src/old.ts': { type: 'update', unified_diff: createTwoFilesPatch('before', 'after', 'a\n', 'b\n'), move_path: 'src/new.ts' }
		} }, relativeToolPath, excluded, true);
		assert.equal(moved[1].relativePath, 'src/new.ts'); assert.equal(moved[1].operation, 'unknown');
	});
});
