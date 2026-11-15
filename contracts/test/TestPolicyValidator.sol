// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only model of a whitelist transfer policy. A holder moving their own token is
/// allowed; any other operator (such as a Seaport conduit) must be whitelisted by the admin.
/// It never holds operator approval over any token. Real Limit Break behavior is covered by
/// the pinned real-validator Foundry suite.
contract TestPolicyValidator {
    address public immutable admin;
    mapping(address => bool) public allowedOperator;
    error OperatorNotAllowed(address caller);

    constructor() { admin = msg.sender; }

    function setOperator(address operator, bool allowed) external {
        require(msg.sender == admin, "admin");
        allowedOperator[operator] = allowed;
    }

    function validateTransfer(address caller, address from, address, uint256) external view {
        if (caller == from || from == address(0) || allowedOperator[caller]) return;
        revert OperatorNotAllowed(caller);
    }
}
