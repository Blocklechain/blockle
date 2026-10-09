// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Blockle cross-chain atomic-swap HTLC (EVM leg)
/// @notice Non-custodial hash-timelocked contract for native ETH and ARBITRARY
///         ERC-20 tokens (USDC and USDT are first-class legs). Funds move
///         wallet-to-wallet; this contract only escrows a single swap leg and
///         releases it either to the receiver (on preimage reveal) or back to
///         the sender (after the timelock). No operator can move user funds.
///
/// Protocol hash: **SHA-256**. The hashlock is `sha256(preimage)`, matching the
/// Solana leg and the recommended BLOCK leg, so one preimage `s` opens every
/// leg of a swap. See `../PROTOCOL.md`.
///
/// Fee: a configurable protocol fee (basis points) is taken **only on
/// settlement** (`withdraw`) and sent to a configurable fee address. `refund`
/// (a failed swap) takes no fee.
contract HTLC {
    enum State {
        INVALID,
        LOCKED,
        WITHDRAWN,
        REFUNDED
    }

    struct Swap {
        address sender;
        address receiver;
        address token; // address(0) == native ETH
        uint256 amount;
        bytes32 hashlock; // sha256(preimage)
        uint256 timelock; // unix seconds; refund allowed at/after this time
        State state;
    }

    uint256 public constant MAX_FEE_BPS = 100; // hard cap: 1.00%
    uint256 public immutable feeBps;
    address public immutable feeAddress;

    mapping(bytes32 => Swap) public swaps;
    uint256 private _nonce;

    event Locked(
        bytes32 indexed id,
        address indexed sender,
        address indexed receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );
    event Withdrawn(bytes32 indexed id, bytes preimage);
    event Refunded(bytes32 indexed id);

    error BadFee();
    error BadParams();
    error WrongValue();
    error NotLocked();
    error TimelockNotExpired();
    error TimelockExpired();
    error InvalidPreimage();
    error TransferFailed();

    constructor(uint256 _feeBps, address _feeAddress) {
        if (_feeBps > MAX_FEE_BPS) revert BadFee();
        if (_feeBps > 0 && _feeAddress == address(0)) revert BadFee();
        feeBps = _feeBps;
        feeAddress = _feeAddress;
    }

    /// @notice Lock one swap leg. For ETH set `token=address(0)` and send
    ///         `msg.value == amount`. For an ERC-20 first `approve` this
    ///         contract for `amount`, then call with `msg.value == 0`.
    /// @return id Unique identifier for this locked swap leg.
    function lock(
        bytes32 hashlock,
        uint256 timelock,
        address receiver,
        address token,
        uint256 amount
    ) external payable returns (bytes32 id) {
        if (receiver == address(0) || amount == 0) revert BadParams();
        if (timelock <= block.timestamp) revert BadParams();

        id = keccak256(
            abi.encode(
                msg.sender,
                receiver,
                token,
                amount,
                hashlock,
                timelock,
                block.chainid,
                _nonce++
            )
        );
        if (swaps[id].state != State.INVALID) revert BadParams();

        if (token == address(0)) {
            if (msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            _erc20TransferFrom(token, msg.sender, address(this), amount);
        }

        swaps[id] = Swap({
            sender: msg.sender,
            receiver: receiver,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            state: State.LOCKED
        });

        emit Locked(id, msg.sender, receiver, token, amount, hashlock, timelock);
    }

    /// @notice Claim a locked leg by revealing the preimage. Must happen before
    ///         the timelock. Pays `receiver` the amount minus the protocol fee;
    ///         the fee goes to `feeAddress`. Emits the preimage so the
    ///         counterparty can claim the other leg.
    function withdraw(bytes32 id, bytes calldata preimage) external {
        Swap storage s = swaps[id];
        if (s.state != State.LOCKED) revert NotLocked();
        if (block.timestamp >= s.timelock) revert TimelockExpired();
        if (sha256(preimage) != s.hashlock) revert InvalidPreimage();

        s.state = State.WITHDRAWN; // effects before interactions

        uint256 fee = (s.amount * feeBps) / 10_000;
        uint256 payout = s.amount - fee;

        _payOut(s.token, s.receiver, payout);
        if (fee > 0) {
            _payOut(s.token, feeAddress, fee);
        }

        emit Withdrawn(id, preimage);
    }

    /// @notice Refund a locked leg back to the sender once the timelock has
    ///         expired. No fee is taken on a failed swap.
    function refund(bytes32 id) external {
        Swap storage s = swaps[id];
        if (s.state != State.LOCKED) revert NotLocked();
        if (block.timestamp < s.timelock) revert TimelockNotExpired();

        s.state = State.REFUNDED; // effects before interactions

        _payOut(s.token, s.sender, s.amount);

        emit Refunded(id);
    }

    function getSwap(bytes32 id) external view returns (Swap memory) {
        return swaps[id];
    }

    // --- internal transfer helpers (tolerate non-standard tokens like USDT) ---

    function _payOut(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _erc20Transfer(token, to, amount);
        }
    }

    function _erc20Transfer(address token, address to, uint256 amount) internal {
        // transfer(address,uint256)
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _erc20TransferFrom(address token, address from, address to, uint256 amount) internal {
        // transferFrom(address,address,uint256)
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
