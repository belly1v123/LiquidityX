// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILoanManager, IProtocolConfig, ILiquidityXVault, ICollateralManager} from "./interfaces/ILiquidityX.sol";
import {LXTypes} from "./interfaces/ILiquidityXTypes.sol";

/// @title LoanManager
/// @notice Records active loans, accrues simple interest and settles repayments and liquidations.
///  accrue(dt) = ceil(outstandingPrincipal * aprBps * dt / (YEAR * BPS)), checkpointed on every repayment
///  and on liquidation. Interest keeps accruing after maturity at the same APR.
contract LoanManager is ILoanManager, AccessControl, ReentrancyGuard {
    bytes32 public constant MARKET_ROLE = keccak256("MARKET_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");

    /// @dev Not part of the frozen interface.
    error ZeroAddress();

    IProtocolConfig public immutable config;
    ILiquidityXVault public immutable vault;
    ICollateralManager public immutable collateral;

    uint256 public override loanCount;
    mapping(uint256 => LXTypes.Loan) internal _loans;

    constructor(IProtocolConfig config_, ILiquidityXVault vault_, ICollateralManager collateral_, address admin) {
        if (
            address(config_) == address(0) || address(vault_) == address(0) || address(collateral_) == address(0)
                || admin == address(0)
        ) revert ZeroAddress();
        config = config_;
        vault = vault_;
        collateral = collateral_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ open

    /// @inheritdoc ILoanManager
    function openLoan(OpenLoanParams calldata p) external override onlyRole(MARKET_ROLE) nonReentrant returns (uint256 loanId) {
        if (
            p.principal == 0 || p.collateral == 0 || p.duration == 0 || p.aprBps == 0 || p.lender == address(0)
                || p.borrower == address(0) || p.lender == p.borrower || p.asset == address(0)
        ) revert InvalidLoanParams();

        loanId = ++loanCount;
        uint64 start = uint64(block.timestamp);
        uint64 maturity = start + p.duration;
        LXTypes.Loan storage l = _loans[loanId];
        l.id = loanId;
        l.offerId = p.offerId;
        l.requestId = p.requestId;
        l.lender = p.lender;
        l.borrower = p.borrower;
        l.asset = p.asset;
        l.principal = p.principal;
        l.outstandingPrincipal = p.principal;
        l.collateral = p.collateral;
        l.aprBps = p.aprBps;
        l.start = start;
        l.maturity = maturity;
        l.lastAccrual = start;
        l.status = LXTypes.LoanStatus.Active;

        // Interactions: collateral is moved into the loan's lock first, then the borrower is paid.
        if (p.requestId != 0) {
            collateral.assignFromRequest(p.requestId, loanId, p.borrower, p.collateral);
        } else {
            collateral.assignFromFree(loanId, p.borrower, p.collateral);
        }
        vault.fundLoan(loanId, p.lender, p.asset, p.principal, p.borrower, p.fromReserved);

        _emitActivated(p, loanId, start, maturity);
    }

    function _emitActivated(OpenLoanParams calldata p, uint256 loanId, uint64 start, uint64 maturity) internal {
        emit LoanActivated(
            loanId, p.lender, p.borrower, p.asset, p.principal, p.aprBps, start, maturity, p.collateral, p.offerId, p.requestId
        );
    }

    // ------------------------------------------------------------------ repay

    /// @inheritdoc ILoanManager
    function repay(uint256 loanId, uint256 amount) external override nonReentrant returns (uint256 paid) {
        LXTypes.Loan storage l = _loans[loanId];
        if (l.status != LXTypes.LoanStatus.Active) revert LoanNotActive(loanId);
        if (amount == 0) revert ZeroAmount();

        _accrue(l);
        uint256 interestDue = l.accruedInterest;
        uint256 owedTotal = interestDue + l.outstandingPrincipal;
        paid = amount < owedTotal ? amount : owedTotal;
        uint256 interestPart = paid < interestDue ? paid : interestDue;
        uint256 principalPart = paid - interestPart;

        // Effects
        l.accruedInterest = interestDue - interestPart;
        l.interestPaid += interestPart;
        l.outstandingPrincipal -= principalPart;
        l.principalRepaid += principalPart;
        bool full = l.outstandingPrincipal == 0 && l.accruedInterest == 0;
        if (full) {
            l.status = LXTypes.LoanStatus.Repaid;
            l.closedAt = uint64(block.timestamp);
        }
        address lender = l.lender;
        address borrower = l.borrower;
        uint256 remaining = l.outstandingPrincipal;
        uint256 totalInterest = l.interestPaid;

        // Interactions: the vault pulls exactly `paid` from msg.sender (fee-on-transfer rejected there).
        vault.collectRepayment(loanId, lender, l.asset, msg.sender, principalPart, interestPart);
        if (full) collateral.releaseLoan(loanId, borrower);

        emit LoanRepayment(loanId, msg.sender, interestPart, principalPart, remaining);
        if (full) emit LoanRepaid(loanId, totalInterest);
    }

    // ------------------------------------------------------------------ liquidation

    /// @inheritdoc ILoanManager
    function settleLiquidation(uint256 loanId, uint256 lenderCollateral)
        external
        override
        onlyRole(LIQUIDATOR_ROLE)
        nonReentrant
    {
        LXTypes.Loan storage l = _loans[loanId];
        if (l.status != LXTypes.LoanStatus.Active) revert LoanNotActive(loanId);
        uint256 coll = l.collateral;
        if (lenderCollateral > coll) revert ExcessiveSeize(lenderCollateral, coll);

        _accrue(l);
        uint256 principal = l.outstandingPrincipal;
        uint256 interest = l.accruedInterest;
        l.outstandingPrincipal = 0;
        l.accruedInterest = 0;
        l.status = LXTypes.LoanStatus.Liquidated;
        l.closedAt = uint64(block.timestamp);
        address lender = l.lender;
        address borrower = l.borrower;

        vault.writeOff(loanId, lender, l.asset, principal);
        collateral.seize(loanId, lender, lenderCollateral, borrower);

        emit LoanLiquidated(loanId, principal, interest, lenderCollateral, coll - lenderCollateral);
    }

    // ------------------------------------------------------------------ views

    function getLoan(uint256 loanId) external view override returns (LXTypes.Loan memory) {
        return _loans[loanId];
    }

    function getLoans(uint256 start, uint256 count) external view override returns (LXTypes.Loan[] memory out) {
        (uint256 from, uint256 to) = _clamp(start, count, loanCount);
        out = new LXTypes.Loan[](to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = _loans[i];
        }
    }

    function owed(uint256 loanId) external view override returns (uint256 principal, uint256 interest, uint256 total) {
        return _owedAt(_loans[loanId], block.timestamp);
    }

    function owedAt(uint256 loanId, uint256 at) external view override returns (uint256 principal, uint256 interest, uint256 total) {
        return _owedAt(_loans[loanId], at);
    }

    /// @notice Interest accrued over `dt` seconds on `outstanding` at `aprBps`, rounded up.
    function accrueInterest(uint256 outstanding, uint256 aprBps, uint256 dt) public pure returns (uint256) {
        if (dt == 0 || outstanding == 0) return 0;
        uint256 num = outstanding * aprBps * dt;
        if (num == 0) return 0;
        return (num - 1) / (LXTypes.YEAR * LXTypes.BPS) + 1;
    }

    // ------------------------------------------------------------------ internals

    function _owedAt(LXTypes.Loan storage l, uint256 at) internal view returns (uint256 principal, uint256 interest, uint256 total) {
        principal = l.outstandingPrincipal;
        interest = l.accruedInterest;
        if (l.status == LXTypes.LoanStatus.Active && at > l.lastAccrual) {
            interest += accrueInterest(principal, l.aprBps, at - l.lastAccrual);
        }
        total = principal + interest;
    }

    function _accrue(LXTypes.Loan storage l) internal {
        uint256 last = l.lastAccrual;
        if (block.timestamp > last) {
            l.accruedInterest += accrueInterest(l.outstandingPrincipal, l.aprBps, block.timestamp - last);
            l.lastAccrual = uint64(block.timestamp);
        }
    }

    /// @dev Ids start at 1. Returns [from, to) clamped to [1, total+1).
    function _clamp(uint256 start, uint256 count, uint256 total) internal pure returns (uint256 from, uint256 to) {
        from = start == 0 ? 1 : start;
        if (from > total) return (from, from);
        uint256 maxCount = total + 1 - from;
        to = from + (count < maxCount ? count : maxCount);
    }
}
