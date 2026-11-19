import * as assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	getCodeUserStorageDirs,
	normalizeWorkspacePath,
	pathsMatch,
	findCopilotWorkspaceStorageDir,
	resolveCopilotChatSessionsDir,
	discoverCopilotWorkspace
} from '../copilotDiscovery';

suite('Copilot Chat Discovery', () => {
	let testDir: string;

	setup(async () => {
		testDir = join(tmpdir(), `copilot-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
	});

	teardown(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	suite('getCodeUserStorageDirs', () => {
		test('resolves macOS paths correctly', () => {
			const dirs = getCodeUserStorageDirs({
				platform: 'darwin',
				homeDir: '/Users/testuser'
			});
			assert.ok(dirs.includes('/Users/testuser/Library/Application Support/Code/User'));
			assert.ok(dirs.includes('/Users/testuser/Library/Application Support/Code - Insiders/User'));
			assert.ok(dirs.includes('/Users/testuser/Library/Application Support/VSCodium/User'));
		});

		test('resolves Windows paths using APPDATA', () => {
			const dirs = getCodeUserStorageDirs({
				platform: 'win32',
				appDataDir: 'C:\\Users\\testuser\\AppData\\Roaming'
			});
			assert.ok(dirs.some(d => d.includes('Code\\User') || d.includes('Code/User')));
		});

		test('resolves Linux paths using XDG_CONFIG_HOME', () => {
			const dirs = getCodeUserStorageDirs({
				platform: 'linux',
				xdgConfigHome: '/home/testuser/.custom-config'
			});
			assert.ok(dirs.includes('/home/testuser/.custom-config/Code/User'));
			assert.ok(dirs.includes('/home/testuser/.custom-config/Code - Insiders/User'));
		});

		test('respects explicit codeUserDir override', () => {
			const custom = join(testDir, 'custom-code-user');
			const dirs = getCodeUserStorageDirs({ codeUserDir: custom });
			assert.equal(dirs.length, 1);
			assert.equal(dirs[0], custom);
		});

		test('respects explicit codeUserDirs array', () => {
			const custom1 = join(testDir, 'dir1');
			const custom2 = join(testDir, 'dir2');
			const dirs = getCodeUserStorageDirs({ codeUserDirs: [custom1, custom2] });
			assert.equal(dirs.length, 2);
			assert.equal(dirs[0], custom1);
			assert.equal(dirs[1], custom2);
		});
	});

	suite('normalizeWorkspacePath & pathsMatch', () => {
		test('normalizes file:// URIs and standard paths', () => {
			const fileUri = 'file:///Users/testuser/project';
			const standard = '/Users/testuser/project';
			assert.equal(normalizeWorkspacePath(fileUri), standard);
		});

		test('decodes percent-encoded URIs with spaces and special characters', () => {
			const encodedUri = 'file:///Users/testuser/My%20Projects/App%20Test';
			const standard = '/Users/testuser/My Projects/App Test';
			assert.equal(normalizeWorkspacePath(encodedUri), standard);
		});

		test('handles case-insensitivity on darwin and win32', () => {
			assert.equal(pathsMatch('/Users/Test/Repo', '/users/test/repo', 'darwin'), true);
			assert.equal(pathsMatch('C:\\Projects\\App', 'c:\\projects\\app', 'win32'), true);
			assert.equal(pathsMatch('/home/test/Repo', '/home/test/repo', 'linux'), false);
		});
	});

	suite('findCopilotWorkspaceStorageDir & resolveCopilotChatSessionsDir', () => {
		test('finds workspace directory matching workspace.json folder', async () => {
			const userDir = join(testDir, 'Code', 'User');
			const wsId = 'workspace-123';
			const wsStorageDir = join(userDir, 'workspaceStorage', wsId);
			await mkdir(wsStorageDir, { recursive: true });

			const projectDir = join(testDir, 'my-project');
			await mkdir(projectDir, { recursive: true });

			await writeFile(
				join(wsStorageDir, 'workspace.json'),
				JSON.stringify({ folder: `file://${projectDir}` })
			);

			const match = await findCopilotWorkspaceStorageDir(projectDir, { codeUserDir: userDir });
			assert.ok(match);
			assert.equal(match.workspaceId, wsId);
			assert.equal(match.workspaceStorageDir, wsStorageDir);
		});

		test('finds workspace directory matching workspace.json workspace file', async () => {
			const userDir = join(testDir, 'Code', 'User');
			const wsId = 'ws-code-workspace';
			const wsStorageDir = join(userDir, 'workspaceStorage', wsId);
			await mkdir(wsStorageDir, { recursive: true });

			const workspaceFile = join(testDir, 'my-project', 'project.code-workspace');

			await writeFile(
				join(wsStorageDir, 'workspace.json'),
				JSON.stringify({ workspace: `file://${workspaceFile}` })
			);

			const match = await findCopilotWorkspaceStorageDir(workspaceFile, { codeUserDir: userDir });
			assert.ok(match);
			assert.equal(match.workspaceId, wsId);
		});

		test('resolves chatSessions folder when it exists', async () => {
			const userDir = join(testDir, 'Code', 'User');
			const wsId = 'workspace-chats';
			const wsStorageDir = join(userDir, 'workspaceStorage', wsId);
			const chatSessionsDir = join(wsStorageDir, 'chatSessions');
			await mkdir(chatSessionsDir, { recursive: true });

			const projectDir = join(testDir, 'chat-project');
			await mkdir(projectDir, { recursive: true });

			await writeFile(
				join(wsStorageDir, 'workspace.json'),
				JSON.stringify({ folder: projectDir })
			);

			const resolved = await resolveCopilotChatSessionsDir(projectDir, { codeUserDir: userDir });
			assert.equal(resolved.chatSessionsDir, chatSessionsDir);
			assert.equal(resolved.workspaceId, wsId);
		});

		test('handles missing chatSessions folder gracefully', async () => {
			const userDir = join(testDir, 'Code', 'User');
			const wsId = 'workspace-no-chats';
			const wsStorageDir = join(userDir, 'workspaceStorage', wsId);
			await mkdir(wsStorageDir, { recursive: true });

			const projectDir = join(testDir, 'no-chat-project');
			await mkdir(projectDir, { recursive: true });

			await writeFile(
				join(wsStorageDir, 'workspace.json'),
				JSON.stringify({ folder: projectDir })
			);

			const resolved = await resolveCopilotChatSessionsDir(projectDir, { codeUserDir: userDir });
			assert.equal(resolved.chatSessionsDir, undefined);
			assert.equal(resolved.workspaceId, wsId);
		});
	});

	suite('discoverCopilotWorkspace (End-to-End Discovery)', () => {
		test('returns storage_dir_missing if workspaceStorage does not exist in any Code directory', async () => {
			const emptyDir = join(testDir, 'nonexistent-user');
			const result = await discoverCopilotWorkspace('/dummy/project', { codeUserDir: emptyDir });
			assert.equal(result.status, 'storage_dir_missing');
		});

		test('returns workspace_not_found if no storage folder matches project path', async () => {
			const userDir = join(testDir, 'Code', 'User');
			await mkdir(join(userDir, 'workspaceStorage'), { recursive: true });

			const result = await discoverCopilotWorkspace('/some/untracked/project', { codeUserDir: userDir });
			assert.equal(result.status, 'workspace_not_found');
		});

		test('returns chat_sessions_missing if workspace matches but chatSessions folder does not exist', async () => {
			const userDir = join(testDir, 'Code', 'User');
			const wsStorage = join(userDir, 'workspaceStorage', 'ws-test-1');
			await mkdir(wsStorage, { recursive: true });
			const project = join(testDir, 'proj-1');

			await writeFile(join(wsStorage, 'workspace.json'), JSON.stringify({ folder: project }));

			const result = await discoverCopilotWorkspace(project, { codeUserDir: userDir });
			assert.equal(result.status, 'chat_sessions_missing');
			assert.equal(result.workspaceId, 'ws-test-1');
		});

		test('returns ready with chatSessionsDir when everything is present', async () => {
			const userDir = join(testDir, 'Code', 'User');
			const wsStorage = join(userDir, 'workspaceStorage', 'ws-test-2');
			const chatSessions = join(wsStorage, 'chatSessions');
			await mkdir(chatSessions, { recursive: true });
			const project = join(testDir, 'proj-2');

			await writeFile(join(wsStorage, 'workspace.json'), JSON.stringify({ folder: project }));

			const result = await discoverCopilotWorkspace(project, { codeUserDir: userDir });
			assert.equal(result.status, 'ready');
			assert.equal(result.workspaceId, 'ws-test-2');
			assert.equal(result.chatSessionsDir, chatSessions);
		});

		test('discovers real VS Code workspace on host machine if present', async () => {
			const project = '/Users/rails/AI-Assisted Developer Assessment /start-check';
			const result = await discoverCopilotWorkspace(project);
			if (result.status === 'ready') {
				assert.ok(result.chatSessionsDir?.includes('chatSessions'));
				assert.equal(result.workspaceId, 'd9445192f14813f2669cb34571389809');
			}
		});
	});
});
