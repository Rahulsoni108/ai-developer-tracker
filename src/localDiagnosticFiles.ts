import { lstat, opendir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LocalEventQueue, LocalEventQueueError } from './localEventQueue';

const LEGACY_NAMES = new Set(['events.v1.jsonl', 'file-activity.jsonl']);
const DAILY_NAME = /^diagnostics\.v1\.(\d{4}-\d{2}-\d{2})\.jsonl$/;
export interface DiagnosticDirectories { legacy: readonly string[]; diagnostics: string }
interface Candidate { path: string; root: string; name: string; legacy: boolean; modified: number; size: number; device: number; inode: number }

/** Storage-worker-only filesystem maintenance. Never reads event/log contents or accepts a deletion path. */
export class LocalDiagnosticFiles {
	private readonly roots = new Map<string, { canonical: string; device: number; inode: number }>();
	constructor(private readonly directories: DiagnosticDirectories, private readonly folders: readonly { uri: { scheme: string; fsPath: string } }[]) {}
	private async checkRoot(root: string): Promise<boolean> {
		await LocalEventQueue.assertStorageOutsideWorkspaces({ scheme: 'file', fsPath: root }, this.folders);
		try {
			const info = await lstat(root);
			if (!info.isDirectory() || info.isSymbolicLink()) { throw new LocalEventQueueError('Unsafe local diagnostic storage.'); }
			const canonical = await realpath(root); const known = this.roots.get(root);
			if (known && (known.canonical !== canonical || known.device !== info.dev || known.inode !== info.ino)) { throw new LocalEventQueueError('Local diagnostic storage changed.'); }
			this.roots.set(root, { canonical, device: info.dev, inode: info.ino }); return true;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; } throw error; }
	}
	private async candidates(): Promise<Candidate[]> {
		const result: Candidate[] = [];
		const roots = [...new Set([...this.directories.legacy.map(root => resolve(root)), resolve(this.directories.diagnostics)])];
		for (const root of roots) {
			if (!await this.checkRoot(root)) { continue; }
			const names: string[] = root === resolve(this.directories.diagnostics) ? [] : [...LEGACY_NAMES];
			if (root === resolve(this.directories.diagnostics)) {
				const directory = await opendir(root);
				try {
					let entry;
					while ((entry = await directory.read())) {
						if (names.length >= 4096) { throw new LocalEventQueueError('Diagnostic directory scan limit exceeded.'); }
						names.push(entry.name);
					}
				} finally { await directory.close(); }
			}
			for (const name of names) {
				const day = DAILY_NAME.exec(name)?.[1];
				const validDay = day && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
				const legacy = LEGACY_NAMES.has(name) && this.directories.legacy.some(directory => resolve(directory) === root);
				if (!legacy && !(root === resolve(this.directories.diagnostics) && validDay)) { continue; }
				try {
					const path = join(root, name); const info = await lstat(path);
					if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) { throw new LocalEventQueueError('Unsafe local diagnostic file.'); }
					result.push({ path, root, name, legacy, modified: info.mtimeMs, size: info.size, device: info.dev, inode: info.ino });
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
			}
		}
		return result;
	}
	async summary(): Promise<{ legacyLogCount: number; diagnosticFileCount: number }> {
		const files = await this.candidates();
		return { legacyLogCount: files.filter(file => file.legacy && file.size > 0).length, diagnosticFileCount: files.filter(file => !file.legacy).length };
	}
	async remove(mode: 'legacy' | 'all' | 'expired', cutoff?: string): Promise<number> {
		if (mode === 'expired' && (!cutoff || !Number.isFinite(Date.parse(cutoff)))) { throw new LocalEventQueueError('Invalid diagnostic expiration.'); }
		let deleted = 0;
		for (const file of await this.candidates()) {
			if (mode === 'legacy' && !file.legacy || mode === 'expired' && (file.legacy || file.modified >= Date.parse(cutoff!)
				|| !DAILY_NAME.exec(file.name) || Date.parse(DAILY_NAME.exec(file.name)![1] + 'T00:00:00.000Z') >= Date.parse(cutoff!))) { continue; }
			await this.checkRoot(file.root);
			const current = await lstat(file.path);
			if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== file.device || current.ino !== file.inode) {
				throw new LocalEventQueueError('Local diagnostic file changed.');
			}
			await unlink(file.path); deleted++;
		}
		return deleted;
	}
}
