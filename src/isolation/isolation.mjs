// Run isolation coordinator: everything a run owns outside its ledger.
// Provision at launch: fetch the bare clone, read project config from the
// default branch, create the run worktree, bring the stack up. Release at
// close: stack down, worktrees gone, run branch gone. The workspace record
// (workspace.json in the run directory) is a run artifact — it archives with
// the run and makes release restart-safe.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectConfig } from '../config/project.mjs';
import { runLedgerPath } from '../daemon/home.mjs';
import { git } from './git.mjs';
import { cloneDir, ensureBareClone, fetchClone, branchSha, readBlobFromBranch } from './clones.mjs';
import { addRunWorktree, removeRunWorktrees, workspaceRoot } from './worktrees.mjs';
import { stackUp, stackDown } from './stacks.mjs';

export class RunIsolation {
  /**
   * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
   * @param {{composeCommand?: () => string[], composeRunner?: Function}} opts
   */
  constructor(paths, { composeCommand, composeRunner } = {}) {
    this.paths = paths;
    this.composeCommand = composeCommand ?? (() => ['docker', 'compose']);
    this.composeRunner = composeRunner;
  }

  /**
   * Provisions a run workspace. Fails the launch as a whole: an invalid
   * config, a failed fetch, or a failed stack leaves nothing behind.
   * @param {{runId: string, project: string, repoUrl: string,
   *   defaultBranch: string, configPath: string}} opts
   */
  async provision({ runId, project, repoUrl, defaultBranch, configPath }) {
    const clone = await ensureBareClone(this.paths, project, repoUrl);
    await fetchClone(clone);
    const source = `${project} ${defaultBranch}:${configPath}`;
    const { blob, text } = await readBlobFromBranch(clone, defaultBranch, configPath);
    const projectConfig = parseProjectConfig(text, source);
    const baseSha = await branchSha(clone, defaultBranch);
    const { path: worktree, branch } = await addRunWorktree(clone, this.paths, runId, defaultBranch);
    let stack = null;
    if (projectConfig.stack) {
      try {
        const name = await stackUp({
          runId,
          worktree,
          composeFile: projectConfig.stack.composeFile,
          extraEnv: projectConfig.stack.env,
          composeCommand: this.composeCommand(),
          runner: this.composeRunner,
        });
        stack = { name, composeFile: projectConfig.stack.composeFile };
      } catch (error) {
        await removeRunWorktrees(clone, this.paths, runId).catch(() => {});
        throw error;
      }
    }
    const record = { runId, project, worktree, branch, baseSha, configPath, configBlob: blob, stack };
    const runDir = join(this.paths.runs, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'workspace.json'), JSON.stringify(record, null, 2) + '\n');
    return { ...record, projectConfig };
  }

  /**
   * Releases a run workspace: stack down, worktrees and run branch removed,
   * workspace root gone. Collects errors instead of stopping at the first —
   * teardown runs every step it can. Returns { errors, record }.
   */
  async release(runId, { project } = {}) {
    const errors = [];
    const record = this.readRecord(runId);
    const owner = record?.project ?? project;
    if (record?.stack) {
      try {
        await stackDown({
          runId,
          composeCommand: this.composeCommand(),
          runner: this.composeRunner,
        });
      } catch (error) {
        errors.push(`stack: ${error.message}`);
      }
    }
    if (owner && existsSync(cloneDir(this.paths, owner))) {
      try {
        await removeRunWorktrees(cloneDir(this.paths, owner), this.paths, runId);
      } catch (error) {
        errors.push(`worktree: ${error.message}`);
      }
    }
    const root = workspaceRoot(this.paths, runId);
    if (existsSync(root)) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        errors.push(`workspace root: ${error.message}`);
      }
      // Without an owner the worktree registrations could not be removed
      // above; prune every clone so none keeps a dead registration.
      if (!owner) await this.pruneAllClones(errors);
    }
    // A provision whose launch failed leaves a run directory with a record
    // and no ledger. Remove it — it never became a run.
    const runDir = join(this.paths.runs, runId);
    if (existsSync(runDir) && !existsSync(runLedgerPath(this.paths, runId))) {
      try {
        rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        errors.push(`run dir: ${error.message}`);
      }
    }
    return { errors, record };
  }

  /**
   * Workspace directories for runs not in the open set — a daemon that died
   * between run close and teardown leaves these behind.
   */
  orphanRunIds(openRunIds) {
    let entries;
    try {
      entries = readdirSync(this.paths.worktrees, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !openRunIds.has(e.name))
      .map((e) => e.name);
  }

  /** Reads the workspace record from the live run dir, then the archive. */
  readRecord(runId) {
    for (const dir of [join(this.paths.runs, runId), join(this.paths.archivedRuns, runId)]) {
      try {
        return JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'));
      } catch {
        // keep looking
      }
    }
    return null;
  }

  async pruneAllClones(errors) {
    let entries;
    try {
      entries = readdirSync(this.paths.clones, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await git(['worktree', 'prune'], { cwd: join(this.paths.clones, entry.name) });
      } catch (error) {
        errors.push(`prune ${entry.name}: ${error.message}`);
      }
    }
  }
}
