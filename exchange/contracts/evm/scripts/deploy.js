// One-command, gated testnet/mainnet deploy for the EVM HTLC leg.
//
//   npm run deploy:sepolia        # Sepolia testnet
//   npm run deploy:baseSepolia    # Base Sepolia testnet
//   npm run deploy:base           # Base mainnet       (GATED, see below)
//   npm run deploy:ethereum       # Ethereum mainnet   (GATED, see below)
//
// The deployer key comes from env (PRIVATE_KEY; DEPLOYER_PRIVATE_KEY also
// accepted) and the RPC/network from hardhat.config.js — nothing is committed.
// Fee bps + fee address come from config.json or env; nothing is hardcoded.
//
// On success the deployed address is PRINTED and written to deployments.json
// (keyed by network) so the relay can consume it. deployments.json is
// git-ignored by default — commit it deliberately if you want the address
// tracked.
//
// MAINNET IS GATED. This script refuses any non-testnet network unless BOTH
// HTLC_MAINNET_ENABLED=true AND HTLC_LEGAL_REVIEW_REF=<recorded sign-off> are
// set. Testnet-first, always.

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

  // A configured network must have an RPC URL (the local hardhat/localhost
  // networks are the exception). Fail early with a clear message rather than a
  // cryptic provider error.
  const rpcUrl = hre.network.config && hre.network.config.url;
  if (net !== "hardhat" && !rpcUrl) {
    throw new Error(
      `No RPC URL for network '${net}'. Set the matching *_RPC_URL env var (see README) before deploying.`
    );
  }

  const cfgPath = path.join(__dirname, "..", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const feeBps = BigInt(process.env.HTLC_FEE_BPS || cfg.feeBps);
  const feeAddress = process.env.HTLC_FEE_ADDRESS || cfg.feeAddress;

  if (!feeAddress || feeAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("feeAddress must be set (config.json or HTLC_FEE_ADDRESS).");
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error(
      `No deployer account for network '${net}'. Set PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in your env.`
    );
  }

  console.log(`Deploying HTLC to '${net}' as ${deployer.address} feeBps=${feeBps} feeAddress=${feeAddress}`);
  const HTLC = await hre.ethers.getContractFactory("HTLC");
  const htlc = await HTLC.deploy(feeBps, feeAddress);
  const deployTx = htlc.deploymentTransaction();
  await htlc.waitForDeployment();

  const address = await htlc.getAddress();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  console.log("HTLC deployed at:", address);

  // Persist to deployments.json (merge, keyed by network). This file is what
  // the relay reads to learn the live HTLC address per network.
  const outPath = path.join(__dirname, "..", "deployments.json");
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch (_) {
    /* first deploy — start fresh */
  }
  all[net] = {
    network: net,
    chainId,
    address,
    feeBps: Number(feeBps),
    feeAddress,
    deployer: deployer.address,
    txHash: deployTx ? deployTx.hash : null,
    deployedAt: new Date().toISOString(),
    contract: "HTLC",
  };
  fs.writeFileSync(outPath, JSON.stringify(all, null, 2) + "\n");
  console.log("Wrote", path.relative(path.join(__dirname, ".."), outPath));

  if (!TESTNETS.has(net) || net === "sepolia" || net === "baseSepolia") {
    console.log(
      `\nVerify source (needs @nomicfoundation/hardhat-verify + an explorer API key):\n` +
        `  npx hardhat verify --network ${net} ${address} ${feeBps} ${feeAddress}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
