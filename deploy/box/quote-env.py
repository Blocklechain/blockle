#!/usr/bin/env python3
"""Quote any env-file value containing a space.

systemd's EnvironmentFile parser tolerates `KEY=two words`, but a shell doing
`set -a; . file` does not — it tries to run the second word as a command, which
is how BITGO_WALLET_PREFIX silently failed to reach the go-live preflight
("Exchange: command not found") while the services themselves had it correctly.
Quoting satisfies both readers: systemd strips the quotes, the shell keeps the
value whole.
"""
import re
import sys

path = sys.argv[1]
changed = []
out = []
for line in open(path).read().splitlines():
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
    if m and " " in m.group(2) and not m.group(2).startswith(('"', "'")):
        out.append('{}="{}"'.format(m.group(1), m.group(2)))
        changed.append(m.group(1))
    else:
        out.append(line)
open(path, "w").write("\n".join(out) + "\n")
print("quoted: {}".format(", ".join(changed) if changed else "(nothing needed it)"))
