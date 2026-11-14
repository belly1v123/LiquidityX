// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceOracleAdapter} from "../src/PriceOracleAdapter.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {LiquidityXVault} from "../src/LiquidityXVault.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {LoanManager} from "../src/LoanManager.sol";
import {LoanMarketplace} from "../src/LoanMarketplace.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

/// @notice Shared fixture: full protocol wired exactly like script/Deploy.s.sol, with mocks.
abstract contract BaseTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    int256 internal constant PRICE = 100_000e18; // $100,000 / BTC, 18 decimals

    address internal admin = makeAddr("admin");
    address internal lender = makeAddr("lender");
    address internal lender2 = makeAddr("lender2");
    address internal lender3 = makeAddr("lender3");
    address internal borrower = makeAddr("borrower");
    address internal borrower2 = makeAddr("borrower2");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    MockAggregator internal feed;
    PriceOracleAdapter internal oracle;
    ProtocolConfig internal config;
    LiquidityXVault internal vault;
    CollateralManager internal cm;
    LoanManager internal loans;
    LoanMarketplace internal market;
    LiquidationEngine internal engine;
    MockERC20 internal musd;
    MockERC20 internal usdc;

    function defaultParams() internal pure returns (LXTypes.RiskParams memory) {
        return LXTypes.RiskParams({
            minInitialCrBps: 15_000,
            liquidationCrBps: 12_000,
            liquidationBonusBps: 500,
            minAprBps: 1,
            maxAprBps: 10_000,
            minDuration: 1 hours,
            maxDuration: 365 days,
            gracePeriod: 1 days,
            maxListingLifetime: 30 days,
            maxCollateralPerLoan: 10 ether
        });
    }

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(18, PRICE);
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        usdc = new MockERC20("Mezo USDC", "mUSDC", 6);

        oracle = new PriceOracleAdapter(address(feed), 3600, admin);
        config = new ProtocolConfig(defaultParams(), admin);
        vault = new LiquidityXVault(config, admin);
        cm = new CollateralManager(config, admin);
        loans = new LoanManager(config, vault, cm, admin);
        market = new LoanMarketplace(config, oracle, vault, cm, loans, admin);
        engine = new LiquidationEngine(config, oracle, loans, admin);

        vm.startPrank(admin);
        vault.grantRole(vault.MARKET_ROLE(), address(market));
        vault.grantRole(vault.LOAN_ROLE(), address(loans));
        cm.grantRole(cm.MARKET_ROLE(), address(market));
        cm.grantRole(cm.LOAN_ROLE(), address(loans));
        loans.grantRole(loans.MARKET_ROLE(), address(market));
        loans.grantRole(loans.LIQUIDATOR_ROLE(), address(engine));
        engine.grantRole(engine.KEEPER_ROLE(), keeper);
        config.configureAsset(address(musd), true, 1e18, 1_000_000e18);
        config.configureAsset(address(usdc), true, 1e6, 1_000_000e6);
        vm.stopPrank();

        address[5] memory users = [lender, lender2, lender3, borrower, borrower2];
        for (uint256 i; i < users.length; ++i) {
            musd.mint(users[i], 10_000_000e18);
            usdc.mint(users[i], 10_000_000e6);
            vm.deal(users[i], 1_000 ether);
            vm.startPrank(users[i]);
            musd.approve(address(vault), type(uint256).max);
            usdc.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ helpers

    function _deposit(address who, address asset, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(asset, amount);
    }

    function _offer(address who, address asset, uint256 amount, uint16 apr) internal returns (uint256) {
        return _offerFull(who, asset, amount, apr, 30 days, 0, uint64(block.timestamp + 7 days));
    }

    function _offerFull(
        address who,
        address asset,
        uint256 amount,
        uint16 apr,
        uint32 maxDur,
        uint16 minCr,
        uint64 expiry
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = market.createOffer(asset, amount, apr, maxDur, minCr, expiry);
    }

    function _depositAndOffer(address who, uint256 amount, uint16 apr) internal returns (uint256) {
        _deposit(who, address(musd), amount);
        return _offer(who, address(musd), amount, apr);
    }

    /// @dev Request with collateral sent as msg.value.
    function _request(address who, address asset, uint256 amount, uint16 maxApr, uint32 duration, uint256 coll)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = market.createRequest{value: coll}(asset, amount, maxApr, duration, coll, uint64(block.timestamp + 7 days));
    }

    /// @dev Collateral for `amount` MUSD at `crBps` at the mock price.
    function _coll(uint256 amount18, uint256 crBps) internal pure returns (uint256) {
        uint256 num = amount18 * crBps * WAD;
        return (num - 1) / (BPS * uint256(PRICE)) + 1;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Reference interest formula (independent re-implementation of the spec).
    function _refInterest(uint256 principal, uint256 apr, uint256 dt) internal pure returns (uint256) {
        return _ceilDiv(principal * apr * dt, YEAR * BPS);
    }

    function _setPrice(int256 p) internal {
        feed.setAnswer(p);
    }

    function _loan(uint256 id) internal view returns (LXTypes.Loan memory) {
        return loans.getLoan(id);
    }
}
