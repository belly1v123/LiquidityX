// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LXTypes} from "./ILiquidityXTypes.sol";

/// Roles (bytes32 = keccak256 of the name): DEFAULT_ADMIN_ROLE (0x00), RISK_ADMIN_ROLE, PAUSER_ROLE,
/// MARKET_ROLE (granted to LoanMarketplace on Vault, CollateralManager, LoanManager),
/// LOAN_ROLE (granted to LoanManager on Vault, CollateralManager), LIQUIDATOR_ROLE (LiquidationEngine on LoanManager),
/// KEEPER_ROLE (optional bots on LiquidationEngine).
/// FROZEN INTERFACES. Implementations must match these signatures, events and errors exactly.
/// Frontend and backend ABIs are generated from the compiled implementations; any change here
/// must be agreed by the architect and reflected in docs/CONTRACTS.md.

// ---------------------------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------------------------

/// @notice Minimal Chainlink AggregatorV3 surface. Mezo testnet's BTC/USD precompile
///         0x7b7c000000000000000000000000000000000015 implements this (18 decimals, answeredInRound = 0).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IPriceOracleAdapter {
    event FeedUpdated(address indexed feed, uint8 feedDecimals);
    event MaxStalenessUpdated(uint256 maxStaleness);

    error InvalidFeed();
    error InvalidPrice();
    error StalePrice(uint256 updatedAt, uint256 maxStaleness);

    /// @return price USD per 1 BTC, 18 decimals. Reverts InvalidPrice / StalePrice.
    function getPrice() external view returns (uint256 price, uint256 updatedAt);
    /// @notice Never reverts. ok=false when the feed reverts, the answer <= 0, or the answer is stale.
    function tryGetPrice() external view returns (bool ok, uint256 price, uint256 updatedAt);
    function feed() external view returns (address);
    function feedDecimals() external view returns (uint8);
    function maxStaleness() external view returns (uint256);
    /// @dev DEFAULT_ADMIN_ROLE only. Reads decimals() from the new feed; reverts InvalidFeed if it fails or > 36.
    function setFeed(address newFeed) external;
    /// @dev DEFAULT_ADMIN_ROLE only. Bounds: 30 seconds .. 1 days.
    function setMaxStaleness(uint256 newMaxStaleness) external;
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

interface IProtocolConfig {
    event RiskParamsUpdated(LXTypes.RiskParams params);
    event AssetConfigured(address indexed asset, bool enabled, uint8 decimals, uint256 minLoan, uint256 maxLoan);

    error InvalidRiskParams();
    error InvalidAsset();

    /// @notice Global pause (OpenZeppelin Pausable on ProtocolConfig; emits Paused/Unpaused). While paused:
    ///  new deposits, collateral deposits, listings and matches revert; withdrawals, cancellations,
    ///  repayments and liquidations keep working. PAUSER_ROLE calls pause()/unpause().
    function paused() external view returns (bool);
    function pause() external;
    function unpause() external;

    function riskParams() external view returns (LXTypes.RiskParams memory);
    function assetConfig(address asset) external view returns (LXTypes.AssetConfig memory);
    function isAssetEnabled(address asset) external view returns (bool);
    /// @notice All assets ever configured (enabled or not), in configuration order.
    function listAssets() external view returns (address[] memory);
    /// @dev RISK_ADMIN_ROLE. Hard bounds (revert InvalidRiskParams otherwise):
    ///  10_500 <= liquidationCrBps < minInitialCrBps <= 50_000; liquidationBonusBps <= 2_000;
    ///  1 <= minAprBps <= maxAprBps <= 50_000; 60 <= minDuration <= maxDuration <= 730 days;
    ///  gracePeriod <= 30 days; 1 hours <= maxListingLifetime <= 365 days; maxCollateralPerLoan > 0;
    ///  and the bonus must not make a liquidation at the threshold unsafe:
    ///  (10_000 + liquidationBonusBps) <= liquidationCrBps.
    function setRiskParams(LXTypes.RiskParams calldata params) external;
    /// @dev RISK_ADMIN_ROLE. Reads decimals() from the token (must be 1..18, else InvalidAsset).
    ///  minLoan > 0 and minLoan <= maxLoan required.
    function configureAsset(address asset, bool enabled, uint256 minLoan, uint256 maxLoan) external;
}

// ---------------------------------------------------------------------------------------------
// Vault: lender stablecoin custody and accounting
// ---------------------------------------------------------------------------------------------

