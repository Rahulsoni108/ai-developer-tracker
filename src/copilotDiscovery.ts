import { stat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize, resolve, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CopilotDiscoveryStatus =
	| 'ready'
	| 'storage_dir_missing'
	| 'workspace_not_found'
	| 'chat_sessions_missing'
	| 'error';

export interface CopilotDiscoveryOptions {
	/** Process platform: 'darwin' | 'win32' | 'linux', defaults to process.platform */
	platform?: NodeJS.Platform;
	/** User home directory override */
	homeDir?: string;
	/** Windows APPDATA directory override */
	appDataDir?: string;
	/** Linux XDG_CONFIG_HOME directory override */
	xdgConfigHome?: string;
	/** Explicit Code user directory override (e.g. ~/Library/Application Support/Code/User) */
	codeUserDir?: string;
	/** Explicit array of Code user directories to search */
	codeUserDirs?: string[];
	/** Custom app name (e.g. 'Visual Studio Code', 'Code - Insiders') */
	appName?: string;
}

export interface CopilotDiscoveryResult {
	status: CopilotDiscoveryStatus;
	codeUserDir?: string;
	workspaceStorageDir?: string;
	workspaceId?: string;
	chatSessionsDir?: string;
	errorMessage?: string;
}

interface WorkspaceJsonContent {
	folder?: string;
	workspace?: string;
}

/**
 * Resolves potential Code User directories for the platform.
 */
export function getCodeUserStorageDirs(options: CopilotDiscoveryOptions = {}): string[] {
	if (options.codeUserDirs && options.codeUserDirs.length > 0) {
		return options.codeUserDirs.map(d => normalize(d));
	}
	if (options.codeUserDir) {
		return [normalize(options.codeUserDir)];
	}

	const platform = options.platform ?? process.platform;
	const pathLib = platform === 'win32' ? win32 : posix;
	const home = options.homeDir ?? homedir();

	const appVariants = ['Code', 'Code - Insiders', 'Code - OSS', 'VSCodium'];

	if (platform === 'darwin') {
		const base = pathLib.join(home, 'Library', 'Application Support');
		return appVariants.map(variant => pathLib.join(base, variant, 'User'));
	}

	if (platform === 'win32') {
		const appData = options.appDataDir ?? process.env.APPDATA ?? pathLib.join(home, 'AppData', 'Roaming');
		return appVariants.map(variant => pathLib.join(appData, variant, 'User'));
	}

	// Linux & other Unix platforms
	const xdg = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? pathLib.join(home, '.config');
	return appVariants.map(variant => pathLib.join(xdg, variant, 'User'));
}

/**
 * Normalizes a file system path or file:// URI into a canonical absolute path.
 */
export function normalizeWorkspacePath(pathOrUri: string): string {
	let resolved = pathOrUri.trim();
	if (resolved.startsWith('file://')) {
		try {
			resolved = fileURLToPath(resolved);
		} catch {
			resolved = decodeURIComponent(resolved.replace(/^file:\/\//, ''));
		}
	}
	resolved = normalize(resolve(resolved));
	if (/^[a-zA-Z]:[\\/]/.test(resolved)) {
		resolved = resolved.charAt(0).toLowerCase() + resolved.slice(1);
	}
	if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
		resolved = resolved.slice(0, -1);
	}
	return resolved;
}

/**
 * Checks if two workspace paths or URIs refer to the same folder on disk.
 */
export function pathsMatch(pathA: string, pathB: string, platform?: NodeJS.Platform): boolean {
	const currentPlatform = platform ?? process.platform;
	const normA = normalizeWorkspacePath(pathA);
	const normB = normalizeWorkspacePath(pathB);

	if (currentPlatform === 'win32' || currentPlatform === 'darwin') {
		return normA.toLowerCase() === normB.toLowerCase();
	}
	return normA === normB;
}

/**
 * Scans workspaceStorage folders in Code user directories to locate the storage folder
 * matching the given workspace root path.
 */
export async function findCopilotWorkspaceStorageDir(
	workspacePath: string,
	options: CopilotDiscoveryOptions = {}
): Promise<{ workspaceStorageDir: string; workspaceId: string; codeUserDir: string } | undefined> {
	const userDirs = getCodeUserStorageDirs(options);

	for (const userDir of userDirs) {
		const storageDir = join(userDir, 'workspaceStorage');
		let entries: string[];
		try {
			entries = await readdir(storageDir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const candidateDir = join(storageDir, entry);
			const workspaceJsonPath = join(candidateDir, 'workspace.json');

			try {
				const content = await readFile(workspaceJsonPath, 'utf8');
				const parsed: WorkspaceJsonContent = JSON.parse(content);
				const target = parsed.folder ?? parsed.workspace;

				if (target && pathsMatch(workspacePath, target, options.platform)) {
					return {
						workspaceStorageDir: candidateDir,
						workspaceId: entry,
						codeUserDir: userDir
					};
				}
			} catch {
				// Skip entries without valid workspace.json
			}
		}
	}

	return undefined;
}

/**
 * Resolves the path to the chatSessions folder for the specified workspace.
 */
export async function resolveCopilotChatSessionsDir(
	workspacePath: string,
	options: CopilotDiscoveryOptions = {}
): Promise<{ chatSessionsDir?: string; workspaceStorageDir?: string; workspaceId?: string; codeUserDir?: string }> {
	const match = await findCopilotWorkspaceStorageDir(workspacePath, options);
	if (!match) {
		return {};
	}

	const chatSessionsDir = join(match.workspaceStorageDir, 'chatSessions');
	try {
		const s = await stat(chatSessionsDir);
		if (s.isDirectory()) {
			return {
				chatSessionsDir,
				workspaceStorageDir: match.workspaceStorageDir,
				workspaceId: match.workspaceId,
				codeUserDir: match.codeUserDir
			};
		}
	} catch {
		// chatSessions does not exist yet
	}

	return {
		workspaceStorageDir: match.workspaceStorageDir,
		workspaceId: match.workspaceId,
		codeUserDir: match.codeUserDir
	};
}

/**
 * Full end-to-end discovery of GitHub Copilot Chat storage for an active workspace.
 */
export async function discoverCopilotWorkspace(
	workspacePath: string,
	options: CopilotDiscoveryOptions = {}
): Promise<CopilotDiscoveryResult> {
	try {
		const userDirs = getCodeUserStorageDirs(options);
		let hasAnyStorage = false;

		for (const userDir of userDirs) {
			try {
				const s = await stat(join(userDir, 'workspaceStorage'));
				if (s.isDirectory()) {
					hasAnyStorage = true;
					break;
				}
			} catch {
				// not present
			}
		}

		if (!hasAnyStorage) {
			return {
				status: 'storage_dir_missing',
				codeUserDir: userDirs[0],
				errorMessage: `VS Code workspaceStorage directory not found in ${userDirs.join(', ')}`
			};
		}

		const resolved = await resolveCopilotChatSessionsDir(workspacePath, options);

		if (!resolved.workspaceStorageDir) {
			return {
				status: 'workspace_not_found',
				codeUserDir: resolved.codeUserDir ?? userDirs[0],
				errorMessage: `No workspaceStorage folder matched workspace path: ${workspacePath}`
			};
		}

		if (!resolved.chatSessionsDir) {
			return {
				status: 'chat_sessions_missing',
				codeUserDir: resolved.codeUserDir,
				workspaceStorageDir: resolved.workspaceStorageDir,
				workspaceId: resolved.workspaceId,
				errorMessage: `chatSessions folder not found in ${resolved.workspaceStorageDir}`
			};
		}

		return {
			status: 'ready',
			codeUserDir: resolved.codeUserDir,
			workspaceStorageDir: resolved.workspaceStorageDir,
			workspaceId: resolved.workspaceId,
			chatSessionsDir: resolved.chatSessionsDir
		};
	} catch (error) {
		return {
			status: 'error',
			errorMessage: error instanceof Error ? error.message : String(error)
		};
	}
}
