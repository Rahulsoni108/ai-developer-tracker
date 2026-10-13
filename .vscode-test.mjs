import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Keep macOS IPC socket paths below the limit, even in a long workspace path.
	launchArgs: [`--user-data-dir=${mkdtempSync(join(tmpdir(), 'ai-tracker-'))}`],
});