/// Per (lender, asset): available (withdrawable), reserved (backing open offers), lent (principal
/// currently out in active loans). Invariant: token.balanceOf(vault) >= totalAvailable + totalReserved.
interface ILiquidityXVault {
    event Deposited(address indexed lender, address indexed asset, uint256 amount);
    event Withdrawn(address indexed lender, address indexed asset, uint256 amount);
    event LiquidityReserved(address indexed lender, address indexed asset, uint256 amount);
    event LiquidityReleased(address indexed lender, address indexed asset, uint256 amount);
    event LoanFunded(
        uint256 indexed loanId, address indexed lender, address indexed borrower, address asset, uint256 amount
    );
    event RepaymentCredited(
        uint256 indexed loanId, address indexed lender, address asset, uint256 principal, uint256 interest
    );
    event PrincipalWrittenOff(uint256 indexed loanId, address indexed lender, address asset, uint256 principal);

    error AssetNotEnabled(address asset);
    error ZeroAmount();
    error InsufficientAvailable(uint256 available, uint256 needed);
    error InsufficientReserved(uint256 reserved, uint256 needed);
    error InsufficientLent(uint256 lent, uint256 needed);
    error TransferAmountMismatch(uint256 expected, uint256 received);

    /// @notice Pulls `amount` from msg.sender (needs ERC-20 approval). Rejects fee-on-transfer tokens.
    ///         Blocked while paused. Asset must be enabled.
    function deposit(address asset, uint256 amount) external;
    /// @notice Withdraw from available balance only. Allowed while paused.
    function withdraw(address asset, uint256 amount) external;

    function available(address lender, address asset) external view returns (uint256);
    function reserved(address lender, address asset) external view returns (uint256);
    function lent(address lender, address asset) external view returns (uint256);
    /// @notice Lifetime interest credited to the lender for the asset.
    function interestEarned(address lender, address asset) external view returns (uint256);
    function totalAvailable(address asset) external view returns (uint256);
    function totalReserved(address asset) external view returns (uint256);
    function totalLent(address asset) external view returns (uint256);
    function totalInterestPaid(address asset) external view returns (uint256);

    /// @dev MARKET_ROLE (LoanMarketplace). available -> reserved.
    function reserve(address lender, address asset, uint256 amount) external;
    /// @dev MARKET_ROLE. reserved -> available.
    function release(address lender, address asset, uint256 amount) external;
    /// @dev LOAN_ROLE (LoanManager). Moves `amount` from reserved (fromReserved=true) or available into lent,
    ///      then transfers `amount` of asset to `borrower`.
    function fundLoan(
        uint256 loanId,
        address lender,
        address asset,
        uint256 amount,
        address borrower,
        bool fromReserved
    ) external;
    /// @dev LOAN_ROLE. Pulls principal+interest from `payer` (payer approved the VAULT), lent -= principal,
    ///      available += principal + interest, interestEarned += interest.
    function collectRepayment(
        uint256 loanId,
        address lender,
        address asset,
        address payer,
        uint256 principal,
        uint256 interest
    ) external;
    /// @dev LOAN_ROLE. Used on liquidation: lent -= principal (lender is compensated in BTC collateral).
    function writeOff(uint256 loanId, address lender, address asset, uint256 principal) external;
}

// ---------------------------------------------------------------------------------------------
// CollateralManager: native BTC custody
// ---------------------------------------------------------------------------------------------

/// Per account: free (withdrawable) BTC. Per request: locked BTC. Per loan: locked BTC.
/// Invariant: address(this).balance == totalFree + totalLockedInRequests + totalLockedInLoans.
interface ICollateralManager {
    event CollateralDeposited(address indexed account, uint256 amount);
    event CollateralWithdrawn(address indexed account, uint256 amount);
    event CollateralLocked(uint256 indexed requestId, address indexed account, uint256 amount);
    event CollateralUnlocked(uint256 indexed requestId, address indexed account, uint256 amount);
    event CollateralAssignedToLoan(uint256 indexed loanId, uint256 indexed requestId, address indexed account, uint256 amount);
    event CollateralReleased(uint256 indexed loanId, address indexed account, uint256 amount);
    event CollateralSeized(
        uint256 indexed loanId, address indexed lender, uint256 lenderAmount, address indexed borrower, uint256 borrowerAmount
    );

    error ZeroAmount();
    error InsufficientFree(uint256 free, uint256 needed);
    error InsufficientLocked(uint256 locked, uint256 needed);
    error NativeTransferFailed();
    error DirectTransferNotAllowed();

    /// @notice Deposit native BTC as free collateral. Blocked while paused.
    function depositCollateral() external payable;
    /// @notice Withdraw free BTC to msg.sender. Allowed while paused.
    function withdrawCollateral(uint256 amount) external;

