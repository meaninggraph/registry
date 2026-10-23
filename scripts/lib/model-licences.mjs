// Derived from ModelSpec Registry's scripts/lib/registry.mjs (repositoryLicences,
// declaredLicence and licenceProblems, reviewed commit 6e954755). Keep its
// upstream licence recognition and fallback rules aligned across registries.
const licenceTexts = [
  ['MIT', /^\s*(?:The )?MIT License\b/m],
  ['CC0-1.0', /CC0 1\.0 Universal/],
  ['Apache-2.0', /Apache License\s+Version 2\.0/],
  ['CC-BY-4.0', /Attribution 4\.0 International/],
  ['CC-BY-SA-3.0', /SPDX-License-Identifier:\s*CC-BY-SA-3\.0|Attribution-ShareAlike 3\.0 International/],
  ['BSD-3-Clause', /BSD 3-Clause/],
];
const safeRootName = name => typeof name === 'string' && !name.includes('/') && !name.includes('\\') && !/[\x00-\x1f]/.test(name) && name !== '.' && name !== '..';

// `view` is a pinned read-only tree with `files: string[]` and `read(path): Buffer`.
// PinnedSource only permits regular tracked blobs; links are never read as text.
export function repositoryLicences(view) {
  const all = new Set();
  const main = new Set();
  let hasMain = false;
  for (const name of view.files.filter(safeRootName)) {
    if (!/^(LICEN[CS]E|COPYING)/i.test(name)) continue;
    const unsuffixed = /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(name);
    hasMain ||= unsuffixed;
    let text;
    try { text = Buffer.from(view.read(name)).toString('utf8'); }
    catch { continue; } // A tracked symlink/non-regular root entry still names the repository default.
    for (const [id, pattern] of licenceTexts) {
      if (!pattern.test(text)) continue;
      all.add(id);
      if (unsuffixed) main.add(id);
    }
  }
  return { all, main, hasMain };
}

// The licence a model file states about itself, in its first ten lines.
export function declaredLicence(text) {
  for (const line of text.split('\n').slice(0, 10)) {
    const match = /(?:SPDX-License-Identifier|Licen[cs]e):\s*([A-Za-z0-9][A-Za-z0-9.+-]*[A-Za-z0-9+])/i.exec(line);
    if (match) return match[1];
  }
  return null;
}

// A model file's licence must match its declaration or the repository default.
// ModelSpec JSON has no licence field; callers may pass the validated HCL twin's
// declaration as `declared` after semantic twin validation succeeds.
export function licenceProblems(file, view, path, declared, expected) {
  const { all, main, hasMain } = repositoryLicences(view);
  const fallback = hasMain ? main : all;
  if (declared !== null) return declared === expected ? [] : [`${file}: licence is ${expected}, but ${path} declares ${declared}`];
  const licenceFiles = hasMain ? 'LICENSE file names' : 'LICENSE files name';
  if (fallback.size !== 1) return [`${file}: ${path} declares no licence, and the repository's ${licenceFiles} ${fallback.size ? `several (${[...fallback].join(', ')})` : 'no licence the check recognises'}; ${path.endsWith('.json') ? 'a JSON file cannot declare one, so the repository needs one LICENSE file naming the licence' : 'the file must declare its licence (a Licence: or SPDX-License-Identifier: line at the top)'}`];
  if (!fallback.has(expected)) return [`${file}: licence is ${expected}, but ${path} declares no licence and the repository's default licence (its LICENSE file) is ${[...fallback][0]}`];
  return [];
}
