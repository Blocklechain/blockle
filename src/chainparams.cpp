// Copyright (c) 2010 Satoshi Nakamoto
// Copyright (c) 2009-2019 The Bitcoin Core developers
// Copyright (c) 2025 The Blockle Core developers – Alexander Lehman
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <chainparams.h>
#include <chainparamsseeds.h>
#include <consensus/merkle.h>
#include <tinyformat.h>
#include <util/system.h>
#include <util/strencodings.h>
#include <versionbitsinfo.h>

#include <assert.h>
#include <boost/algorithm/string/classification.hpp>

/**
 * CreateGenesisBlock:
 *   timestamp: nTime
 *   nonce:     nNonce
 *   bits:      nBits
 *   version:   nVersion
 *   reward:    genesisReward
 */
static CBlock CreateGenesisBlock(const char* pszTimestamp, const CScript& genesisOutputScript,
                                 uint32_t nTime, uint32_t nNonce, uint32_t nBits,
                                 int32_t nVersion, const CAmount& genesisReward)
{
    CMutableTransaction txNew;
    txNew.nVersion = 1;
    txNew.vin.resize(1);
    txNew.vout.resize(1);
    txNew.vin[0].scriptSig = CScript() << 486604799 << CScriptNum(4)
        << std::vector<unsigned char>((const unsigned char*)pszTimestamp,
                                       (const unsigned char*)pszTimestamp + strlen(pszTimestamp));
    txNew.vout[0].nValue = genesisReward;
    txNew.vout[0].scriptPubKey = genesisOutputScript;

    CBlock genesis;
    genesis.nTime           = nTime;
    genesis.nBits           = nBits;
    genesis.nNonce          = nNonce;
    genesis.nVersion        = nVersion;
    genesis.vtx.push_back(MakeTransactionRef(std::move(txNew)));
    genesis.hashPrevBlock.SetNull();
    genesis.hashMerkleRoot  = BlockMerkleRoot(genesis);
    return genesis;
}

/* Blockle Genesis  (Main/Test/Reg-test share same coin-base script) */
static const char* BLOCKLE_TIMESTAMP =
    "Powered by blockle, timeless, trustless, immutable";
static const CScript BLOCKLE_GENESIS_SCRIPT = CScript() << ParseHex(
    "04b0bf1c225faae6a251c7b2b4e5d959298888bf30739f581f4fa38cd6e27adbd7813674b48ca52ae9c311b2356271d7423dfbff3330bbdc2fc18118e0b3f6cb09"
) << OP_CHECKSIG;

/* =======================================================================
 *  Main-net
 * ======================================================================= */