    function freeCollateral(address account) external view returns (uint256);
    function requestCollateral(uint256 requestId) external view returns (uint256);
    function loanCollateral(uint256 loanId) external view returns (uint256);
    function totalFree() external view returns (uint256);
    function totalLockedInRequests() external view returns (uint256);
    function totalLockedInLoans() external view returns (uint256);

    /// @dev MARKET_ROLE. Credits msg.value to `account`'s free balance (used for payable listing calls).
    function depositFor(address account) external payable;
    /// @dev MARKET_ROLE. free[account] -> request[requestId].
    function lockForRequest(uint256 requestId, address account, uint256 amount) external;
    /// @dev MARKET_ROLE. request[requestId] -> free[account].
    function unlockFromRequest(uint256 requestId, address account, uint256 amount) external;
    /// @dev LOAN_ROLE. request[requestId] -> loan[loanId].
    function assignFromRequest(uint256 requestId, uint256 loanId, address account, uint256 amount) external;
    /// @dev LOAN_ROLE. free[account] -> loan[loanId] (requestId 0 in the event).
    function assignFromFree(uint256 loanId, address account, uint256 amount) external;
    /// @dev LOAN_ROLE. loan[loanId] (all of it) -> free[account].
    function releaseLoan(uint256 loanId, address account) external;
    /// @dev LOAN_ROLE. loan[loanId] (all of it): lenderAmount -> free[lender], the rest -> free[borrower].
    function seize(uint256 loanId, address lender, uint256 lenderAmount, address borrower) external;
}

// ---------------------------------------------------------------------------------------------
// LoanManager: active loan accounting
// ---------------------------------------------------------------------------------------------

/// Interest (simple, on outstanding principal, rounded UP in the lender's favour):
///   accrue(dt) = ceil(outstandingPrincipal * aprBps * dt / (YEAR * BPS))
/// Accrued on every repayment and on liquidation; interest keeps accruing after maturity at the same APR.
/// owed() = accruedInterest + accrue(now - lastAccrual) + outstandingPrincipal.
interface ILoanManager {
    struct OpenLoanParams {
        uint256 offerId;
        uint256 requestId; // if non-zero, collateral comes from this request's lock, else from borrower's free balance
        address lender;
        address borrower;
        address asset;
        uint256 principal;
        uint16 aprBps;
        uint32 duration;
        uint256 collateral;
        bool fromReserved; // lender liquidity comes from an offer's reservation (true) or available balance (false)
    }

    event LoanActivated(
        uint256 indexed loanId,
        address indexed lender,
        address indexed borrower,
        address asset,
        uint256 principal,
        uint16 aprBps,
        uint64 start,
        uint64 maturity,
        uint256 collateral,
        uint256 offerId,
        uint256 requestId
    );
    event LoanRepayment(
        uint256 indexed loanId,
        address indexed payer,
        uint256 interestPaid,
        uint256 principalPaid,
        uint256 outstandingPrincipal
    );
    event LoanRepaid(uint256 indexed loanId, uint256 totalInterestPaid);
    event LoanLiquidated(
        uint256 indexed loanId, uint256 principalWrittenOff, uint256 interestWrittenOff, uint256 lenderCollateral, uint256 borrowerCollateral
    );

    error LoanNotActive(uint256 loanId);
    error ZeroAmount();
    error InvalidLoanParams();
    error ExcessiveSeize(uint256 seize, uint256 collateral);

    /// @dev MARKET_ROLE. Funds the borrower from the vault, moves collateral to the loan, records the loan.
    function openLoan(OpenLoanParams calldata p) external returns (uint256 loanId);
    /// @notice Anyone may repay (tokens are pulled from msg.sender via the VAULT, so approve the vault).
    ///         Pays accrued interest first, then principal. `amount` above what is owed is capped
    ///         (pass type(uint256).max to repay in full). On full repayment the loan is Repaid and its
    ///         collateral moves to the borrower's free balance in the CollateralManager. Allowed while paused.
    /// @return paid the amount actually pulled.
    function repay(uint256 loanId, uint256 amount) external returns (uint256 paid);
    /// @dev LIQUIDATOR_ROLE (LiquidationEngine). Accrues, writes off principal in the vault, seizes collateral:
    ///      lenderCollateral to the lender, the rest to the borrower. Marks the loan Liquidated.
    function settleLiquidation(uint256 loanId, uint256 lenderCollateral) external;

