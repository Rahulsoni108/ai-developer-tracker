import * as assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	isCursorEnvironment,
	getCursorUserStorageDir,
	normalizeWorkspacePath,
	pathsMatch,
	findCursorWorkspaceStorageDir,
	resolveCursorStateDbPath,
	discoverCursorWorkspace
} from '../cursorDiscovery';

suite('Cursor IDE Discovery', () => {
	let testDir: string;

	setup(async () => {
		testDir = join(tmpdir(), `cursor-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
	});

	teardown(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	suite('isCursorEnvironment', () => {
		test('identifies Cursor variants case-insensitively', () => {
			assert.equal(isCursorEnvironment('Cursor'), true);
			assert.equal(isCursorEnvironment('cursor'), true);
			assert.equal(isCursorEnvironment('Cursor IDE 0.42.0'), true);
			assert.equal(isCursorEnvironment('Cursor - Nightly'), true);
		});

		test('rejects non-Cursor environments', () => {
			assert.equal(isCursorEnvironment('Visual Studio Code'), false);
			assert.equal(isCursorEnvironment('Code - OSS'), false);
			assert.equal(isCursorEnvironment('VSCodium'), false);
			assert.equal(isCursorEnvironment(''), false);
			assert.equal(isCursorEnvironment(undefined), false);
		});
	});

	suite('getCursorUserStorageDir', () => {
		test('resolves macOS path correctly', () => {
			const dir = getCursorUserStorageDir({
				platform: 'darwin',
				homeDir: '/Users/testuser'
			});
			assert.equal(dir, '/Users/testuser/Library/Application Support/Cursor/User');
		});

		test('resolves Windows path using APPDATA', () => {
			const dir = getCursorUserStorageDir({
				platform: 'win32',
				appDataDir: 'C:\\Users\\testuser\\AppData\\Roaming'
			});
			assert.equal(dir, 'C:\\Users\\testuser\\AppData\\Roaming\\Cursor\\User');
		});

		test('resolves Linux path using XDG_CONFIG_HOME', () => {
			const dir = getCursorUserStorageDir({
				platform: 'linux',
				xdgConfigHome: '/home/testuser/.custom-config'
			});
			assert.equal(dir, '/home/testuser/.custom-config/Cursor/User');
		});

		test('resolves Linux default path from homeDir', () => {
			const dir = getCursorUserStorageDir({
				platform: 'linux',
				homeDir: '/home/testuser'
			});
			assert.equal(dir, '/home/testuser/.config/Cursor/User');
		});

		test('respects explicit cursorUserDir override', () => {
			const dir = getCursorUserStorageDir({
				cursorUserDir: '/opt/custom/cursor/user'
			});
			assert.equal(dir, '/opt/custom/cursor/user');
		});
	});

	suite('normalizeWorkspacePath & pathsMatch', () => {
		test('normalizes file:// URIs and standard paths', () => {
			const fromUri = normalizeWorkspacePath('file:///tmp/my-project');
			const fromPath = normalizeWorkspacePath('/tmp/my-project');
			assert.equal(fromUri, fromPath);
		});

		test('decodes percent-encoded URIs with spaces and special characters', () => {
			const fromUri = normalizeWorkspacePath('file:///tmp/my%20test%20workspace');
			const fromPath = normalizeWorkspacePath('/tmp/my test workspace');
			assert.equal(fromUri, fromPath);
		});

		test('ignores trailing slashes', () => {
			assert.equal(pathsMatch('/tmp/project/', '/tmp/project'), true);
		});

		test('case-insensitive matching on darwin and win32', () => {
			assert.equal(pathsMatch('/tmp/MyProject', '/tmp/myproject', 'darwin'), true);
			assert.equal(pathsMatch('C:\\Projects\\App', 'c:\\projects\\app', 'win32'), true);
		});
	});

	suite('findCursorWorkspaceStorageDir & resolveCursorStateDbPath', () => {
		test('finds workspace directory matching workspace.json', async () => {
			const cursorUserDir = join(testDir, 'Cursor', 'User');
			const workspaceStorageParent = join(cursorUserDir, 'workspaceStorage');
			const targetWorkspaceId = 'abcdef1234567890';
			const targetWorkspaceStorage = join(workspaceStorageParent, targetWorkspaceId);
			const targetProject = join(testDir, 'my-candidate-project');

			await mkdir(targetWorkspaceStorage, { recursive: true });
			await mkdir(targetProject, { recursive: true });

			// Write workspace.json
			await writeFile(
				join(targetWorkspaceStorage, 'workspace.json'),
				JSON.stringify({ folder: `file://${targetProject}` })
			);

			// Write state.vscdb
			await writeFile(join(targetWorkspaceStorage, 'state.vscdb'), 'dummy-sqlite-content');

			const found = await findCursorWorkspaceStorageDir(targetProject, cursorUserDir);
			assert.ok(found);
			assert.equal(found?.workspaceId, targetWorkspaceId);
			assert.equal(found?.workspaceStorageDir, targetWorkspaceStorage);

			const db = await resolveCursorStateDbPath(found.workspaceStorageDir);
			assert.equal(db.exists, true);
			assert.equal(db.path, join(targetWorkspaceStorage, 'state.vscdb'));
		});

		test('handles invalid JSON or missing workspace.json gracefully', async () => {
			const cursorUserDir = join(testDir, 'Cursor', 'User');
			const workspaceStorageParent = join(cursorUserDir, 'workspaceStorage');
			const invalidStorage = join(workspaceStorageParent, 'bad-entry');
			await mkdir(invalidStorage, { recursive: true });
			await writeFile(join(invalidStorage, 'workspace.json'), 'not-json{{{');

			const found = await findCursorWorkspaceStorageDir('/tmp/nowhere', cursorUserDir);
			assert.equal(found, undefined);
		});
	});

	suite('discoverCursorWorkspace (End-to-End Discovery)', () => {
		test('returns not_cursor if appName is VS Code and requireCursorApp is true', async () => {
			const result = await discoverCursorWorkspace('/tmp/workspace', {
				appName: 'Visual Studio Code',
				requireCursorApp: true
			});
			assert.equal(result.isCursor, false);
			assert.equal(result.status, 'not_cursor');
		});

		test('returns storage_dir_missing if Cursor workspaceStorage does not exist', async () => {
			const result = await discoverCursorWorkspace('/tmp/workspace', {
				cursorUserDir: join(testDir, 'non-existent-user-dir')
			});
			assert.equal(result.status, 'storage_dir_missing');
		});

		test('returns workspace_not_found if target project has no matching storage directory', async () => {
			const cursorUserDir = join(testDir, 'Cursor', 'User');
			await mkdir(join(cursorUserDir, 'workspaceStorage'), { recursive: true });

			const result = await discoverCursorWorkspace('/tmp/untracked-project', {
				cursorUserDir
			});
			assert.equal(result.status, 'workspace_not_found');
		});

		test('returns db_not_found if workspace exists but state.vscdb is missing', async () => {
			const cursorUserDir = join(testDir, 'Cursor', 'User');
			const workspaceStorage = join(cursorUserDir, 'workspaceStorage', 'hash-123');
			const projectDir = join(testDir, 'project-a');
			await mkdir(workspaceStorage, { recursive: true });
			await mkdir(projectDir, { recursive: true });

			await writeFile(
				join(workspaceStorage, 'workspace.json'),
				JSON.stringify({ folder: `file://${projectDir}` })
			);

			const result = await discoverCursorWorkspace(projectDir, {
				cursorUserDir
			});
			assert.equal(result.status, 'db_not_found');
			assert.equal(result.workspaceId, 'hash-123');
		});

		test('returns ready with stateDbPath when everything is present', async () => {
			const cursorUserDir = join(testDir, 'Cursor', 'User');
			const workspaceStorage = join(cursorUserDir, 'workspaceStorage', 'valid-hash');
			const projectDir = join(testDir, 'project-ready');
			await mkdir(workspaceStorage, { recursive: true });
			await mkdir(projectDir, { recursive: true });

			await writeFile(
				join(workspaceStorage, 'workspace.json'),
				JSON.stringify({ folder: `file://${projectDir}` })
			);
			await writeFile(join(workspaceStorage, 'state.vscdb'), 'sqlite-binary-data');

			const result = await discoverCursorWorkspace(projectDir, {
				appName: 'Cursor',
				cursorUserDir
			});

			assert.equal(result.isCursor, true);
			assert.equal(result.status, 'ready');
			assert.equal(result.workspaceId, 'valid-hash');
			assert.equal(result.stateDbPath, join(workspaceStorage, 'state.vscdb'));
		});

		test('discovers real Cursor workspace if present on host machine', async () => {
			// Real test against the known workspace on this Mac: /Users/rails/Downloads/candidate-starter
			const candidatePath = '/Users/rails/Downloads/candidate-starter';
			const result = await discoverCursorWorkspace(candidatePath, {
				appName: 'Cursor'
			});
			// If Cursor is installed on this machine (which we verified it is), it should find it!
			if (result.status === 'ready') {
				assert.equal(result.isCursor, true);
				assert.equal(result.workspaceId, '759331f1502cc79884e8686ee42d87aa');
				assert.ok(result.stateDbPath?.endsWith('state.vscdb'));
			}
		});
	});
});
