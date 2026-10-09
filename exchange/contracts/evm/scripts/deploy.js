// Gated testnet deploy for the EVM HTLC leg.
//
// MAINNET IS DISABLED. This script refuses to run unless either the target
// network is a known testnet OR the operator has explicitly set
// HTLC_MAINNET_ENABLED=true AND HTLC_LEGAL_REVIEW_REF to the recorded legal /
// compliance sign-off reference. Fee bps + fee address come from config.json
// or env; nothing is hardcoded.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const TESTNETS = new Set(["sepolia", "baseSepolia", "hardhat", "localhost"]);

async function main() {
  const net = hre.network.name;
  const mainnetEnabled = process.env.HTLC_MAINNET_ENABLED === "true";
  const legalRef = process.env.HTLC_LEGAL_REVIEW_REF || "";

  if (!TESTNETS.has(net)) {
    if (!mainnetEnabled) {
      throw new Error(
        `Refusing to deploy to non-testnet '${net}': set HTLC_MAINNET_ENABLED=true only AFTER recording a completed legal/compliance review.`
      );
    }
    if (!legalRef) {
      throw new Error("HTLC_MAINNET_ENABLED=true requires HTLC_LEGAL_REVIEW_REF (the sign-off reference).");
    }
    console.log(`[mainnet] proceeding under legal review ref: ${legalRef}`);
  }

  const cfgPath = path.join(__dirname, "..", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const feeBps = BigInt(process.env.HTLC_FEE_BPS || cfg.feeBps);
  const feeAddress = process.env.HTLC_FEE_ADDRESS || cfg.feeAddress;

  if (!feeAddress || feeAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("feeAddress must be set (config.json or HTLC_FEE_ADDRESS).");
  }

  console.log(`Deploying HTLC to '${net}' feeBps=${feeBps} feeAddress=${feeAddress}`);
  const HTLC = await hre.ethers.getContractFactory("HTLC");
  const htlc = await HTLC.deploy(feeBps, feeAddress);
  await htlc.waitForDeployment();
  console.log("HTLC deployed at:", await htlc.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
