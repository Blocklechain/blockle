
// THE PROGRAM HALF OF ops/activate-sol-wallet.sh — run that, not this.
//
// It is a separate file rather than an inline `node -e` because the operator
// prose below is full of apostrophes, and a shell-quoted program that breaks on
// the word "BitGo's" is a script nobody can safely edit later.
//
// Expects two variables from the wrapper, which is where credential loading and
// the refusal-to-run checks live:
//   IPV4_MOD            path to dist/src/ipv4.js   (IPv4 pinning is mandatory)
//   MINT_TEST           "1" to make the one POST; anything else stays read-only
//   BITGO_ACCESS_TOKEN  sourced from the root-only secrets files
//
// Read-only unless MINT_TEST=1. No value of any secret is ever printed.

const { pinAndVerify } = require(process.env.IPV4_MOD);

// These are asserted against the live record below rather than used as input.
// A runbook that disagrees with the custodian must fail loudly, not silently
// send money to a stale address.
const EXPECTED = {
  walletId: "6b06f0530242e6aa1edd125b16f521fe",
  label: "Blockle Exchange SOL",
  rootAddress: "HRdvYQ2StLnLNRHFeyBoDMgBVbCqjAJTm5vAmbmBqEwP",
  minimumFundingLamports: 2447136,
  recommendedLamports: 10000000,
};

const BASE = "https://app.bitgo.com";
const TOKEN = process.env.BITGO_ACCESS_TOKEN;
const MINT = process.env.MINT_TEST === "1";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + TOKEN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, body: json };
}

function line() { console.log("-".repeat(72)); }

