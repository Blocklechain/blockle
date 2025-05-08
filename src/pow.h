// SPDX-License-Identifier: MIT
#ifndef BLOCKLE_POW_H
#define BLOCKLE_POW_H

#include <stdint.h>
#include "consensus/params.h"
#include "uint256.h"

class CBlockHeader;
class CBlockIndex;

// Dark Gravity Wave entrypoint
unsigned int DarkGravityWave(const CBlockIndex* pindexLast, const CBlockHeader* pblock, const Consensus::Params& params);

// Determine next work (activates DGW at block 29000)
unsigned int GetNextWorkRequired(const CBlockIndex* pindexLast, const CBlockHeader* pblock, const Consensus::Params& params);

// Legacy Bitcoin-style retarget (for tests and pre-fork)
unsigned int CalculateNextWorkRequired(const CBlockIndex* pindexLast, int64_t nLastRetargetTime, const Consensus::Params& params);

// Proof-of-work validation
bool CheckProofOfWork(uint256 hash, unsigned int nBits, const Consensus::Params&);

#endif // BLOCKLE_POW_H
