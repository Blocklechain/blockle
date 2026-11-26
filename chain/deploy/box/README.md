# deploy/box — things that run on the pool box

## z9-stratum-ab.py — settle why a Z9 Mini says "No servers could be used!"

`No servers could be used! Exiting.` is a cgminer/bmminer-family message
meaning the client never completed a usable stratum session. It is emitted
before any share is submitted, so it is **not** the share-rejection bug fixed
in `split_nonce()` (blockle-node 0.8.1) — do not re-diagnose that.

Three investigations of this ticket produced three mutually-refuting
"leading causes", each backed by real packet captures. That is what a
question looks like when it cannot be answered from the pool side: SYN-ACK
sent, subscribe parsed, reply written, peer FIN — identical under every
hypothesis. The deciding logic lives in closed Z9 firmware.

So this script uses the miner as the detector. It harvests the live node's
own three lines, replays them byte-for-byte from a throwaway listener, and
serves six ports that each differ from production in exactly one way.

| port | variant | differs from the live pool by |
|------|---------|------------------------------|
| 3369 | baseline | nothing — byte-exact replay (**must fail**) |
| 3370 | order    | subscribe reply sent first, ahead of set_target/notify |
| 3371 | target   | share target `>>13` (difficulty ~8192 instead of ~2) |
| 3372 | session  | `result[0]` is JSON `null` instead of `"b10c6e01"` |
| 3373 | framing  | one `write()` per line incl. newline, `TCP_NODELAY` on |
| 3374 | allfixes | all four at once (**must pass**) |

Those ports are free on the box *and* already inside the live
`tcp dport 3355-3382 accept` nft rule, so no firewall change is needed.
3346/3347 look free but are the eaglesong and kheavyhash direct lanes of the
running node — an earlier attempt to use them is why the decisive test never
actually ran.

### Run it

```sh
scp deploy/box/z9-stratum-ab.py blockle-box:/root/
ssh blockle-box 'python3 /root/z9-stratum-ab.py --harvest 127.0.0.1:3334'
```

Ask the owner to point the miner at `blockle.org` on **one port at a time**,
~2 minutes each, leaving username and password exactly as they have them.
Then Ctrl-C: the script prints a verdict table and the interpretation.

Self-check, no hardware needed — runs a cgminer-4.9.0-shaped client against
every variant and exercises the verdict logic:

```sh
python3 deploy/box/z9-stratum-ab.py --harvest 127.0.0.1:3334 --mock-z9
```

### Reading the result

* **baseline fails** → the replay reproduces the symptom; the table is
  decisive and whichever single axis flips to PASS is the cause.
* **baseline passes** → stop. None of the four hypotheses is the cause and no
  fix is justified yet; see *KNOWN UNMODELLED DIFFERENCES* at the bottom of
  the script (notably the ~8 s `mining.authorize` stall measured on the live
  node).
* **allfixes fails too** → all four axes are eliminated together; the
  remaining suspect is `mining.notify` *content* (param 4 carries
  `state_root` where the Zcash layout puts a 64-zero `reserved`).

### Safety

It is **not** a pool. It answers `true` to every share and discards it, so a
block solved against these ports is lost. Run each variant for minutes, not
overnight. It never writes to, restarts, or redeploys `blockle-node`.

### Traps that have already cost time

* `journalctl --since/--until` on this box parses **local** time (CET, UTC+1)
  even with `--utc`, so a 22:47–22:54 UTC window must be queried as
  23:47–23:54.
* A worker name like `.n420` has no address before the first dot;
  `stratum.rs:514-515` takes `worker.split('.').next()` and falls back to the
  **pool** address when it does not decode, so that worker's shares would pay
  the pool. Separate bug — the script warns when it sees one.
