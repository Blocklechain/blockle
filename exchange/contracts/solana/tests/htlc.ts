import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Htlc } from "../target/types/htlc";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { assert } from "chai";

const FEE_BPS = 10; // 0.1%

// Protocol hashlock = sha256(preimage), identical to the EVM leg.
function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}
function randomId(): Buffer {
  return Buffer.from(anchor.web3.Keypair.generate().secretKey.slice(0, 32));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("htlc", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Htlc as Program<Htlc>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  )[0];
  const feeWallet = Keypair.generate();

  function swapPda(id: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("swap"), id], program.programId)[0];
  }
  function vaultPda(id: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("vault"), id], program.programId)[0];
  }

  it("initializes config (mainnet disabled)", async () => {
    await program.methods
      .initialize(FEE_BPS, feeWallet.publicKey)
      .accounts({ config: configPda, authority: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.feeBps, FEE_BPS);
    assert.isFalse(cfg.mainnetEnabled);
    assert.ok(cfg.feeWallet.equals(feeWallet.publicKey));
  });

  it("SOL: lock then withdraw with preimage (fee taken)", async () => {
    const id = randomId();
    const preimage = randomId();
    const hashlock = sha256(preimage);
    const amount = new BN(1 * LAMPORTS_PER_SOL);
    const timelock = new BN(Math.floor(Date.now() / 1000) + 3600);
    const receiver = Keypair.generate();
    const swap = swapPda(id);

    await program.methods
      .lockSol([...id], [...hashlock], timelock, receiver.publicKey, amount)
      .accounts({ swap, sender: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    const recvBefore = await provider.connection.getBalance(receiver.publicKey);
    const feeBefore = await provider.connection.getBalance(feeWallet.publicKey);

    await program.methods
      .withdrawSol(Buffer.from(preimage))
      .accounts({
        swap,
        config: configPda,
        receiver: receiver.publicKey,
        feeWallet: feeWallet.publicKey,
        caller: payer.publicKey,
      })
      .rpc();

    const fee = amount.toNumber() * FEE_BPS / 10000;
    const payout = amount.toNumber() - fee;
    assert.equal((await provider.connection.getBalance(receiver.publicKey)) - recvBefore, payout);
    assert.equal((await provider.connection.getBalance(feeWallet.publicKey)) - feeBefore, fee);
  });

  it("SOL: wrong preimage is rejected", async () => {
    const id = randomId();
    const preimage = randomId();
    const hashlock = sha256(preimage);
    const amount = new BN(0.5 * LAMPORTS_PER_SOL);
    const timelock = new BN(Math.floor(Date.now() / 1000) + 3600);
    const receiver = Keypair.generate();
    const swap = swapPda(id);

    await program.methods
      .lockSol([...id], [...hashlock], timelock, receiver.publicKey, amount)
      .accounts({ swap, sender: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    try {
      await program.methods
        .withdrawSol(Buffer.from(randomId()))
        .accounts({
          swap,
          config: configPda,
          receiver: receiver.publicKey,
          feeWallet: feeWallet.publicKey,
          caller: payer.publicKey,
        })
        .rpc();
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidPreimage");
    }
  });

  it("SOL: refund after the timelock, early refund blocked", async () => {
    const id = randomId();
    const preimage = randomId();
    const hashlock = sha256(preimage);
    const amount = new BN(0.25 * LAMPORTS_PER_SOL);
    const timelock = new BN(Math.floor(Date.now() / 1000) + 2);
    const swap = swapPda(id);

    await program.methods
      .lockSol([...id], [...hashlock], timelock, Keypair.generate().publicKey, amount)
      .accounts({ swap, sender: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    // Early refund blocked.
    try {
      await program.methods
        .refundSol()
        .accounts({ swap, sender: payer.publicKey, caller: payer.publicKey })
        .rpc();
      assert.fail("early refund should fail");
    } catch (e: any) {
      assert.include(e.toString(), "TimelockNotExpired");
    }

    await sleep(3000);
    const before = await provider.connection.getBalance(payer.publicKey);
    await program.methods
      .refundSol()
      .accounts({ swap, sender: payer.publicKey, caller: payer.publicKey })
      .rpc();
    // Sender gets the amount back (plus reclaimed rent); strictly increases.
    assert.isAbove(await provider.connection.getBalance(payer.publicKey), before);
  });

  it("SPL: lock then withdraw a token with fee", async () => {
    const mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const senderAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, mint, payer.publicKey
    );
    const receiver = Keypair.generate();
    const receiverAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, mint, receiver.publicKey
    );
    const feeAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, mint, feeWallet.publicKey
    );
    const amount = 1_000_000; // 1 token (6 dp)
    await mintTo(provider.connection, payer, mint, senderAta.address, payer, amount);

    const id = randomId();
    const preimage = randomId();
    const hashlock = sha256(preimage);
    const timelock = new BN(Math.floor(Date.now() / 1000) + 3600);
    const swap = swapPda(id);
    const vault = vaultPda(id);

    await program.methods
      .lockSpl([...id], [...hashlock], timelock, receiver.publicKey, new BN(amount))
      .accounts({
        swap,
        vault,
        mint,
        senderAta: senderAta.address,
        sender: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    assert.equal(Number((await getAccount(provider.connection, vault)).amount), amount);

    await program.methods
      .withdrawSpl(Buffer.from(preimage))
      .accounts({
        swap,
        config: configPda,
        vault,
        receiverAta: receiverAta.address,
        feeAta: feeAta.address,
        sender: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        caller: payer.publicKey,
      })
      .rpc();

    const fee = (amount * FEE_BPS) / 10000;
    assert.equal(Number((await getAccount(provider.connection, receiverAta.address)).amount), amount - fee);
    assert.equal(Number((await getAccount(provider.connection, feeAta.address)).amount), fee);
  });
});