    function getLoan(uint256 loanId) external view returns (LXTypes.Loan memory);
    /// @notice Loans [start, start+count) by id, clamped to existing ids. Ids start at 1.
    function getLoans(uint256 start, uint256 count) external view returns (LXTypes.Loan[] memory);
    function loanCount() external view returns (uint256);
    /// @return principal outstanding principal, interest total unpaid interest as of now, total sum of both.
    function owed(uint256 loanId) external view returns (uint256 principal, uint256 interest, uint256 total);
    /// @notice owed() evaluated at an arbitrary future timestamp `at` (>= lastAccrual).
    function owedAt(uint256 loanId, uint256 at) external view returns (uint256 principal, uint256 interest, uint256 total);
}

// ---------------------------------------------------------------------------------------------
// LoanMarketplace: listings and on-chain match validation
// ---------------------------------------------------------------------------------------------

interface ILoanMarketplace {
    event OfferCreated(
        uint256 indexed offerId,
        address indexed lender,
        address indexed asset,
        uint256 amount,
        uint16 aprBps,
        uint32 maxDuration,
        uint16 minCrBps,
        uint64 expiry
    );
    event OfferCancelled(uint256 indexed offerId, address indexed lender, uint256 released);
    event RequestCreated(
        uint256 indexed requestId,
        address indexed borrower,
        address indexed asset,
        uint256 amount,
        uint16 maxAprBps,
        uint32 duration,
        uint256 collateral,
        uint64 expiry
    );
    event RequestCancelled(uint256 indexed requestId, address indexed borrower, uint256 collateralReleased);
    /// @notice One per loan opened through the marketplace. offerId/requestId are 0 when not involved.
    event Matched(
        uint256 indexed loanId,
        uint256 indexed offerId,
        uint256 indexed requestId,
        address lender,
        address borrower,
        uint256 amount,
        uint16 aprBps,
        uint256 collateral,
        address executor
    );

    error AssetNotEnabled(address asset);
    error InvalidAmount();
    error InvalidApr();
    error InvalidDuration();
    error InvalidExpiry();
    error InvalidCollateralRatio();
    error OfferNotOpen(uint256 offerId);
    error RequestNotOpen(uint256 requestId);
    error OfferExpired(uint256 offerId);
    error RequestExpired(uint256 requestId);
    error NotOfferOwner();
    error NotRequestOwner();
    error NotParty();
    error SelfMatch();
    error AssetMismatch();
    error AprTooHigh(uint16 offerAprBps, uint16 maxAprBps);
    error DurationTooLong(uint32 duration, uint32 maxDuration);
    error InsufficientCollateral(uint256 crBps, uint256 requiredCrBps);
    error CollateralCapExceeded(uint256 collateral, uint256 cap);
    error FillTooSmall(uint256 amount, uint256 minLoan);

    // --- lender ---
    /// @notice Reserve `amount` of the caller's AVAILABLE vault balance into a new offer.
    ///  Checks: asset enabled; minLoan <= amount <= maxLoan; config APR bounds; config min <= maxDuration <= config max;
    ///  minCrBps >= config.minInitialCrBps (pass 0 to use the config minimum; stored as the config minimum);
    ///  now < expiry <= now + maxListingLifetime. Blocked while paused.
    function createOffer(
        address asset,
        uint256 amount,
        uint16 aprBps,
        uint32 maxDuration,
        uint16 minCrBps,
        uint64 expiry
    ) external returns (uint256 offerId);
    /// @notice Releases `remaining` back to available. Works for expired offers and while paused. Owner only.
    function cancelOffer(uint256 offerId) external;

    // --- borrower ---
    /// @notice msg.value (may be 0) is first credited to the caller's free collateral, then `collateral` is locked
    ///  from free collateral into the request. Checks: asset enabled; minLoan <= amount <= maxLoan; APR bounds;
    ///  config duration bounds; expiry bounds; 0 < collateral <= maxCollateralPerLoan;
    ///  CR(collateral, amount) >= config.minInitialCrBps at the current FRESH oracle price. Blocked while paused.
    function createRequest(
        address asset,
        uint256 amount,
        uint16 maxAprBps,
        uint32 duration,
        uint256 collateral,
        uint64 expiry
    ) external payable returns (uint256 requestId);
    /// @notice Unlocks collateralRemaining back to the borrower's free collateral. Works for expired requests and while paused.
    function cancelRequest(uint256 requestId) external;