class CMainParams : public CChainParams {
public:
    CMainParams() {
        strNetworkID = CBaseChainParams::MAIN;
        consensus.nSubsidyHalvingInterval    = 500000;      // ≈ 90 days @ 15 s blocks
        consensus.BIP16Exception             = uint256();
        consensus.BIP34Height                = 1;
        consensus.BIP34Hash                  = uint256();
        consensus.BIP65Height                = 1;
        consensus.BIP66Height                = 1;
        consensus.CSVHeight                  = 1;
        consensus.SegwitHeight               = 1;
        consensus.MinBIP9WarningHeight       = 1 + consensus.nMinerConfirmationWindow;
consensus.powLimit = uint256S("00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        consensus.nPowTargetTimespan         = 1800;    // 30 minutes
        consensus.nPowTargetSpacing          = 15;      // 15 seconds
        consensus.fPowAllowMinDifficultyBlocks = false;
        consensus.fPowNoRetargeting          = false;
        consensus.nRuleChangeActivationThreshold = 1916;   // 95% of 2016
        consensus.nMinerConfirmationWindow      = 2016;   // ≈ 2 weeks

        const uint32_t GEN_TIME   = 1746246581;
        const uint32_t GEN_BITS   = 0x1e0ffff0;
        const uint32_t GEN_NONCE  = 2003207522;
        const CAmount  GEN_REWARD = 1000 * COIN;

        genesis = CreateGenesisBlock(
            BLOCKLE_TIMESTAMP,
            BLOCKLE_GENESIS_SCRIPT,
            GEN_TIME,
            GEN_NONCE,
            GEN_BITS,
            1,
            GEN_REWARD
        );
        consensus.hashGenesisBlock = genesis.GetHash();
        assert(consensus.hashGenesisBlock == uint256S("0x00000113525ba69d3bd39305680d0941c7d21629059685a3efa247bc669438a3"));
        assert(genesis.hashMerkleRoot   == uint256S("0xed0a17b8532e7d1a0ec639e0199e5c400bb4e56433ae4ad5c456c4cb663f5a4c"));

        pchMessageStart[0] = 0xb1;
        pchMessageStart[1] = 0x0c;
        pchMessageStart[2] = 0x4b;
        pchMessageStart[3] = 0x1e;
        nDefaultPort       = 15151;
        nPruneAfterHeight  = 100000;

        m_assumed_blockchain_size    = 2;
        m_assumed_chain_state_size   = 1;

        vSeeds.clear();
        vSeeds.emplace_back("144.126.133.21");

        base58Prefixes[PUBKEY_ADDRESS]  = std::vector<unsigned char>(1,55);
        base58Prefixes[SCRIPT_ADDRESS]  = std::vector<unsigned char>(1,5);
        base58Prefixes[SECRET_KEY]      = std::vector<unsigned char>(1,128);
        base58Prefixes[EXT_PUBLIC_KEY]  = {0x04,0x88,0xB2,0x1E};
        base58Prefixes[EXT_SECRET_KEY]  = {0x04,0x88,0xAD,0xE4};

        bech32_hrp                     = "blk";

        checkpointData = { { {0, consensus.hashGenesisBlock} } };
        chainTxData   = { GEN_TIME, /* nTx */ 1, /* dTx */ 0 };

        fDefaultConsistencyChecks = false;
        fRequireStandard          = true;
        m_is_test_chain           = false;
        m_is_mockable_chain       = false;
    }
};

/* =======================================================================
 *  Test-net
 * ======================================================================= */
class CTestNetParams : public CChainParams {
public:
    CTestNetParams() {
        strNetworkID = CBaseChainParams::TESTNET;
        consensus.nSubsidyHalvingInterval    = 500000;
        consensus.BIP16Exception             = uint256();
        consensus.BIP34Height                = 1;
        consensus.BIP34Hash                  = uint256();
        consensus.BIP65Height                = 1;
        consensus.BIP66Height                = 1;
        consensus.CSVHeight                  = 1;
        consensus.SegwitHeight               = 1;
        consensus.MinBIP9WarningHeight       = 1 + consensus.nMinerConfirmationWindow;
        consensus.powLimit                   = uint256S("00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        consensus.nPowTargetTimespan         = 1800;    // 30 minutes
        consensus.nPowTargetSpacing          = 15;
        consensus.fPowAllowMinDifficultyBlocks = true;
        consensus.fPowNoRetargeting          = false;
        consensus.nRuleChangeActivationThreshold = 1512;   // 75% of 2016
        consensus.nMinerConfirmationWindow      = 2016;

        const uint32_t GEN_TIME   = 1746246581;
        const uint32_t GEN_BITS   = 0x1e0ffff0;
        const uint32_t GEN_NONCE  = 2088673;
        const CAmount  GEN_REWARD = 1000 * COIN;

        genesis = CreateGenesisBlock(
            BLOCKLE_TIMESTAMP,
            BLOCKLE_GENESIS_SCRIPT,
            GEN_TIME,
            GEN_NONCE,
            GEN_BITS,
            1,
            GEN_REWARD
        );
        consensus.hashGenesisBlock = genesis.GetHash();
        assert(consensus.hashGenesisBlock == uint256S("0x00000657cb312e5897fac650c87f61d7b5ca37da15b058e2cca2646ea302827f"));
        assert(genesis.hashMerkleRoot   == uint256S("0xed0a17b8532e7d1a0ec639e0199e5c400bb4e56433ae4ad5c456c4cb663f5a4c"));

        pchMessageStart[0] = 0xb1;
        pchMessageStart[1] = 0x0c;
        pchMessageStart[2] = 0x54;
        pchMessageStart[3] = 0x1e;
        nDefaultPort       = 25151;
        nPruneAfterHeight  = 1000;

        m_assumed_blockchain_size    = 1;
        m_assumed_chain_state_size   = 1;

        vFixedSeeds.clear();
        vSeeds.clear();

        base58Prefixes[PUBKEY_ADDRESS]  = std::vector<unsigned char>(1,111);
        base58Prefixes[SCRIPT_ADDRESS]  = std::vector<unsigned char>(1,196);
        base58Prefixes[SECRET_KEY]      = std::vector<unsigned char>(1,239);
        base58Prefixes[EXT_PUBLIC_KEY]  = {0x04,0x35,0x87,0xCF};
        base58Prefixes[EXT_SECRET_KEY]  = {0x04,0x35,0x83,0x94};

        bech32_hrp                     = "tblk";

        checkpointData = { { {0, consensus.hashGenesisBlock} } };
        chainTxData   = { GEN_TIME, /* nTx */ 1, /* dTx */ 0 };

        fDefaultConsistencyChecks = false;
        fRequireStandard          = false;
        m_is_test_chain           = true;
        m_is_mockable_chain       = false;
    }
};

/* =======================================================================
 *  Reg-test
 * ======================================================================= */
class CRegTestParams : public CChainParams {
public:
    CRegTestParams() {
        strNetworkID = CBaseChainParams::REGTEST;
        consensus.nSubsidyHalvingInterval    = 150;
        consensus.BIP16Exception             = uint256();
        consensus.BIP34Height                = 1;
        consensus.BIP34Hash                  = uint256();
        consensus.BIP65Height                = 1;
        consensus.BIP66Height                = 1;
        consensus.CSVHeight                  = 1;
        consensus.SegwitHeight               = 1;
        consensus.MinBIP9WarningHeight       = 1 + consensus.nMinerConfirmationWindow;
        consensus.powLimit                   = uint256S("7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        consensus.nPowTargetTimespan         = 1800;    // 30 minutes
        consensus.nPowTargetSpacing          = 15;
        consensus.fPowAllowMinDifficultyBlocks = true;
        consensus.fPowNoRetargeting          = true;
        consensus.nRuleChangeActivationThreshold = 108;    // 75% of 144
        consensus.nMinerConfirmationWindow      = 144;

        const uint32_t GEN_TIME   = 1746246581;
        const uint32_t GEN_BITS   = 0x207fffff;
        const uint32_t GEN_NONCE  = 2;
        const CAmount  GEN_REWARD = 1000 * COIN;

        genesis = CreateGenesisBlock(
            BLOCKLE_TIMESTAMP,
            BLOCKLE_GENESIS_SCRIPT,
            GEN_TIME,
            GEN_NONCE,
            GEN_BITS,
            1,
            GEN_REWARD
        );
        consensus.hashGenesisBlock = genesis.GetHash();
        assert(consensus.hashGenesisBlock == uint256S("0x79929b93cf96136bc9fe0b3eaca29f924ff689529af269575242539c3697e995"));
        assert(genesis.hashMerkleRoot   == uint256S("0xed0a17b8532e7d1a0ec639e0199e5c400bb4e56433ae4ad5c456c4cb663f5a4c"));

        pchMessageStart[0] = 0xca;
        pchMessageStart[1] = 0xfe;
        pchMessageStart[2] = 0xba;
        pchMessageStart[3] = 0xbe;
        nDefaultPort       = 18444;
        nPruneAfterHeight  = 1000;

        m_assumed_blockchain_size    = 0;
        m_assumed_chain_state_size   = 0;

        vFixedSeeds.clear();
        vSeeds.clear();

        base58Prefixes[PUBKEY_ADDRESS]  = std::vector<unsigned char>(1,111);
        base58Prefixes[SCRIPT_ADDRESS]  = std::vector<unsigned char>(1,196);
        base58Prefixes[SECRET_KEY]      = std::vector<unsigned char>(1,239);
        base58Prefixes[EXT_PUBLIC_KEY]  = {0x04,0x35,0x87,0xCF};
        base58Prefixes[EXT_SECRET_KEY]  = {0x04,0x35,0x83,0x94};

        bech32_hrp                     = "rblk";

        checkpointData = { { {0, consensus.hashGenesisBlock} } };
        chainTxData   = { GEN_TIME, /* nTx */ 1, /* dTx */ 0 };

        fDefaultConsistencyChecks = true;
        fRequireStandard          = true;
        m_is_test_chain           = true;
        m_is_mockable_chain       = true;
    }
};

/* =======================================================================
 *  Factory / global
 * ======================================================================= */
static std::unique_ptr<const CChainParams> globalChainParams;

const CChainParams& Params() {
    assert(globalChainParams);
    return *globalChainParams;
}

std::unique_ptr<const CChainParams> CreateChainParams(const std::string& chain) {
    if (chain == CBaseChainParams::MAIN)   return std::unique_ptr<const CChainParams>(new CMainParams());
    if (chain == CBaseChainParams::TESTNET) return std::unique_ptr<const CChainParams>(new CTestNetParams());
    if (chain == CBaseChainParams::REGTEST) return std::unique_ptr<const CChainParams>(new CRegTestParams());
    throw std::runtime_error(strprintf("%s: Unknown chain %s.", __func__, chain));
}


void SelectParams(const std::string& network) {
    SelectBaseParams(network);
    globalChainParams = CreateChainParams(network);
}

