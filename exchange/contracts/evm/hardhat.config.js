require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

// Testnet-first. Mainnet networks are intentionally NOT configured here; a
// mainnet deploy must only happen after the operator records a completed legal
// review (see README + ../PROTOCOL.md). RPC URLs / keys come from env vars and
// are never committed.
const { SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;

const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts,
    },
  },
};
