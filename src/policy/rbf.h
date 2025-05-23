// Copyright (c) 2016-2019 The Blockle Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef PALLADIUM_POLICY_RBF_H
#define PALLADIUM_POLICY_RBF_H

#include <txmempool.h>

enum class RBFTransactionState {
    UNKNOWN,
    REPLACEABLE_BIP125,
    FINAL
};

// Determine whether an in-mempool transaction is signaling opt-in to RBF
// according to BIP 125
// This involves checking sequence numbers of the transaction, as well
// as the sequence numbers of all in-mempool ancestors.
RBFTransactionState IsRBFOptIn(const CTransaction& tx, const CTxMemPool& pool) EXCLUSIVE_LOCKS_REQUIRED(pool.cs);

#endif // PALLADIUM_POLICY_RBF_H
