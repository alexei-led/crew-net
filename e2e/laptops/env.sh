# Two (or more) simulated laptops on one Mac. Source it from zsh or bash:
#   W=$TMPDIR/crew-e2e CN=$PWD/dist/crew-net.js source e2e/laptops/env.sh
#   setup a; setup b       # clone the sandbox, isolate state (no credentials on disk)
#   teardown               # when done: removes $W, including the notifications read into it
#   cn a sync --once       # crew-net as laptop a, in its clone
: "${W:?set W to a scratch directory}" "${CN:?set CN to dist/crew-net.js}"
SANDBOX=${SANDBOX:-git@github.com:alexei-led/crew-net-sandbox.git}
lap() {
  local l=$1; shift
  (cd "$W/$l/repo" && XDG_STATE_HOME="$W/$l/state" XDG_CONFIG_HOME="$W/$l/config" \
    CLAUDE_CONFIG_DIR="$W/$l/claude" GH_CONFIG_DIR="$W/$l/gh" \
    GH_TOKEN="$(gh auth token)" "$@")
}
cn() { local l=$1; shift; lap "$l" node "$CN" "$@"; }
setup() {
  local l=$1
  mkdir -p "$W/$l/state" "$W/$l/config" "$W/$l/claude" "$W/$l/gh"
  chmod 700 "$W/$l/gh"
  git clone -q "$SANDBOX" "$W/$l/repo"
}
# Laptop $1 never reads gh's own config: the token comes from the environment
# of each call and is not written anywhere. The inbox job reads the whole
# account's notifications into the laptop's state, so $W holds that data too.
teardown() { rm -rf "$W"; }
# Make laptop $1 believe it is signed in as $2 (one GitHub account plays two).
pretend() {
  mkdir -p "$W/$1/state/crew-net/kv" && chmod 700 "$W/$1/state/crew-net" "$W/$1/state/crew-net/kv"
  node -e '
const c = require("node:crypto"), fs = require("node:fs");
const key = "viewer:github.com", h = c.createHash("sha256").update(key).digest("hex");
fs.writeFileSync(`${process.argv[1]}/${h}.json`,
  JSON.stringify({ key, value: { login: process.argv[2], atMs: Date.now() + 30 * 864e5 } }), { mode: 0o600 });
' "$W/$1/state/crew-net/kv" "$2"
}
