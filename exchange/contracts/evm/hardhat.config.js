require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

// Optional: Etherscan/Basescan source verification. Only loaded if the plugin
// is installed (`npm i -D @nomicfoundation/hardhat-verify`), so compile/test
// keep working with no extra deps. When present it adds the `verify` task.
try {
  require("@nomicfoundation/hardhat-verify");
} catch (_) {
  /* verify plugin not installed; `npm run verify:*` will tell you to add it */
}

// TESTNET-FIRST. Mainnet networks (base, ethereum) ARE configured here so a
// mainnet deploy is one command FOR WHOEVER HOLDS THE KEYS — but scripts/deploy.js
// still REFUSES any non-testnet target unless HTLC_MAINNET_ENABLED=true AND
// HTLC_LEGAL_REVIEW_REF are set (see README + ../PROTOCOL.md). RPC URLs and the
// deployer key come from env vars and are NEVER committed.
const {
  SEPOLIA_RPC_URL,
  BASE_SEPOLIA_RPC_URL,
  BASE_RPC_URL,
  ETHEREUM_RPC_URL,
  // Primary deployer key env is PRIVATE_KEY (shared convention across all
  // exchange legs); DEPLOYER_PRIVATE_KEY stays supported for back-compat.
  PRIVATE_KEY,
  DEPLOYER_PRIVATE_KEY,
  ETHERSCAN_API_KEY,
  BASESCAN_API_KEY,
} = process.env;

const deployerKey = PRIVATE_KEY || DEPLOYER_PRIVATE_KEY;
const accounts = deployerKey ? [deployerKey] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    // --- testnets (default targets) ---
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      chainId: 11155111,
      accounts,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    // --- mainnets (GATED by scripts/deploy.js; RPC from env, no default) ---
    base: {
      url: BASE_RPC_URL || "",
      chainId: 8453,
      accounts,
    },
    ethereum: {
      url: ETHEREUM_RPC_URL || "",
      chainId: 1,
      accounts,
    },
  },
  // Source verification. API keys from env; keys are never committed. Base uses
  // Basescan via a customChain entry so one `verify` task covers both families.
  etherscan: {
    apiKey: {
      mainnet: ETHERSCAN_API_KEY || "",
      sepolia: ETHERSCAN_API_KEY || "",
      base: BASESCAN_API_KEY || "",
      baseSepolia: BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: { apiURL: "https://api.basescan.org/api", browserURL: "https://basescan.org" },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};
