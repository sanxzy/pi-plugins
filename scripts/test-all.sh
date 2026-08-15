#!/usr/bin/env bash
# test-all.sh — seamless per-package workspace verification.
#
# Runs every package's `typecheck` and `test` scripts individually (never the
# aggregate `pnpm -r` forms), reports a per-package summary, and exits non-zero
# as soon as the full run finishes if any step failed.
#
# Usage:
#   bash scripts/test-all.sh            # typecheck + test every package
#   bash scripts/test-all.sh --tests-only  # only `test` scripts

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

RUN_TYPECHECK=1
if [[ "${1:-}" == "--tests-only" ]]; then
  RUN_TYPECHECK=0
fi

# has_script <package-directory> <script-key>
has_script() {
  node -e "const p=require('./$1/package.json'); process.exit(p.scripts && Object.prototype.hasOwnProperty.call(p.scripts, '$2') ? 0 : 1)" 2>/dev/null
}

package_dirs=()
package_names=()
for manifest in packages/*/package.json; do
  directory="$(dirname "$manifest")"
  name="$(node -e "console.log(require('./$manifest').name || '')" 2>/dev/null || true)"
  if [[ -n "$name" ]]; then
    package_dirs+=("$directory")
    package_names+=("$name")
  fi
done

if [[ ${#package_dirs[@]} -eq 0 ]]; then
  echo "No packages found under $ROOT/packages." >&2
  exit 1
fi

results=()
failed=0
total=0
started_at="$(date +%s)"

for index in "${!package_dirs[@]}"; do
  directory="${package_dirs[$index]}"
  name="${package_names[$index]}"
  if [[ "$RUN_TYPECHECK" -eq 1 ]] && has_script "$directory" "typecheck"; then
    total=$((total + 1))
    echo ""
    echo "===== [typecheck] $name ====="
    if pnpm --filter "$name" run typecheck; then
      results+=("PASS typecheck $name")
    else
      results+=("FAIL typecheck $name")
      failed=$((failed + 1))
    fi
  fi

  if has_script "$directory" "test"; then
    total=$((total + 1))
    echo ""
    echo "===== [test] $name ====="
    if pnpm --filter "$name" run test; then
      results+=("PASS test $name")
    else
      results+=("FAIL test $name")
      failed=$((failed + 1))
    fi
  fi
done

elapsed="$(( $(date +%s) - started_at ))"
echo ""
echo "============================================================"
echo "Workspace verification summary"
echo "  checks run: $total   passed: $((total - failed))   failed: $failed   (${elapsed}s)"
for line in "${results[@]}"; do
  echo "  $line"
done
echo "============================================================"
if [[ "$failed" -gt 0 ]]; then
  echo "Some packages failed. See the failing sections above." >&2
  exit 1
fi
echo "All packages passed."