const { expect } = require("chai");
const { ethers } = require("hardhat");

const FEE_BPS = 10n; // 0.1%
const ONE_ETH = ethers.parseEther("1");

function randomPreimage() {
  return ethers.hexlify(ethers.randomBytes(32));
}
// Protocol hashlock = sha256(preimage) — matches Solana + recommended BLOCK leg.
function hashlockOf(preimage) {
  return ethers.sha256(preimage);
}

async function now() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp;
}

async function deployHTLC(feeBps, feeAddr) {
  const HTLC = await ethers.getContractFactory("HTLC");
  const htlc = await HTLC.deploy(feeBps, feeAddr);
  await htlc.waitForDeployment();
  return htlc;
}

// Pull the swap id out of the Locked event of a lock() tx.
async function lockIdFrom(tx) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    if (log.fragment && log.fragment.name === "Locked") return log.args.id;
  }
  throw new Error("no Locked event");
}

describe("HTLC", function () {
  let owner, sender, receiver, feeAddr;

  beforeEach(async function () {
    [owner, sender, receiver, feeAddr] = await ethers.getSigners();
  });

  it("rejects a fee above the cap", async function () {
    const HTLC = await ethers.getContractFactory("HTLC");
    await expect(HTLC.deploy(101n, feeAddr.address)).to.be.revertedWithCustomError(HTLC, "BadFee");
  });

  describe("native ETH", function () {
    it("locks, then receiver withdraws with the preimage; fee is taken", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const preimage = randomPreimage();
      const hashlock = hashlockOf(preimage);
      const timelock = (await now()) + 3600;

      const tx = await htlc
        .connect(sender)
        .lock(hashlock, timelock, receiver.address, ethers.ZeroAddress, ONE_ETH, { value: ONE_ETH });
      const id = await lockIdFrom(tx);

      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(ONE_ETH);

      const recvBefore = await ethers.provider.getBalance(receiver.address);
      const feeBefore = await ethers.provider.getBalance(feeAddr.address);

      await expect(htlc.connect(receiver).withdraw(id, preimage))
        .to.emit(htlc, "Withdrawn")
        .withArgs(id, preimage);

      const fee = (ONE_ETH * FEE_BPS) / 10000n;
      const payout = ONE_ETH - fee;
      // receiver pays gas on withdraw, so compare the credited delta loosely.
      const recvAfter = await ethers.provider.getBalance(receiver.address);
      const feeAfter = await ethers.provider.getBalance(feeAddr.address);
      expect(feeAfter - feeBefore).to.equal(fee);
      // receiver got payout minus some gas; delta is positive and < payout.
      expect(recvAfter - recvBefore).to.be.greaterThan(payout - ethers.parseEther("0.01"));
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(0n);
    });

    it("rejects the wrong preimage", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const preimage = randomPreimage();
      const hashlock = hashlockOf(preimage);
      const timelock = (await now()) + 3600;
      const tx = await htlc
        .connect(sender)
        .lock(hashlock, timelock, receiver.address, ethers.ZeroAddress, ONE_ETH, { value: ONE_ETH });
      const id = await lockIdFrom(tx);
      await expect(
        htlc.connect(receiver).withdraw(id, randomPreimage())
      ).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
    });

    it("refunds to the sender after the timelock, and blocks early refund", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const preimage = randomPreimage();
      const hashlock = hashlockOf(preimage);
      const timelock = (await now()) + 3600;
      const tx = await htlc
        .connect(sender)
        .lock(hashlock, timelock, receiver.address, ethers.ZeroAddress, ONE_ETH, { value: ONE_ETH });
      const id = await lockIdFrom(tx);

      await expect(htlc.connect(sender).refund(id)).to.be.revertedWithCustomError(
        htlc,
        "TimelockNotExpired"
      );

      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      const before = await ethers.provider.getBalance(sender.address);
      await htlc.connect(owner).refund(id); // anyone can trigger; funds go to sender
      const after = await ethers.provider.getBalance(sender.address);
      expect(after - before).to.equal(ONE_ETH); // full amount, no fee
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(0n);
    });

    it("blocks withdraw after the timelock expires", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const preimage = randomPreimage();
      const hashlock = hashlockOf(preimage);
      const timelock = (await now()) + 100;
      const tx = await htlc
        .connect(sender)
        .lock(hashlock, timelock, receiver.address, ethers.ZeroAddress, ONE_ETH, { value: ONE_ETH });
      const id = await lockIdFrom(tx);
      await ethers.provider.send("evm_increaseTime", [101]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        htlc.connect(receiver).withdraw(id, preimage)
      ).to.be.revertedWithCustomError(htlc, "TimelockExpired");
    });

    it("prevents double withdraw", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const preimage = randomPreimage();
      const hashlock = hashlockOf(preimage);
      const timelock = (await now()) + 3600;
      const tx = await htlc
        .connect(sender)
        .lock(hashlock, timelock, receiver.address, ethers.ZeroAddress, ONE_ETH, { value: ONE_ETH });
      const id = await lockIdFrom(tx);
      await htlc.connect(receiver).withdraw(id, preimage);
      await expect(
        htlc.connect(receiver).withdraw(id, preimage)
      ).to.be.revertedWithCustomError(htlc, "NotLocked");
    });

    it("rejects wrong msg.value for an ETH lock", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const timelock = (await now()) + 3600;
      await expect(
        htlc
          .connect(sender)
          .lock(hashlockOf(randomPreimage()), timelock, receiver.address, ethers.ZeroAddress, ONE_ETH, {
            value: ONE_ETH - 1n,
          })
      ).to.be.revertedWithCustomError(htlc, "WrongValue");
    });
  });

  describe("ERC-20 (USDC-style, returns bool)", function () {
    it("locks and withdraws an ERC-20 with fee", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const Token = await ethers.getContractFactory("ERC20Mock");
      const usdc = await Token.deploy("USD Coin", "USDC", 6);
      await usdc.waitForDeployment();
      const amount = 1_000_000n; // 1 USDC (6 dp)
      await usdc.mint(sender.address, amount);
      await usdc.connect(sender).approve(await htlc.getAddress(), amount);

      const preimage = randomPreimage();
      const hashlock = hashlockOf(preimage);
      const timelock = (await now()) + 3600;
      const tx = await htlc
        .connect(sender)
        .lock(hashlock, timelock, receiver.address, await usdc.getAddress(), amount);
      const id = await lockIdFrom(tx);

      expect(await usdc.balanceOf(await htlc.getAddress())).to.equal(amount);
      await htlc.connect(receiver).withdraw(id, preimage);

      const fee = (amount * FEE_BPS) / 10000n;
      expect(await usdc.balanceOf(receiver.address)).to.equal(amount - fee);
      expect(await usdc.balanceOf(feeAddr.address)).to.equal(fee);
      expect(await usdc.balanceOf(await htlc.getAddress())).to.equal(0n);
    });

    it("rejects nonzero msg.value on an ERC-20 lock", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const Token = await ethers.getContractFactory("ERC20Mock");
      const usdc = await Token.deploy("USD Coin", "USDC", 6);
      await usdc.waitForDeployment();
      await usdc.mint(sender.address, 100n);
      await usdc.connect(sender).approve(await htlc.getAddress(), 100n);
      const timelock = (await now()) + 3600;
      await expect(
        htlc
          .connect(sender)
          .lock(hashlockOf(randomPreimage()), timelock, receiver.address, await usdc.getAddress(), 100n, {
            value: 1n,
          })
      ).to.be.revertedWithCustomError(htlc, "WrongValue");
    });
  });

  describe("ERC-20 (USDT-style, no return value)", function () {
    it("locks and withdraws a non-standard token", async function () {
      const htlc = await deployHTLC(FEE_BPS, feeAddr.address);
      const Token = await ethers.getContractFactory("NoReturnERC20Mock");
      const usdt = await Token.deploy();
      await usdt.waitForDeployment();
      const amount = 5_000_000n;
      await usdt.mint(sender.address, amount);
      await usdt.connect(sender).approve(await htlc.getAddress(), amount);

      const preimage = randomPreimage();
      const hashlock = hashlockOf(preimage);
      const timelock = (await now()) + 3600;
      const tx = await htlc
        .connect(sender)
        .lock(hashlock, timelock, receiver.address, await usdt.getAddress(), amount);
      const id = await lockIdFrom(tx);

      await htlc.connect(receiver).withdraw(id, preimage);
      const fee = (amount * FEE_BPS) / 10000n;
      expect(await usdt.balanceOf(receiver.address)).to.equal(amount - fee);
      expect(await usdt.balanceOf(feeAddr.address)).to.equal(fee);
    });
  });
});
