// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LiquidityX shared types
/// @notice FROZEN. Units used everywhere in the protocol:
///  - APR and all ratios are basis points: 10_000 = 100%. APR_SCALE = 10_000.
///  - YEAR = 365 days (seconds). Simple interest, see LoanManager.
///  - Prices are USD per 1 BTC with 18 decimals.
///  - Collateral is native testnet BTC (Mezo's gas token), 18 decimals, held as msg.value.
///  - Borrow assets are allowlisted ERC-20s; each is valued at exactly 1 USD (stablecoin peg assumption).
///    USD value (18 dec) of `amount` of an asset with `d` decimals = amount * 10**(18 - d).
///  - Listing and loan ids start at 1. Id 0 means "none".
library LXTypes {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    enum OfferStatus {
        None,
        Open,
        Filled,
        Cancelled
    }

    enum RequestStatus {
        None,
        Open,
        Filled,
        Cancelled
    }

    enum LoanStatus {
        None,
        Active,
        Repaid,
        Liquidated
    }

    /// @dev Reason a loan can be liquidated. None = healthy and not overdue.
    enum LiquidationReason {
        None,
        Undercollateralized,
        Overdue
    }

    /// @notice A lender's standing offer. Liquidity is RESERVED in the vault when the offer is created,
    ///         so an Open offer is always fully backed by `remaining`.
    struct Offer {
        uint256 id;
        address lender;
        address asset;
        uint256 amount; // original amount offered (asset decimals)
        uint256 remaining; // still reserved and fillable
        uint16 aprBps; // fixed APR the lender charges; becomes the loan APR
        uint32 maxDuration; // seconds; loans from this offer may not be longer
        uint16 minCrBps; // lender's minimum initial collateral ratio (>= config.minInitialCrBps)
        uint64 expiry; // unix seconds; not fillable after this
        uint64 createdAt;
        uint32 fills; // number of loans opened from this offer
        OfferStatus status;
    }

    /// @notice A borrower's request. Collateral is LOCKED in the CollateralManager when created.
    struct Request {
        uint256 id;
        address borrower;
        address asset;
        uint256 amount; // total amount requested (asset decimals)
        uint256 filled; // amount already borrowed through fills
        uint16 maxAprBps; // highest APR the borrower accepts
        uint32 duration; // seconds; every loan from this request has exactly this duration
        uint256 collateral; // original BTC locked (wei)
        uint256 collateralRemaining; // BTC still locked for unfilled part (wei)
        uint64 expiry;
        uint64 createdAt;
        uint32 fills;
        RequestStatus status;
    }

    struct Loan {
        uint256 id;
        uint256 offerId; // 0 if the loan did not come from an offer
        uint256 requestId; // 0 if the loan did not come from a request
        address lender;
        address borrower;
        address asset;
        uint256 principal; // original principal
        uint256 outstandingPrincipal;
        uint256 accruedInterest; // interest accrued up to lastAccrual and not yet paid
        uint256 interestPaid;
        uint256 principalRepaid;
        uint256 collateral; // BTC locked for this loan (wei)
        uint16 aprBps;
        uint64 start;
        uint64 maturity; // start + duration
        uint64 lastAccrual;
        uint64 closedAt; // 0 while Active
        LoanStatus status;
    }

    /// @notice Risk parameters. All configurable by RISK_ADMIN_ROLE within hard bounds (see IProtocolConfig).
    struct RiskParams {
        uint16 minInitialCrBps; // e.g. 15_000 = 150%
        uint16 liquidationCrBps; // e.g. 12_000 = 120%; must be < minInitialCrBps and >= 10_500
        uint16 liquidationBonusBps; // extra collateral the lender receives on liquidation, e.g. 500 = 5%
        uint16 minAprBps; // e.g. 1 = 0.01%
        uint16 maxAprBps; // e.g. 10_000 = 100%
        uint32 minDuration; // seconds, e.g. 1 hours (short durations allowed for demos)
        uint32 maxDuration; // seconds, e.g. 365 days
        uint32 gracePeriod; // seconds after maturity before an unpaid loan is Overdue, e.g. 1 days
        uint32 maxListingLifetime; // max seconds between now and a listing's expiry, e.g. 30 days
        uint256 maxCollateralPerLoan; // BTC wei cap per request / loan (concentration limit)
    }

    struct AssetConfig {
        bool enabled;
        uint8 decimals; // read from the token at configuration time
        uint256 minLoan; // asset decimals; minimum size of any single loan / fill
        uint256 maxLoan; // asset decimals; maximum size of any listing or loan
    }
}
