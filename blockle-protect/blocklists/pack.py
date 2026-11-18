#!/usr/bin/env python3
"""Pack a plain domain list into a Safari content-blocker rule list.

Safari's ~50k per-extension limit counts RULES, not domains — so we pack many
domains into each rule's `if-domain` array ("*d" matches d + subdomains). This
lets one extension cover hundreds of thousands of domains. Usage:
    python3 pack.py <domains.txt> <out.json>
"""
import json, sys
PER_RULE = 40
domains = sorted({l.strip().lower().lstrip('.') for l in open(sys.argv[1]) if l.strip()})
rules = [{"action": {"type": "block"},
          "trigger": {"url-filter": ".*", "if-domain": ['*' + d for d in domains[i:i+PER_RULE]]}}
         for i in range(0, len(domains), PER_RULE)]
json.dump(rules, open(sys.argv[2], 'w'), separators=(',', ':'))
print(f"{len(domains)} domains -> {len(rules)} rules -> {sys.argv[2]}")
