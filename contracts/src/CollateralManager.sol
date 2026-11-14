// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICollateralManager, IProtocolConfig} from "./interfaces/ILiquidityX.sol";

/// @title CollateralManager
/// @notice Custody of native BTC (Mezo's gas token) used as collateral.
///  Per account: free (withdrawable). Per request: locked. Per loan: locked.
///  Invariant: address(this).balance == totalFree + totalLockedInRequests + totalLockedInLoans.
contract CollateralManager is ICollateralManager, AccessControl, ReentrancyGuard {
    bytes32 public constant MARKET_ROLE = keccak256("MARKET_ROLE");
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");

    /// @dev Not part of the frozen interface.
    error ZeroAddress();
    /// @dev Not part of the frozen interface: same selector as OpenZeppelin Pausable's error.
    error EnforcedPause();

    IProtocolConfig public immutable config;

    mapping(address account => uint256) public override freeCollateral;
    mapping(uint256 requestId => uint256) public override requestCollateral;
    mapping(uint256 loanId => uint256) public override loanCollateral;
    uint256 public override totalFree;
    uint256 public override totalLockedInRequests;
    uint256 public override totalLockedInLoans;

    constructor(IProtocolConfig config_, address admin) {
        if (address(config_) == address(0) || admin == address(0)) revert ZeroAddress();
        config = config_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @dev Plain transfers would bypass accounting; only depositCollateral / depositFor accept BTC.
    receive() external payable {
        revert DirectTransferNotAllowed();
    }

    fallback() external payable {
        revert DirectTransferNotAllowed();
    }

    // ------------------------------------------------------------------ users

    function depositCollateral() external payable override nonReentrant {
        if (config.paused()) revert EnforcedPause();
        if (msg.value == 0) revert ZeroAmount();
        _credit(msg.sender, msg.value);
        emit CollateralDeposited(msg.sender, msg.value);
    }

    /// @notice CEI + nonReentrant: balance is debited before the native transfer.
    function withdrawCollateral(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeCollateral[msg.sender];
        if (free < amount) revert InsufficientFree(free, amount);
        freeCollateral[msg.sender] = free - amount;
        totalFree -= amount;
        emit CollateralWithdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ------------------------------------------------------------------ marketplace

    function depositFor(address account) external payable override onlyRole(MARKET_ROLE) nonReentrant {
        if (config.paused()) revert EnforcedPause();
        if (msg.value == 0) revert ZeroAmount();
        _credit(account, msg.value);
        emit CollateralDeposited(account, msg.value);
    }

    function lockForRequest(uint256 requestId, address account, uint256 amount)
        external
        override
        onlyRole(MARKET_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        _debitFree(account, amount);
        requestCollateral[requestId] += amount;
        totalLockedInRequests += amount;
        emit CollateralLocked(requestId, account, amount);
    }

    function unlockFromRequest(uint256 requestId, address account, uint256 amount)
        external
        override
        onlyRole(MARKET_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        _debitRequest(requestId, amount);
        _credit(account, amount);
        emit CollateralUnlocked(requestId, account, amount);
    }

    // ------------------------------------------------------------------ loan manager

    function assignFromRequest(uint256 requestId, uint256 loanId, address account, uint256 amount)
        external
        override
        onlyRole(LOAN_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        _debitRequest(requestId, amount);
        loanCollateral[loanId] += amount;
        totalLockedInLoans += amount;
        emit CollateralAssignedToLoan(loanId, requestId, account, amount);
    }

    function assignFromFree(uint256 loanId, address account, uint256 amount)
        external
        override
        onlyRole(LOAN_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        _debitFree(account, amount);
        loanCollateral[loanId] += amount;
        totalLockedInLoans += amount;
        emit CollateralAssignedToLoan(loanId, 0, account, amount);
    }

    /// @notice Moves ALL of the loan's collateral to `account`. Empties the lock, so it cannot run twice.
    function releaseLoan(uint256 loanId, address account) external override onlyRole(LOAN_ROLE) nonReentrant {
        uint256 amount = loanCollateral[loanId];
        if (amount == 0) revert InsufficientLocked(0, 1);
        loanCollateral[loanId] = 0;
        totalLockedInLoans -= amount;
        _credit(account, amount);
        emit CollateralReleased(loanId, account, amount);
    }

    /// @notice Splits ALL of the loan's collateral: lenderAmount to the lender, the rest to the borrower.
    function seize(uint256 loanId, address lender, uint256 lenderAmount, address borrower)
        external
        override
        onlyRole(LOAN_ROLE)
        nonReentrant
    {
        uint256 amount = loanCollateral[loanId];
        if (amount == 0 || lenderAmount > amount) revert InsufficientLocked(amount, lenderAmount == 0 ? 1 : lenderAmount);
        loanCollateral[loanId] = 0;
        totalLockedInLoans -= amount;
        uint256 borrowerAmount = amount - lenderAmount;
        if (lenderAmount > 0) _credit(lender, lenderAmount);
        if (borrowerAmount > 0) _credit(borrower, borrowerAmount);
        emit CollateralSeized(loanId, lender, lenderAmount, borrower, borrowerAmount);
    }

    // ------------------------------------------------------------------ internals

    function _credit(address account, uint256 amount) internal {
        freeCollateral[account] += amount;
        totalFree += amount;
    }

    function _debitFree(address account, uint256 amount) internal {
        uint256 free = freeCollateral[account];
        if (free < amount) revert InsufficientFree(free, amount);
        freeCollateral[account] = free - amount;
        totalFree -= amount;
    }

    function _debitRequest(uint256 requestId, uint256 amount) internal {
        uint256 locked = requestCollateral[requestId];
        if (locked < amount) revert InsufficientLocked(locked, amount);
        requestCollateral[requestId] = locked - amount;
        totalLockedInRequests -= amount;
    }
}
