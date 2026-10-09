// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev USDT-style ERC-20 whose transfer/transferFrom return NO value. The HTLC
///      must still treat these as successful (tests the non-standard-token path).
contract NoReturnERC20Mock {
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    // NOTE: no `returns (bool)` — mirrors real USDT on mainnet.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
