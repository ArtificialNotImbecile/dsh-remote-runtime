/** Reject any runtime ELF whose imported glibc symbol exceeds the declared floor. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const descriptor = JSON.parse(await readFile(join(root, 'runtime', 'manifest.json'), 'utf8'))
const artifact = join(
  process.env.DSH_REMOTE_RUNTIME_OUTPUT_DIR ?? join(root, 'runtime', 'artifacts'),
  `dsh-remote-runtime-${descriptor.runtimeVersion}-linux-x64-glibc.tar.gz`,
)
const info = await stat(artifact)
if (info.size !== descriptor.archive.bytes || await sha256(artifact) !== descriptor.archive.sha256) {
  throw new Error('runtime ABI audit refused an archive that does not match its descriptor')
}
if (!/^\d+\.\d+$/u.test(descriptor.minimumGlibc)) throw new Error('invalid minimumGlibc descriptor')

const shell = join(dirname(artifact), `audit-runtime-abi-${process.pid}.sh`)
await writeFile(shell, `#!/bin/bash
set -euo pipefail
artifact="$1"
floor="$2"
work="$(mktemp -d "${'${TMPDIR:-/tmp}'}/dsh-remote-abi.XXXXXX")"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT INT TERM
tar -xzf "$artifact" -C "$work" --no-same-owner --no-same-permissions
python3 - "$work" > "$work/elfs.list" <<'PY'
import os
import sys
root = sys.argv[1]
for base, _, names in os.walk(root):
    for name in names:
        path = os.path.join(base, name)
        try:
            with open(path, 'rb') as handle:
                if handle.read(4) == b'\x7fELF':
                    print(path)
        except OSError:
            pass
PY
count=0
highest=0
while IFS= read -r file; do
  count=$((count+1))
  current=$(objdump -T -- "$file" 2>/dev/null | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sed 's/^GLIBC_//' | sort -V | tail -n 1 || true)
  test -n "$current" || continue
  highest=$(printf '%s\n%s\n' "$highest" "$current" | sort -V | tail -n 1)
  allowed=$(printf '%s\n%s\n' "$floor" "$current" | sort -V | tail -n 1)
  if test "$allowed" != "$floor"; then
    printf 'ABI_TOO_NEW\t%s\t%s\n' "$current" "${'${file#"$work"/}'}" >&2
    exit 1
  fi
done < "$work/elfs.list"
printf 'ABI_OK\t%s\t%s\n' "$count" "$highest"
`, { mode: 0o700 })
try {
  const result = process.platform === 'win32'
    ? spawnSync('wsl.exe', ['--exec', 'env', '-i', 'HOME=/tmp', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        '/bin/bash', toWslPath(shell), toWslPath(artifact), descriptor.minimumGlibc], { encoding: 'utf8' })
    : spawnSync('/bin/bash', [shell, artifact, descriptor.minimumGlibc], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`runtime ABI audit failed: ${(result.stderr || '').trim().slice(0, 1_000)}`)
  const match = /^ABI_OK\t(\d+)\t([0-9.]+)$/mu.exec(result.stdout)
  if (match === null) throw new Error('runtime ABI audit returned no result')
  process.stdout.write(`${JSON.stringify({ elfFiles: Number(match[1]), highestGlibc: match[2], floor: descriptor.minimumGlibc })}\n`)
} finally {
  await rm(shell, { force: true })
}

function toWslPath(path) {
  const result = spawnSync('wsl.exe', ['--exec', 'wslpath', '-a', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`wslpath failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