(async () => {
  await pinAndVerify("app.bitgo.com");

  const w = await call("GET", `/api/v2/sol/wallet/${EXPECTED.walletId}`);
  if (w.status !== 200) {
    console.error(`\nFAILED: GET on the wallet returned ${w.status}.`);
    if (w.status === 401) {
      console.error(
        "A 401 here is usually the IP restriction, not the token. The IPv4 " +
        "pin above reported success, so if this persists the token itself or " +
        "the allowlisted address has changed."
      );
    }
    console.error(JSON.stringify(w.body, null, 1));
    process.exit(1);
  }

  const cs = w.body.coinSpecific || {};
  const live = {
    label: w.body.label,
    rootAddress: cs.rootAddress,
    pendingChainInitialization: cs.pendingChainInitialization,
    minimumFunding: cs.minimumFunding,
    lastChainIndex: cs.lastChainIndex,
    balanceString: w.body.balanceString,
    confirmedBalanceString: w.body.confirmedBalanceString,
    receiveAddress: w.body.receiveAddress && w.body.receiveAddress.address,
  };

  line();
  console.log("LIVE WALLET RECORD  (sol / " + EXPECTED.walletId + ")");
  line();
  console.log(JSON.stringify(live, null, 1));

  // The address is the one thing that must not be taken on trust.
  if (live.rootAddress !== EXPECTED.rootAddress) {
    console.error(
      `\nSTOP. DO NOT SEND ANYTHING.\n\n` +
      `The runbook expects root address\n  ${EXPECTED.rootAddress}\n` +
      `but BitGo reports\n  ${live.rootAddress}\n\n` +
      `Someone changed a wallet or this script is out of date. Funds sent to a ` +
      `wrong address cannot be recovered by anyone. Resolve the disagreement ` +
      `before funding, and update ops/bitgo-deposit-rails.md and ` +
      `SOL_ACTIVATION in src/settlement.ts together.`
    );
    process.exit(1);
  }
  if (live.label !== EXPECTED.label) {
    console.error(
      `\nSTOP. Wallet ${EXPECTED.walletId} is labelled "${live.label}", not ` +
      `"${EXPECTED.label}". This account is shared with other projects, so an ` +
      `unexpected label may mean this is not the exchange's wallet.`
    );
    process.exit(1);
  }
  console.log("\nOK: root address and label match the runbook.");

  if (live.minimumFunding !== undefined &&
      Number(live.minimumFunding) !== EXPECTED.minimumFundingLamports) {
    console.log(
      `\nNOTE: BitGo now reports minimumFunding ${live.minimumFunding} lamports, ` +
      `not the ${EXPECTED.minimumFundingLamports} recorded in the runbook. The ` +
      `recommended ${EXPECTED.recommendedLamports} still clears it` +
      (Number(live.minimumFunding) >= EXPECTED.recommendedLamports
        ? " — NO LONGER TRUE, SEND MORE. Update SOL_ACTIVATION."
        : "; update SOL_ACTIVATION when convenient.")
    );
  }

  /* --------------------------------------------- still waiting on activation */

  if (live.pendingChainInitialization === true) {
    line();
    console.log("NOT ACTIVATED YET — this is the expected state before funding.");
    line();
    console.log(
      `\nA Solana account does not exist until it is rent-funded, so BitGo has\n` +
      `nothing to derive a per-customer address from and answers the address\n` +
      `POST with HTTP 202 and no address.\n\n` +
      `SEND EXACTLY:   0.01 SOL   (${EXPECTED.recommendedLamports} lamports)\n` +
      `TO:             ${live.rootAddress}\n` +
      `FROM:           any wallet you control\n\n` +
      `Send 0.01 rather than the bare ${EXPECTED.minimumFundingLamports} lamports:\n` +
      `BitGo's minimumFunding must STAY on the wallet and cannot be spent, so\n` +
      `funding the exact minimum activates a wallet with no fee headroom.\n\n` +
      `This script did not and cannot send it. Make the transfer yourself, wait\n` +
      `for confirmation, then run:\n\n` +
      `    ops/activate-sol-wallet.sh --mint-test\n\n` +
      `EXPECT TWO HARMLESS ALARMS, so they are not a surprise. This already\n` +
      `happened on XRP and it halted XRP withdrawals; ops/unbook-unattributed.js\n` +
      `exists only to clean that up. The deposit watcher polls every asset in a\n` +
      `market and does NOT consult railBlocker, and SOL is in that set. So:\n` +
      `  1. the activation payment is seen as a deposit nobody owns and parked\n` +
      `     in __unattributed__ — a liability owed to no one, needing a SOL\n` +
      `     equivalent of ops/unbook-unattributed.js (that script is XRP-only);\n` +
      `  2. if BitGo's confirmedBalanceString excludes any of what you sent, the\n` +
      `     books sit above custody and reconcile reports a SHORTFALL.\n` +
      `Check reconcile after funding. No customer money is involved either way.\n\n` +
      `REMEMBER: activation alone must NOT open the SOL deposit rail. There is\n` +
      `still no consolidation code, so the venue could take SOL it cannot send\n` +
      `back. RAIL_BLOCKERS.SOL lists both causes and keeps the rail shut while\n` +
      `either remains. See ops/bitgo-deposit-rails.md.`
    );
    process.exit(0);
  }

  /* --------------------------------------------------------- activated */

  line();
  console.log("ACTIVATED: pendingChainInitialization is false.");
  line();

  if (!MINT) {
    console.log(
      `\nThe wallet is on chain. Re-run with --mint-test to make the one POST\n` +
      `that proves BitGo will now mint a per-customer address:\n\n` +
      `    ops/activate-sol-wallet.sh --mint-test\n`
    );
    process.exit(0);
  }

  const label = "activation-check-" + new Date().toISOString().slice(0, 10);
  console.log(`\nPOST /api/v2/sol/wallet/${EXPECTED.walletId}/address  label="${label}"`);
  const a = await call("POST", `/api/v2/sol/wallet/${EXPECTED.walletId}/address`, { label });

  console.log(`\nHTTP ${a.status}`);
  console.log(JSON.stringify(a.body, null, 1));

  const addr = ((a.body && a.body.address) || "").trim();

  if (a.status === 403) {
    console.error(
      `\nFAILED, AND THIS IS THE IMPORTANT NEGATIVE RESULT.\n\n` +
      `A 403 here means Solana address creation is plan-gated exactly like ETH\n` +
      `and BNB, and the 202 was hiding it. The ~$2 bought the answer to\n` +
      `question 2 of the BitGo ticket. SOL then needs either the BitGo plan or\n` +
      `the offline-derived keypair pool (generalise src/blockaddresspool.ts).\n` +
      `Record this in ops/bitgo-deposit-rails.md and in RAIL_BLOCKERS.SOL.`
    );
    process.exit(1);
  }
  if (a.status === 202 || addr === "") {
    console.error(
      `\nFAILED: BitGo still will not mint an address.\n\n` +
      `If the error still says "pending on-chain initialization", the funding\n` +
      `transaction may not have confirmed, or it went to a different address.\n` +
      `Nothing has been stored and no customer address exists.`
    );
    process.exit(1);
  }
  if (a.status !== 200 && a.status !== 201) {
    console.error(`\nFAILED: unexpected status ${a.status}.`);
    process.exit(1);
  }
  if (addr === live.rootAddress) {
    console.error(
      `\nFAILED, AND DO NOT USE THIS ADDRESS.\n\n` +
      `BitGo returned the wallet ROOT address rather than a new derived one.\n` +
      `Solana has no memo or tag, so handing the root to customers makes their\n` +
      `deposits permanently unattributable. The rail stays shut.`
    );
    process.exit(1);
  }

  line();
  console.log("PASS. BitGo minted a NEW per-customer Solana address.");
  line();
  console.log(`  address  ${addr}`);
  console.log(`  root     ${live.rootAddress}   (different — correct)`);
  console.log(`  label    ${a.body.label || label}`);

  /* ----- the measurement that is only cheap to make today, with ~$2 at risk */

  const after = await call("GET", `/api/v2/sol/wallet/${EXPECTED.walletId}`);
  const addrs = await call(
    "GET", `/api/v2/sol/wallet/${EXPECTED.walletId}/addresses?limit=50`);

  line();
  console.log("DOES THE WALLET BALANCE AGGREGATE PER-ADDRESS ACCOUNTS?");
  line();
  console.log(
    `\nSolana credits each receive address's OWN account. If BitGo's\n` +
    `wallet-level balance reports only the root, then BitGoHoldings.holdings\n` +
    `(src/bitgo.ts) will read real customer deposits as a SHORTFALL until a\n` +
    `consolidation runs. Record these two numbers now, while the only money on\n` +
    `the wallet is the activation payment:\n`
  );
  console.log(`  wallet balanceString           ${after.body.balanceString}`);
  console.log(`  wallet confirmedBalanceString  ${after.body.confirmedBalanceString}`);
  for (const x of (addrs.body.addresses || [])) {
    const b = (x.balance && (x.balance.confirmedBalanceString ?? x.balance.balanceString));
    console.log(`  address index ${x.index}  ${x.address}  balance ${b ?? "(not reported)"}`);
  }
  console.log(
    `\nTo settle it: send a small amount to the NEW address above, wait for\n` +
    `confirmation, re-run this command, and see whether the wallet balance\n` +
    `grew. Write the answer into ops/bitgo-deposit-rails.md.\n\n` +
    `THE SOL RAIL IS STILL SHUT, CORRECTLY. The second blocker is unchanged:\n` +
    `there is no consolidation code, so the venue cannot pay SOL back out.\n` +
    `Clear RAIL_BLOCKERS.SOL only when BOTH causes are gone.`
  );
})().catch((e) => {
  console.error("\nFAILED: " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
