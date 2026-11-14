// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILiquidityXVault, IProtocolConfig} from "./interfaces/ILiquidityX.sol";

/// @title LiquidityXVault
/// @notice Custody of lender stablecoins. Per (lender, asset) the balance is split into
///  available (withdrawable), reserved (backing open offers) and lent (principal out in active loans).
///  Invariant: token.balanceOf(vault) >= totalAvailable + totalReserved.
contract LiquidityXVault is ILiquidityXVault, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MARKET_ROLE = keccak256("MARKET_ROLE");
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");

    /// @dev Not part of the frozen interface.
    error ZeroAddress();
    /// @dev Not part of the frozen interface: same selector as OpenZeppelin Pausable's error.
    error EnforcedPause();

    IProtocolConfig public immutable config;

    mapping(address lender => mapping(address asset => uint256)) public override available;
    mapping(address lender => mapping(address asset => uint256)) public override reserved;
    mapping(address lender => mapping(address asset => uint256)) public override lent;
    mapping(address lender => mapping(address asset => uint256)) public override interestEarned;
    mapping(address asset => uint256) public override totalAvailable;
    mapping(address asset => uint256) public override totalReserved;
    mapping(address asset => uint256) public override totalLent;
    mapping(address asset => uint256) public override totalInterestPaid;

    constructor(IProtocolConfig config_, address admin) {
        if (address(config_) == address(0) || admin == address(0)) revert ZeroAddress();
        config = config_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ lender

    /// @inheritdoc ILiquidityXVault
    function deposit(address asset, uint256 amount) external override nonReentrant {
        if (config.paused()) revert EnforcedPause();
        if (!config.isAssetEnabled(asset)) revert AssetNotEnabled(asset);
        if (amount == 0) revert ZeroAmount();
        _pull(asset, msg.sender, amount);
        available[msg.sender][asset] += amount;
        totalAvailable[asset] += amount;
        emit Deposited(msg.sender, asset, amount);
    }

    /// @inheritdoc ILiquidityXVault
    function withdraw(address asset, uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 avail = available[msg.sender][asset];
        if (avail < amount) revert InsufficientAvailable(avail, amount);
        available[msg.sender][asset] = avail - amount;
        totalAvailable[asset] -= amount;
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount);
    }

    // ------------------------------------------------------------------ marketplace

    function reserve(address lender, address asset, uint256 amount) external override onlyRole(MARKET_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 avail = available[lender][asset];
        if (avail < amount) revert InsufficientAvailable(avail, amount);
        available[lender][asset] = avail - amount;
        reserved[lender][asset] += amount;
        totalAvailable[asset] -= amount;
        totalReserved[asset] += amount;
        emit LiquidityReserved(lender, asset, amount);
    }

    function release(address lender, address asset, uint256 amount) external override onlyRole(MARKET_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 res = reserved[lender][asset];
        if (res < amount) revert InsufficientReserved(res, amount);
        reserved[lender][asset] = res - amount;
        available[lender][asset] += amount;
        totalReserved[asset] -= amount;
        totalAvailable[asset] += amount;
        emit LiquidityReleased(lender, asset, amount);
    }

    // ------------------------------------------------------------------ loan manager

    function fundLoan(uint256 loanId, address lender, address asset, uint256 amount, address borrower, bool fromReserved)
        external
        override
        onlyRole(LOAN_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (fromReserved) {
            uint256 res = reserved[lender][asset];
            if (res < amount) revert InsufficientReserved(res, amount);
            reserved[lender][asset] = res - amount;
            totalReserved[asset] -= amount;
        } else {
            uint256 avail = available[lender][asset];
            if (avail < amount) revert InsufficientAvailable(avail, amount);
            available[lender][asset] = avail - amount;
            totalAvailable[asset] -= amount;
        }
        lent[lender][asset] += amount;
        totalLent[asset] += amount;
        IERC20(asset).safeTransfer(borrower, amount);
        emit LoanFunded(loanId, lender, borrower, asset, amount);
    }

    function collectRepayment(
        uint256 loanId,
        address lender,
        address asset,
        address payer,
        uint256 principal,
        uint256 interest
    ) external override onlyRole(LOAN_ROLE) nonReentrant {
        uint256 total = principal + interest;
        if (total == 0) revert ZeroAmount();
        uint256 l = lent[lender][asset];
        if (l < principal) revert InsufficientLent(l, principal);
        lent[lender][asset] = l - principal;
        totalLent[asset] -= principal;
        available[lender][asset] += total;
        totalAvailable[asset] += total;
        interestEarned[lender][asset] += interest;
        totalInterestPaid[asset] += interest;
        _pull(asset, payer, total);
        emit RepaymentCredited(loanId, lender, asset, principal, interest);
    }

    function writeOff(uint256 loanId, address lender, address asset, uint256 principal)
        external
        override
        onlyRole(LOAN_ROLE)
        nonReentrant
    {
        uint256 l = lent[lender][asset];
        if (l < principal) revert InsufficientLent(l, principal);
        lent[lender][asset] = l - principal;
        totalLent[asset] -= principal;
        emit PrincipalWrittenOff(loanId, lender, asset, principal);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Pulls exactly `amount`; rejects fee-on-transfer / rebasing-on-transfer tokens.
    function _pull(address asset, address from, uint256 amount) internal {
        IERC20 token = IERC20(asset);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert TransferAmountMismatch(amount, received);
    }
}
