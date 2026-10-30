import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordingController } from '../recording';
import { ManagedCodexCapture } from '../managedCodexCapture';
import type { TrackerEvent } from '../eventSchema';

suite('Managed assessment Codex isolation', function () {
 this.timeout(12000);
 let root: string; let workspace: string; let recording: RecordingController; let capture: ManagedCodexCapture;
 let events: TrackerEvent[]; let enrollments: string[]; let allowed: boolean; let enrollmentFails: boolean;
 const W = 'a'.repeat(64);
 async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 6500; while (!check()) { if (Date.now() > end) { assert.fail('Synthetic managed-source timeout'); } await new Promise(resolve => setTimeout(resolve, 25)); }
 }
 async function session(home: string, cwd: string, timestamp = new Date().toISOString()) {
  const id = randomUUID(); const file = join(home, 'sessions', timestamp.slice(0,10).replace(/-/g,'/'), 'candidate-' + id + '.jsonl');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ type: 'session_meta', timestamp, payload: { id, cwd, timestamp, cli_version: 'synthetic' } }) + '\n');
  return { id, file };
 }
 setup(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'managed-codex-'))); workspace = join(root, 'workspace'); await mkdir(workspace);
  events = []; enrollments = []; allowed = true; enrollmentFails = false;
  recording = new RecordingController({ text: '', command: '', tooltip: '', show() {}, dispose() {} }, async () => true);
  capture = new ManagedCodexCapture(recording, { write: async event => { events.push(event); }, flush: async () => {} }, {
   permits: id => allowed && recording.isRecording && recording.sessionId === id,
   enroll: async (_provider, id) => { if (enrollmentFails) { throw new Error('Synthetic unavailable'); } enrollments.push(id); return new Date().toISOString(); }
  }, join(root, 'provider-state'), async path => { assert.ok(!path.startsWith(workspace)); }, () => {});
  await recording.start();
 });
 teardown(async () => { recording.stop(); await capture.flush(); await capture.dispose(); recording.dispose(); await rm(root, { recursive: true, force: true }); });
 test('enrolls only newly launched private-home sessions and captures new visible messages after enrollment', async () => {
  const launch = await capture.create(workspace, W); const source = await session(launch.home, workspace);
  await until(() => capture.getApprovals(recording.sessionId!).length === 1);
  await appendFile(source.file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: 'Synthetic assessment prompt' } }) + '\n');
  await until(() => events.some(e => e.eventType === 'ai.prompt.submitted'));
  assert.deepEqual(enrollments, [source.id]); assert.equal(events[0].sessionId, recording.sessionId); assert.equal(events[0].workspaceId, W);
 });
 test('does not scan another home or accept out-of-workspace and historical sessions', async () => {
  const launch = await capture.create(workspace, W);
  await session(join(root, 'unrelated-home'), workspace);
  const outside = join(root, 'outside'); await mkdir(outside); await session(launch.home, outside);
  await session(launch.home, workspace, new Date(Date.now() - 60000).toISOString());
  await new Promise(resolve => setTimeout(resolve, 1800)); await capture.flush();
  assert.equal(enrollments.length, 0); assert.equal(events.length, 0);
 });
 test('failed enrollment and stopped recording never authorize content', async () => {
  enrollmentFails = true; const launch = await capture.create(workspace, W); const source = await session(launch.home, workspace);
  await appendFile(source.file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: 'Synthetic blocked prompt' } }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 1800)); await capture.flush(); assert.equal(events.length, 0);
  recording.stop(); await assert.rejects(capture.create(workspace, W)); assert.equal(events.length, 0);
 });
 test('explicit denial prevents even a managed launch', async () => { allowed = false; await assert.rejects(capture.create(workspace, W)); assert.equal(events.length, 0); });
});
