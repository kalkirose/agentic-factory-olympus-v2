// Run isolation coordinator: everything a run owns outside its ledger.
// Provision at launch: fetch the bare clone, read project config from the
// default branch, create the run worktree, bring the stack up. Release at
// close: stack down, worktrees gone, run branch gone. The workspace record
// (workspace.json in the run directory) is a run artifact — it archives with
// the run and makes release restart-safe.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectConfig } from '../config/project.mjs';
import { runLedgerPath } from '../daemon/home.mjs';
import { pathHolders, sweepPathHolders } from '../engine/processes.mjs';
import { git } from './git.mjs';
import { cloneDir, ensureBareClone, fetchClone, branchSha, readBlobFromBranch } from './clones.mjs';
import { removeTree, removeWithRetry } from './removal.mjs';
import { addRunWorktree, removeRunWorktrees, workspaceRoot } from './worktrees.mjs';
import { stackUp, stackDown } from './stacks.mjs';

export class RunIsolation {
  /**
   * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
   * @param {{composeCommand?: () => string[], composeRunner?: Function,
   *   sweepProcesses?: Function, listHolders?: Function, removalIo?: object}} opts
   *   sweepProcesses substitutes the process sweep and listHolders the
   *   read-only holder query behind a leftover record (tests only). removalIo
   *   is the removal ladder's seam — the delete call and the wait between
   *   attempts — read at every call.
   */
  constructor(
    paths,
    { composeCommand, composeRunner, sweepProcesses, listHolders, removalIo } = {},
  ) {
    this.paths = paths;
    this.composeCommand = composeCommand ?? (() => ['docker', 'compose']);
    this.composeRunner = composeRunner;
    this.sweepProcesses = sweepProcesses ?? sweepPathHolders;
    this.listHolders = listHolders ?? pathHolders;
    this.removalIo = removalIo ?? {};
    this.cloneLocks = new Map();
  }

  /**
   * Serializes work on a project's bare clone. Provision, release, and the
   * frontier's graph read all go through here: concurrent git commands on
   * one repository collide on its internal locks (config.lock, worktree
   * admin files) and fail spuriously, most visibly on Windows.
   * @param {string} project
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  async withClone(project, fn) {
    const prev = this.cloneLocks.get(project) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    this.cloneLocks.set(project, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Provisions a run workspace. Fails the launch as a whole: an invalid
   * config, a failed fetch, or a failed stack leaves nothing behind.
   * `baseCommit` starts the run worktree somewhere other than the default
   * branch head — a resumed run starts on the commit its inherited freeze
   * names. `baseSha` stays the default-branch head either way: it is the base
   * the run will merge into, not the commit it started on.
   * @param {{runId: string, project: string, repoUrl: string,
   *   defaultBranch: string, configPath: string, baseCommit?: string}} opts
   */
  async provision({ runId, project, repoUrl, defaultBranch, configPath, baseCommit }) {
    const { clone, blob, projectConfig, baseSha, worktree, branch } = await this.withClone(
      project,
      async () => {
        const dir = await ensureBareClone(this.paths, project, repoUrl, defaultBranch);
        await fetchClone(dir);
        const source = `${project} ${defaultBranch}:${configPath}`;
        const { blob, text } = await readBlobFromBranch(dir, defaultBranch, configPath);
        const config = parseProjectConfig(text, source);
        const sha = await branchSha(dir, defaultBranch);
        const added = await addRunWorktree(dir, this.paths, runId, baseCommit ?? defaultBranch);
        return {
          clone: dir,
          blob,
          projectConfig: config,
          baseSha: sha,
          worktree: added.path,
          branch: added.branch,
        };
      },
    );
    let stack = null;
    if (projectConfig.stack) {
      // The stack rises outside the clone lock — a slow compose up must not
      // block another run's teardown.
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
        await this.withClone(project, () =>
          removeRunWorktrees(clone, this.paths, runId),
        ).catch(() => {});
        throw error;
      }
    }
    const record = {
      runId,
      project,
      worktree,
      branch,
      baseSha,
      ...(baseCommit && { baseCommit }),
      configPath,
      configBlob: blob,
      stack,
    };
    const runDir = join(this.paths.runs, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'workspace.json'), JSON.stringify(record, null, 2) + '\n');
    return { ...record, projectConfig };
  }

  /**
   * Releases a run workspace: stack down, processes swept, worktrees removed,
   * workspace root gone. `keepBranch` leaves the run branch in the clone — the
   * caller sets it for a run whose work never reached the remote. Collects
   * errors instead of stopping at the first: teardown runs every step it can.
   *
   * Every removal below goes through the retry ladder, because the tree it
   * deletes is a checked-out application and a file in it can still be held
   * (ADR-0004). `leftover` names the workspace that survived every attempt and
   * `holders` names the processes standing in it, so the caller can record a
   * directory that nothing would find on its own, and say what is holding it.
   * Returns { errors, record, swept, leftover, holders }.
   */
  async release(runId, { project, keepBranch = false } = {}) {
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
    const root = workspaceRoot(this.paths, runId);
    // Before anything tries to delete the workspace: a seat that exited on its
    // own can leave descendants standing in it, and every removal below fails
    // for as long as they do. A workspace that is already gone holds nothing,
    // so it costs no enumeration.
    let swept = null;
    if (existsSync(root)) {
      swept = await this.sweepProcesses(root);
      if (swept.error) errors.push(`sweep: ${swept.error}`);
    }
    if (owner && existsSync(cloneDir(this.paths, owner))) {
      try {
        await this.withClone(owner, () =>
          removeWithRetry(
            () =>
              removeRunWorktrees(cloneDir(this.paths, owner), this.paths, runId, {
                keepBranch,
                io: this.removalIo,
              }),
            this.removalIo,
          ),
        );
      } catch (error) {
        errors.push(`worktree: ${error.message}`);
      }
    }
    if (existsSync(root)) {
      try {
        await removeTree(root, this.removalIo);
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
        await removeTree(runDir, this.removalIo);
      } catch (error) {
        errors.push(`run dir: ${error.message}`);
      }
    }
    // The workspace as it stands after every step has run, rather than what
    // any one step reported: a root that is gone is gone whichever removal
    // took it, and a root that is still there is one nothing took.
    const leftover = existsSync(root) ? root : null;
    return { errors, record, swept, leftover, holders: await this.holdersOf(leftover) };
  }

  /**
   * Who is standing in a workspace that survived the whole release. Read after
   * every removal has been tried, not before: the sweep already ended what it
   * could find, so the answer here is what outlived it — the process the
   * operator has to deal with. A query that cannot run answers nothing, and
   * the release is reported either way.
   */
  async holdersOf(leftover) {
    if (leftover === null) return [];
    try {
      const { holders } = await this.listHolders(leftover);
      return holders ?? [];
    } catch {
      return [];
    }
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
      const project = entry.name.replace(/\.git$/, '');
      try {
        await this.withClone(project, () =>
          git(['worktree', 'prune'], { cwd: join(this.paths.clones, entry.name) }),
        );
      } catch (error) {
        errors.push(`prune ${entry.name}: ${error.message}`);
      }
    }
  }
}
