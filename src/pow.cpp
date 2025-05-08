// SPDX-License-Identifier: MIT
#include <stdint.h>
#include <algorithm>

#include "arith_uint256.h"
#include "uint256.h"
#include "chain.h"
#include "primitives/block.h"
#include "chainparams.h"
#include "consensus/params.h"
#include "pow.h"

// ----------------------------------------------------------------------------
// Dark Gravity Wave v3
// ----------------------------------------------------------------------------
unsigned int DarkGravityWave(const CBlockIndex* pindexLast, const CBlockHeader* pblock, const Consensus::Params& params)
{
    const int64_t nPastBlocks = 180;
    // Convert powLimit to arith_uint256 once
    const arith_uint256 bnPowLimit = UintToArith256(params.powLimit);

    if (!pindexLast || pindexLast->nHeight < nPastBlocks)
        return bnPowLimit.GetCompact();

    // Rolling average of past targets
    arith_uint256 bnPastTargetAvg;
    int64_t nActualTimespan = 0, nLastBlockTime = 0;
    const CBlockIndex* pindex = pindexLast;

    for (int i = 0; i < nPastBlocks && pindex; i++) {
        // Convert each block’s compact bits → arith_uint256
        arith_uint256 bnTarget;
        bnTarget.SetCompact(pindex->nBits);

        // Running average
        bnPastTargetAvg = (i == 0)
            ? bnTarget
            : (bnPastTargetAvg * i + bnTarget) / (i + 1);

        if (nLastBlockTime > 0)
            nActualTimespan += nLastBlockTime - pindex->GetBlockTime();

        nLastBlockTime = pindex->GetBlockTime();
        pindex = pindex->pprev;
    }

    // Bound actual timespan to [1/3, 3×] of target
    int64_t nTargetTimespan = nPastBlocks * params.nPowTargetSpacing;
    nActualTimespan = std::max(nActualTimespan, nTargetTimespan / 3);
    nActualTimespan = std::min(nActualTimespan, nTargetTimespan * 3);

    // New target = avg_target × actual/target
    arith_uint256 bnNew = bnPastTargetAvg;
    bnNew *= nActualTimespan;
    bnNew /= nTargetTimespan;

    if (bnNew > bnPowLimit)
        bnNew = bnPowLimit;

    return bnNew.GetCompact();
}

// ----------------------------------------------------------------------------
// Determine next work required (activate DGW at height 29000)
// ----------------------------------------------------------------------------
unsigned int GetNextWorkRequired(const CBlockIndex* pindexLast, const CBlockHeader* pblock, const Consensus::Params& params)
{
    // Convert powLimit once
    const arith_uint256 bnPowLimit = UintToArith256(params.powLimit);

    if (!pindexLast)
        return bnPowLimit.GetCompact();

    // Activate Dark Gravity Wave at block 29000
    if (pindexLast->nHeight + 1 >= 29000)
        return DarkGravityWave(pindexLast, pblock, params);

    // Pre-fork: hold difficulty at powLimit
    return bnPowLimit.GetCompact();
}

// ----------------------------------------------------------------------------
// Legacy Bitcoin-style retarget (for tests and pre-fork compatibility)
// ----------------------------------------------------------------------------
unsigned int CalculateNextWorkRequired(const CBlockIndex* pindexLast, int64_t nLastRetargetTime, const Consensus::Params& params)
{
    if (params.fPowNoRetargeting)
        return pindexLast->nBits;

    int64_t nActualTimespan = pindexLast->GetBlockTime() - nLastRetargetTime;
    int64_t nMinTimespan = params.nPowTargetTimespan  / 4;
    int64_t nMaxTimespan = params.nPowTargetTimespan * 4;
    nActualTimespan = std::max(nActualTimespan, nMinTimespan);
    nActualTimespan = std::min(nActualTimespan, nMaxTimespan);

    arith_uint256 bnNew;
    bnNew.SetCompact(pindexLast->nBits);
    bnNew *= nActualTimespan;
    bnNew /= params.nPowTargetTimespan;

    arith_uint256 bnPowLimit = UintToArith256(params.powLimit);
    if (bnNew > bnPowLimit)
        bnNew = bnPowLimit;

    return bnNew.GetCompact();
}

// ----------------------------------------------------------------------------
// Proof-of-work validation
// ----------------------------------------------------------------------------
bool CheckProofOfWork(uint256 hash, unsigned int nBits, const Consensus::Params& params)
{
    bool fNegative, fOverflow;
    arith_uint256 bnTarget;
    bnTarget.SetCompact(nBits, &fNegative, &fOverflow);

    // Invalid if out of range
    if (fNegative || bnTarget == 0 || fOverflow || bnTarget > UintToArith256(params.powLimit))
        return false;

    // Check proof of work
    if (UintToArith256(hash) > bnTarget)
        return false;

    return true;
}
