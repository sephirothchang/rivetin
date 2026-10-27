import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const rules = [
  ['personal-path', /(?:[A-Z]:[\\/](?:Users|Documents)[\\/]|\/Users\/[a-z0-9_-]+\/|\/home\/(?!node\/|app\/)[a-z0-9_-]+\/)/i],
  ['private-endpoint', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/],
  ['credential', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/],
  ['runtime-artifact', /(?:^|\/)(?:\.local|\.runtime|node_modules|qa|payload|release)\//],
];
let matches = 0, count = 0;
for (const file of new Set(files)) {
  let bytes; try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  count++;
  if (rules.at(-1)[1].test(file)) { console.error(`${file}: runtime-artifact`); matches++; continue; }
  if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split('\n');
  for (const [index, line] of lines.entries()) for (const [kind, pattern] of rules.slice(0, -1)) if (pattern.test(line)) {
    // Report location only; never echo suspected sensitive content.
    console.error(`${file}:${index + 1}: ${kind}`); matches++;
  }
}
console.log(`Public-content check: ${count} files, ${matches} findings. Pattern checks are not a proof of absence of secrets.`);
if (matches) process.exitCode = 1;
