import { stat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize, resolve, sep, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CursorDiscoveryStatus =
	| 'ready'
	| 'not_cursor'
	| 'storage_dir_missing'
	| 'workspace_not_found'
	| 'db_not_found'
	| 'unreadable_db'
	| 'error';

export interface CursorDiscoveryOptions {
	/** Process platform: 'darwin' | 'win32' | 'linux', defaults to process.platform */
	platform?: NodeJS.Platform;
	/** User home directory override */
	homeDir?: string;
	/** Windows APPDATA directory override */
	appDataDir?: string;
	/** Linux XDG_CONFIG_HOME directory override */
	xdgConfigHome?: string;
	/** Explicit Cursor user directory override (e.g. ~/Library/Application Support/Cursor/User) */
	cursorUserDir?: string;
	/** VS Code / Cursor environment app name (e.g. vscode.env.appName) */
	appName?: string;
	/** Require appName to match Cursor (defaults to true if appName is provided) */
	requireCursorApp?: boolean;
}

export interface CursorDiscoveryResult {
	isCursor: boolean;
	status: CursorDiscoveryStatus;
	cursorUserDir?: string;
	workspaceStorageDir?: string;
	workspaceId?: string;
	stateDbPath?: string;
	errorMessage?: string;
}

interface WorkspaceJsonContent {
	folder?: string;
	workspace?: string;
}

/**
 * Checks whether the environment is Cursor IDE based on the app name.
 */
export function isCursorEnvironment(appName?: string): boolean {
	const name = (appName ?? process.env.CURSOR_APP_NAME ?? '').trim().toLowerCase();
	return name.includes('cursor');
}

/**
 * Resolves the platform-specific Cursor User directory.
 */
export function getCursorUserStorageDir(options: CursorDiscoveryOptions = {}): string {
	const platform = options.platform ?? process.platform;
	const pathLib = platform === 'win32' ? win32 : posix;

	if (options.cursorUserDir) {
		return pathLib.normalize(options.cursorUserDir);
	}
	const home = options.homeDir ?? homedir();

	if (platform === 'darwin') {
		return pathLib.join(home, 'Library', 'Application Support', 'Cursor', 'User');
	}
	if (platform === 'win32') {
		const appData = options.appDataDir ?? process.env.APPDATA ?? pathLib.join(home, 'AppData', 'Roaming');
		return pathLib.join(appData, 'Cursor', 'User');
	}
	// Linux & other Unix platforms
	const xdg = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? pathLib.join(home, '.config');
	return pathLib.join(xdg, 'Cursor', 'User');
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
			// Fallback: strip file:// prefix and decode percent-encodings
			resolved = decodeURIComponent(resolved.replace(/^file:\/\//, ''));
		}
	}
	resolved = normalize(resolve(resolved));
	// Normalize drive letters on Windows (e.g., C:\ -> c:\)
	if (/^[a-zA-Z]:[\\/]/.test(resolved)) {
		resolved = resolved.charAt(0).toLowerCase() + resolved.slice(1);
	}
	// Strip trailing slashes unless it's root
	if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
		resolved = resolved.slice(0, -1);
	}
	return resolved;
}

/**
 * Checks if two workspace paths refer to the same folder on disk.
 */
export function pathsMatch(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
	const normA = normalizeWorkspacePath(a);
	const normB = normalizeWorkspacePath(b);
	if (platform === 'win32' || platform === 'darwin') {
		// macOS and Windows are generally case-insensitive for file paths
		return normA.toLowerCase() === normB.toLowerCase();
	}
	return normA === normB;
}

/**
 * Searches Cursor's workspaceStorage folder to find the storage directory for the given workspace path.
 */
export async function findCursorWorkspaceStorageDir(
	targetWorkspacePath: string,
	cursorUserDir: string,
	platform: NodeJS.Platform = process.platform
): Promise<{ workspaceId: string; workspaceStorageDir: string } | undefined> {
	const workspaceStorageParent = join(cursorUserDir, 'workspaceStorage');
	let entries;
	try {
		entries = await readdir(workspaceStorageParent, { withFileTypes: true });
	} catch {
		return undefined;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const candidateDir = join(workspaceStorageParent, entry.name);
		const workspaceJsonPath = join(candidateDir, 'workspace.json');
		try {
			const content = await readFile(workspaceJsonPath, 'utf8');
			const parsed = JSON.parse(content) as WorkspaceJsonContent;
			const targetUri = parsed.folder ?? parsed.workspace;
			if (typeof targetUri === 'string' && pathsMatch(targetUri, targetWorkspacePath, platform)) {
				return { workspaceId: entry.name, workspaceStorageDir: candidateDir };
			}
		} catch {
			// Skip missing, unreadable, or malformed workspace.json
			continue;
		}
	}
	return undefined;
}

/**
 * Resolves the state.vscdb database path inside a discovered workspace storage directory.
 */
export async function resolveCursorStateDbPath(workspaceStorageDir: string): Promise<{ exists: boolean; path: string }> {
	const dbPath = join(workspaceStorageDir, 'state.vscdb');
	try {
		const s = await stat(dbPath);
		return { exists: s.isFile(), path: dbPath };
	} catch {
		return { exists: false, path: dbPath };
	}
}

/**
 * Complete discovery entry point for Cursor IDE workspace storage.
 */
export async function discoverCursorWorkspace(
	workspacePath: string,
	options: CursorDiscoveryOptions = {}
): Promise<CursorDiscoveryResult> {
	const isCursor = options.appName ? isCursorEnvironment(options.appName) : isCursorEnvironment();

	// If appName is given and caller requires Cursor app, abort early if not running in Cursor
	if (options.appName && options.requireCursorApp !== false && !isCursor) {
		return {
			isCursor: false,
			status: 'not_cursor'
		};
	}

	const cursorUserDir = getCursorUserStorageDir(options);

	// Verify workspaceStorage parent directory exists
	const workspaceStorageParent = join(cursorUserDir, 'workspaceStorage');
	try {
		const parentStat = await stat(workspaceStorageParent);
		if (!parentStat.isDirectory()) {
			return {
				isCursor,
				cursorUserDir,
				status: 'storage_dir_missing',
				errorMessage: 'workspaceStorage is not a directory'
			};
		}
	} catch (err: unknown) {
		return {
			isCursor,
			cursorUserDir,
			status: 'storage_dir_missing',
			errorMessage: err instanceof Error ? err.message : String(err)
		};
	}

	// Locate workspace storage directory
	const found = await findCursorWorkspaceStorageDir(workspacePath, cursorUserDir, options.platform);
	if (!found) {
		return {
			isCursor,
			cursorUserDir,
			status: 'workspace_not_found',
			errorMessage: `No matching Cursor workspaceStorage entry found for ${workspacePath}`
		};
	}

	// Verify state.vscdb
	const db = await resolveCursorStateDbPath(found.workspaceStorageDir);
	if (!db.exists) {
		return {
			isCursor,
			cursorUserDir,
			workspaceStorageDir: found.workspaceStorageDir,
			workspaceId: found.workspaceId,
			status: 'db_not_found',
			errorMessage: `state.vscdb not found at ${db.path}`
		};
	}

	return {
		isCursor,
		status: 'ready',
		cursorUserDir,
		workspaceStorageDir: found.workspaceStorageDir,
		workspaceId: found.workspaceId,
		stateDbPath: db.path
	};
}
