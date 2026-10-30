#!/usr/bin/env python3
"""
Blockle Intelligence — Phase 1 incentive-mechanism simulation.

Implements the §5 consensus from docs/BLOCKLE-INTELLIGENCE.md as pure functions, then
runs an agent-based simulation (honest / colluding / lazy validators; good / bad /
confederate miners) to verify the two things the design must deliver:

  1. INCENTIVE TRACKS QUALITY — good miners out-earn bad ones.
  2. THE DEFENSES WORK — a minority of colluding validators cannot inflate a bad
     "confederate" miner, and weight-copiers/lazy validators get caught by
     beacon-seeded proof-of-validation and slashed to irrelevance.

We prove (2) by ABLATION: run the exact same attack with the defenses (clipping +
proof-of-validation) OFF vs ON and compare. Pure stdlib; deterministic.
"""
import random, math

# ----------------------------- §5 incentive math -----------------------------
def consensus_clip(W, S, kappa):
    """Yuma-style stake-weighted median clip. For each miner j, Ĉ_j = the weight at
    which cumulative stake (validators sorted by weight desc) first reaches kappa of
    total stake; clip W̄_ij = min(W_ij, Ĉ_j). A sub-kappa minority can't inflate j."""
    nv, nm = len(S), len(W[0])
    total = sum(S) or 1.0
    C = [0.0] * nm
    for j in range(nm):
        pairs = sorted(((W[i][j], S[i]) for i in range(nv)), reverse=True)
        acc = 0.0
        for w, s in pairs:
            acc += s
            if acc >= kappa * total:
                C[j] = w
                break
    Wbar = [[min(W[i][j], C[j]) for j in range(nm)] for i in range(nv)]
    return Wbar, C

def ranks(Wbar, S):
    nv, nm = len(S), len(Wbar[0])
    return [sum(S[i] * Wbar[i][j] for i in range(nv)) for j in range(nm)]

def normalize(x):
    t = sum(x)
    return [v / t for v in x] if t > 0 else [0.0] * len(x)

def update_bonds(Bprev, Wbar, S, lam):
    nv, nm = len(S), len(Wbar[0])
    B = [[lam * Bprev[i][j] + (1 - lam) * S[i] * Wbar[i][j] for j in range(nm)] for i in range(nv)]
    # column-normalize so bonds are shares of each miner
    for j in range(nm):
        col = sum(B[i][j] for i in range(nv))
        if col > 0:
            for i in range(nv):
                B[i][j] /= col
    return B

def dividends(B, I):
    nv, nm = len(B), len(I)
    return [sum(B[i][j] * I[j] for j in range(nm)) for i in range(nv)]

# ------------------------------- agent model ---------------------------------
HONEST, COLLUDER, LAZY = "honest", "colluder", "lazy"

def build_world(seed, cartel_mult=1.0):
    rnd = random.Random(seed)
    # miners: (quality q in [0,1], label). Includes a "confederate" bad miner the
    # colluders try to pump, plus good/mediocre/bad honest miners.
    miners = []
    for _ in range(6):  miners.append((rnd.uniform(0.75, 0.95), "good"))
    for _ in range(6):  miners.append((rnd.uniform(0.40, 0.60), "mediocre"))
    for _ in range(5):  miners.append((rnd.uniform(0.05, 0.20), "bad"))
    CONFED = len(miners); miners.append((0.10, "confederate-bad"))  # colluders pump this one
    # validators: honest majority, a colluding cartel, some lazy copiers.
    # cartel_mult scales the cartel's stake to model a "whale cartel" weight attack.
    vals = []
    for _ in range(8): vals.append([HONEST, rnd.uniform(0.5, 1.5)])
    for _ in range(4): vals.append([COLLUDER, rnd.uniform(0.5, 1.2) * cartel_mult])
    for _ in range(3): vals.append([LAZY, rnd.uniform(0.3, 0.8)])
    return rnd, miners, vals, CONFED

