// Request labels, derived from the diff. A project's constitution requires
// some labels on a request and the project's own check enforces them; a
// request the harness opens must arrive carrying them, because a check that
// only a human can answer is a hands-off ship with a human in it.
//
// The rule lives in project config (`labels`), never here. The harness holds
// no label names: a label vocabulary is a fact about a project, and a harness
// that carried one would apply another project's words to this project's work.
//
// Derivation is total over the rules it was given and silent about everything
// else. A label no rule covers is not guessed — it stays a red check, which is
// the one authority that can say a human has to look.
import { underEntry } from '../config/project.mjs';

/**
 * The labels a diff requires, sorted, each named once.
 * @param {string[]} files repo-relative paths the request changes
 * @param {{label: string, paths: string[]}[]} rules the project's label rules
 * @returns {string[]}
 */
export function derivedLabels(files, rules = []) {
  const labels = new Set();
  for (const rule of rules) {
    if (files.some((file) => rule.paths.some((entry) => underEntry(file, entry)))) {
      labels.add(rule.label);
    }
  }
  return [...labels].sort();
}
