# Blockle Protect — Safari blocklists

Family Protection blocks gambling, scam/phishing and adult sites system-wide in
Safari via content-blocker app extensions (ShieldCore / ShieldAdultA /
ShieldAdultB in `ios/project.yml`).

## Source
Domains come from the open-source **blocklistproject** lists (Unlicense):
`gambling.txt`, `scam.txt`, `porn.txt`. We normalise + de-dupe, then pack them
into Safari rules with `pack.py` (many domains per rule via `if-domain`, so we
stay far under Safari's per-extension rule cap).

Counts at last build: gambling 342,614 · scam 8,098 · adult 952,029 domains.

## Regenerate + publish
```sh
for c in gambling scam porn; do
  curl -sL "https://raw.githubusercontent.com/blocklistproject/Lists/master/$c.txt" \
    | awk '/^0\.0\.0\.0 /{print $2}' | grep -E '^[a-z0-9.-]+\.[a-z]{2,}$' | sort -u > "$c.domains"
done
python3 pack.py gambling.domains gambling.json
python3 pack.py scam.domains scam.json
python3 pack.py porn.domains adult.json
# core = gambling + scam; adult split in two to keep each extension compile-friendly
# (see commit history), then scp *.json to the box:
#   /opt/blockle/web/protect/blocklists/   (served at protect.blockle.org/blocklists/)
```
CI (`.github/workflows/blockle-protect-ios.yml`) fetches core/adultA/adultB from
there into each extension at build time, so the big lists never live in git.