def validator_weights(vtype, q, confed, prev_w, rnd):
    nm = len(q)
    if vtype == HONEST:
        # Tier-0/1: weight ≈ verifiable pass-rate (true quality) + small noise.
        w = [max(0.0, min(1.0, q[j] + rnd.gauss(0, 0.05))) for j in range(nm)]
    elif vtype == COLLUDER:
        # self-deal: dump all weight on the confederate bad miner, ignore quality.
        w = [0.0] * nm; w[confed] = 1.0
    else:  # LAZY — copy last epoch's weights (or uniform if none): no real evaluation.
        w = prev_w[:] if prev_w else [0.5] * nm
    return w

def proof_of_validation(vtype, rnd):
    """Beacon-seeded spot-check: honest validators actually evaluated → pass; colluders
    and lazy copiers can't answer fresh challenges → fail."""
    if vtype == HONEST:
        return rnd.random() < 0.98      # occasional honest miss
    return rnd.random() < 0.03          # copiers/lazy almost never pass

# ------------------------------- simulation ----------------------------------
def run(defenses_on, seed=42, epochs=120, kappa=0.5, lam=0.9, slash=0.15,
        alpha=0.25, block_subsidy=50.0, blocks_per_epoch=360, miner_frac=0.5,
        cartel_mult=1.0):
    rnd, miners, vals, CONFED = build_world(seed, cartel_mult)
    q = [m[0] for m in miners]
    nv, nm = len(vals), len(miners)
    S = [v[1] for v in vals]                 # stake (evolves)
    vtype = [v[0] for v in vals]
    B = [[0.0] * nm for _ in range(nv)]
    prev_w = [None] * nv
    earn_miner = [0.0] * nm
    earn_val = [0.0] * nv
    emission_per_epoch = alpha * block_subsidy * blocks_per_epoch
    pow_miner_total = 0.0

    for _ in range(epochs):
        # 1. each validator sets weights
        W = []
        for i in range(nv):
            w = validator_weights(vtype[i], q, CONFED, prev_w[i], rnd)
            prev_w[i] = w
            W.append(w)
        # 2. proof-of-validation (defense): failing validators are ignored + slashed
        Suse = S[:]
        if defenses_on:
            for i in range(nv):
                if not proof_of_validation(vtype[i], rnd):
                    Suse[i] = 0.0                      # weights ignored this epoch
                    S[i] *= (1 - slash)                # bond slashed
        # 3. consensus (clip is the other defense)
        if defenses_on:
            Wbar, _ = consensus_clip(W, Suse, kappa)
        else:
            Wbar = [[W[i][j] for j in range(nm)] for i in range(nv)]  # raw, no clip
        R = ranks(Wbar, Suse)
        I = normalize(R)
        B = update_bonds(B, Wbar, Suse, lam)
        D = normalize(dividends(B, I))
        # 4. distribute emission
        for j in range(nm):
            earn_miner[j] += emission_per_epoch * miner_frac * I[j]
        for i in range(nv):
            gain = emission_per_epoch * (1 - miner_frac) * D[i]
            earn_val[i] += gain
            S[i] += gain                               # validators compound dividends into stake
        pow_miner_total += (1 - alpha) * block_subsidy * blocks_per_epoch
    return dict(miners=miners, q=q, CONFED=CONFED, vtype=vtype, S=S,
                earn_miner=earn_miner, earn_val=earn_val,
                emission_per_epoch=emission_per_epoch, epochs=epochs,
                pow_miner_total=pow_miner_total, alpha=alpha)

