#!/usr/bin/env bash
# Build t3ctl and install a wrapper at ~/.local/bin/t3ctl that runs it with a pinned Node.
# Re-run after pulling changes. Idempotent.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
node_bin="${T3CTL_NODE:-$(command -v node)}"
"$here/node_modules/.bin/tsc" -p "$here/tsconfig.json"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/t3ctl" <<WRAP
#!/usr/bin/env bash
exec "$node_bin" "$here/dist/index.js" "\$@"
WRAP
chmod +x "$HOME/.local/bin/t3ctl"
echo "installed: $HOME/.local/bin/t3ctl -> $node_bin $here/dist/index.js"