    // --- matching (all validate on-chain; all blocked while paused; all need a fresh oracle price) ---
    /// @notice Fill `amount` of request `requestId` from offer `offerId`. Caller must be the offer's lender or
    ///  the request's borrower. Loan APR = offer.aprBps (must be <= request.maxAprBps). Loan duration =
    ///  request.duration (must be <= offer.maxDuration). Collateral share = request.collateralRemaining if this
    ///  fill completes the request, else floor(request.collateral * amount / request.amount).
    ///  CR(share, amount) must be >= max(offer.minCrBps, config.minInitialCrBps).
    ///  amount >= minLoan unless it equals the request's unfilled remainder. Lender != borrower.
    function matchOfferAndRequest(uint256 offerId, uint256 requestId, uint256 amount) external returns (uint256 loanId);
    /// @notice Lender fills `amount` of a request directly from their AVAILABLE vault balance at a lender-chosen
    ///  APR with config.minAprBps <= aprBps <= request.maxAprBps (changed 2026-11-12 after audit: was fixed at maxAprBps).
    ///  Same collateral-share and size rules as matchOfferAndRequest (CR >= config.minInitialCrBps).
    function fundRequest(uint256 requestId, uint256 amount, uint16 aprBps) external returns (uint256 loanId);
    /// @notice Borrower takes `amount` from an offer in one transaction. msg.value is credited to free collateral,
    ///  then `collateral` is locked from free collateral into the loan. Loan APR = offer.aprBps.
    ///  config.minDuration <= duration <= offer.maxDuration. CR >= max(offer.minCrBps, config.minInitialCrBps).
    ///  collateral <= maxCollateralPerLoan. amount >= minLoan unless it equals offer.remaining.
    function borrowFromOffer(uint256 offerId, uint256 amount, uint32 duration, uint256 collateral)
        external
        payable
        returns (uint256 loanId);

    // --- views ---
    function getOffer(uint256 offerId) external view returns (LXTypes.Offer memory);
    function getRequest(uint256 requestId) external view returns (LXTypes.Request memory);
    /// @notice [start, start+count) by id, clamped. Ids start at 1.
    function getOffers(uint256 start, uint256 count) external view returns (LXTypes.Offer[] memory);
    function getRequests(uint256 start, uint256 count) external view returns (LXTypes.Request[] memory);
    function offerCount() external view returns (uint256);
    function requestCount() external view returns (uint256);
    /// @notice Collateral ratio in bps for `collateral` BTC backing `amount` of `asset` at the current price.
    ///  Reverts if the price is stale/invalid. Returns type(uint256).max when amount == 0.
    function quoteCollateralRatio(address asset, uint256 amount, uint256 collateral) external view returns (uint256 crBps);
    /// @notice Max borrowable amount of `asset` for `collateral` BTC at `crBps` (0 => config.minInitialCrBps).
    function maxBorrow(address asset, uint256 collateral, uint16 crBps) external view returns (uint256 amount);
    /// @notice Minimum BTC collateral for `amount` of `asset` at `crBps` (0 => config.minInitialCrBps), rounded up.
    function minCollateral(address asset, uint256 amount, uint16 crBps) external view returns (uint256 collateral);
}

// ---------------------------------------------------------------------------------------------
// LiquidationEngine
// ---------------------------------------------------------------------------------------------

/// Liquidation model (no on-chain BTC/MUSD market is assumed): the lender is compensated in BTC.
///   debtUsd   = (outstandingPrincipal + unpaid interest) * 10**(18 - assetDecimals)
///   debtBtc   = ceil(debtUsd * 1e18 / price)
///   lenderCollateral = min(loan.collateral, debtBtc * (BPS + liquidationBonusBps) / BPS)
///   borrowerCollateral = loan.collateral - lenderCollateral
/// Eligible when: CR(collateral, debt) < liquidationCrBps (Undercollateralized) or now > maturity + gracePeriod (Overdue).
/// Requires a fresh oracle price for both reasons. Only the loan's lender or KEEPER_ROLE may call liquidate.
interface ILiquidationEngine {
    event Liquidated(
        uint256 indexed loanId,
        address indexed caller,
        LXTypes.LiquidationReason reason,
        uint256 debt,
        uint256 price,
        uint256 lenderCollateral,
        uint256 borrowerCollateral
    );

    error NotLiquidatable(uint256 loanId);
    error NotAuthorized();

    /// @return crBps current CR (type(uint256).max if no debt), reason why liquidatable (None if not), priceOk false if oracle stale.
    function health(uint256 loanId) external view returns (uint256 crBps, LXTypes.LiquidationReason reason, bool priceOk);
    /// @notice Preview of the split if liquidated now. Reverts if price invalid.
    function previewLiquidation(uint256 loanId) external view returns (uint256 debt, uint256 lenderCollateral, uint256 borrowerCollateral);
    function liquidate(uint256 loanId) external;
}