def summarize(tag, r):
    nm = len(r["earn_miner"]); nv = len(r["earn_val"])
    by_label = {}
    for j in range(nm):
        lbl = r["miners"][j][1]
        by_label.setdefault(lbl, [0.0, 0])
        by_label[lbl][0] += r["earn_miner"][j]; by_label[lbl][1] += 1
    tot_m = sum(r["earn_miner"]) or 1.0
    confed_share = r["earn_miner"][r["CONFED"]] / tot_m * 100
    val_by = {HONEST: 0.0, COLLUDER: 0.0, LAZY: 0.0}
    stake_by = {HONEST: 0.0, COLLUDER: 0.0, LAZY: 0.0}
    for i in range(nv):
        val_by[r["vtype"][i]] += r["earn_val"][i]
        stake_by[r["vtype"][i]] += max(0.0, r["S"][i])
    tot_v = sum(val_by.values()) or 1.0
    print(f"\n===== {tag} =====")
    print("  miner emission share by quality class:")
    for lbl in ["good", "mediocre", "bad", "confederate-bad"]:
        if lbl in by_label:
            tot, n = by_label[lbl]
            print(f"     {lbl:16s} {tot/tot_m*100:6.2f}%  ({n} miners, {tot/tot_m*100/n:5.2f}%/miner)")
    print(f"  >> ATTACK METRIC — confederate-bad miner captured: {confed_share:5.2f}% of miner emission")
    print("  validator emission share by type:")
    for t in [HONEST, COLLUDER, LAZY]:
        print(f"     {t:9s} earn {val_by[t]/tot_v*100:6.2f}%   end-stake {stake_by[t]:8.2f}")

if __name__ == "__main__":
    print("Blockle Intelligence — incentive-mechanism simulation (ablation)")
    off = run(defenses_on=False)
    on = run(defenses_on=True)
    summarize("DEFENSES OFF (no clipping, no proof-of-validation)", off)
    summarize("DEFENSES ON  (clipping + beacon proof-of-validation + slashing)", on)
    # whale-cartel ablation: the colluders now hold ~5x stake each (a well-funded
    # weight-inflation attack). Without defenses they should pump the confederate hard;
    # with defenses clipping caps them and PoV slashes them.
    woff = run(defenses_on=False, cartel_mult=5.0)
    won = run(defenses_on=True, cartel_mult=5.0)
    summarize("WHALE CARTEL (5x stake) — DEFENSES OFF", woff)
    summarize("WHALE CARTEL (5x stake) — DEFENSES ON", won)
    # budget check
    r = on
    print("\n===== BUDGET (defenses ON) =====")
    print(f"  alpha={r['alpha']}  intelligence emission/epoch = {r['emission_per_epoch']:.1f} BLOCK")
    print(f"  total intelligence emission ({r['epochs']} epochs) = {r['emission_per_epoch']*r['epochs']:.1f} BLOCK")
    print(f"  PoW miners still received (1-alpha) = {r['pow_miner_total']:.1f} BLOCK over the same span")
    tot_paid = sum(r['earn_miner']) + sum(r['earn_val'])
    print(f"  conservation: distributed {tot_paid:.1f} vs pool {r['emission_per_epoch']*r['epochs']:.1f} "
          f"(ratio {tot_paid/(r['emission_per_epoch']*r['epochs']):.4f})")

    # ---- single-epoch CLIPPING isolation (before stake-compounding washes it out) ----
    # A whale cartel (8x stake) dumps weight on the confederate in a SINGLE epoch.
    print("\n===== CLIPPING (single epoch, large-MINORITY cartel, no compounding) =====")
    rnd, miners, vals, CONFED = build_world(seed=42, cartel_mult=2.0)
    q = [m[0] for m in miners]; nv, nm = len(vals), len(miners)
    S = [v[1] for v in vals]; vtype = [v[0] for v in vals]
    W = [validator_weights(vtype[i], q, CONFED, None, rnd) for i in range(nv)]
    cartel_stake = sum(S[i] for i in range(nv) if vtype[i] == COLLUDER)
    print(f"  cartel holds {cartel_stake/sum(S)*100:.1f}% of stake and dumps weight 1.0 on the confederate")
    R_raw = normalize(ranks([[W[i][j] for j in range(nm)] for i in range(nv)], S))
    Wbar, Cj = consensus_clip(W, S, 0.5)
    R_clip = normalize(ranks(Wbar, S))
    print(f"  confederate incentive  NO-CLIP: {R_raw[CONFED]*100:6.2f}%   CLIPPED: {R_clip[CONFED]*100:6.2f}%")
    goods = [j for j in range(nm) if miners[j][1] == 'good']
    print(f"  good-miner incentive   NO-CLIP: {sum(R_raw[j] for j in goods)*100:6.2f}%   CLIPPED: {sum(R_clip[j] for j in goods)*100:6.2f}%")
