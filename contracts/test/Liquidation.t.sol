// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";
import {ILiquidationEngine, ILoanManager, IPriceOracleAdapter} from "../src/interfaces/ILiquidityX.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";

contract LiquidationTest is BaseTest {
    address internal M;

    function setUp() public override {
        super.setUp();
        M = address(musd);
    }

    function _open(address asset, uint256 amount, uint16 apr, uint32 dur, uint256 coll) internal returns (uint256 lid) {
        _deposit(lender, asset, amount);
        uint256 oid = _offer(lender, asset, amount, apr);
        uint256 rid = _request(borrower, asset, amount, apr, dur, coll);
        vm.prank(lender);
        lid = market.matchOfferAndRequest(oid, rid, amount);
    }

    /// Reference split (independent of the contract code).
    function _refSplit(uint256 debtUsd, uint256 coll, uint256 price, uint256 bonus)
        internal
        pure
        returns (uint256 lenderC, uint256 borrowerC)
    {
        uint256 debtBtc = _ceilDiv(debtUsd * WAD, price);
        uint256 wb = debtBtc * (BPS + bonus) / BPS;
        lenderC = wb < coll ? wb : coll;
        borrowerC = coll - lenderC;
    }

    function test_health_healthy() public {
        uint256 lid = _open(M, 1_000e18, 500, 30 days, _coll(1_000e18, 20_000));
        (uint256 cr, LXTypes.LiquidationReason r, bool ok) = engine.health(lid);
        assertEq(cr, 20_000);
        assertEq(uint8(r), uint8(LXTypes.LiquidationReason.None));
        assertTrue(ok);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.NotLiquidatable.selector, lid));
        engine.liquidate(lid);
    }

    function test_liquidate_undercollateralized_split() public {
        uint256 coll = _coll(1_000e18, 20_000); // 0.02 BTC
        uint256 lid = _open(M, 1_000e18, 500, 30 days, coll);
        vm.warp(block.timestamp + 5 days);
        _setPrice(59_000e18); // CR ~118% < 120%
        (,, uint256 debt) = loans.owed(lid);
        (uint256 cr, LXTypes.LiquidationReason r, bool ok) = engine.health(lid);
        assertTrue(ok);
        assertEq(uint8(r), uint8(LXTypes.LiquidationReason.Undercollateralized));
        assertEq(cr, (coll * 59_000e18 / WAD) * BPS / debt);

        (uint256 expL, uint256 expB) = _refSplit(debt, coll, 59_000e18, 500);
        (uint256 pDebt, uint256 pL, uint256 pB) = engine.previewLiquidation(lid);
        assertEq(pDebt, debt);
        assertEq(pL, expL);
        assertEq(pB, expB);
        assertGt(expB, 0);

        vm.expectEmit(true, true, false, true, address(engine));
        emit ILiquidationEngine.Liquidated(
            lid, lender, LXTypes.LiquidationReason.Undercollateralized, debt, 59_000e18, expL, expB
        );
        vm.prank(lender);
        engine.liquidate(lid);

        LXTypes.Loan memory l = _loan(lid);
        assertEq(uint8(l.status), uint8(LXTypes.LoanStatus.Liquidated));
        assertEq(l.outstandingPrincipal, 0);
        assertEq(l.closedAt, block.timestamp);
        assertEq(cm.loanCollateral(lid), 0);
        assertEq(cm.freeCollateral(lender), expL);
        assertEq(cm.freeCollateral(borrower), expB);
        assertEq(vault.lent(lender, M), 0);
        assertEq(vault.totalLent(M), 0);

        // Lender and borrower withdraw their BTC.
        vm.prank(lender);
        cm.withdrawCollateral(expL);
        vm.prank(borrower);
        cm.withdrawCollateral(expB);
        assertEq(address(cm).balance, 0);
    }

    function test_liquidate_overdue_by_keeper() public {
        uint256 coll = _coll(1_000e18, 30_000);
        uint256 lid = _open(M, 1_000e18, 500, 1 days, coll);
        uint256 start = block.timestamp;
        vm.warp(start + 1 days + 1 days); // exactly maturity + grace: NOT yet overdue
        _setPrice(PRICE);
        (, LXTypes.LiquidationReason r,) = engine.health(lid);
        assertEq(uint8(r), uint8(LXTypes.LiquidationReason.None));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.NotLiquidatable.selector, lid));
        engine.liquidate(lid);

        vm.warp(start + 2 days + 1);
        _setPrice(PRICE);
        (, r,) = engine.health(lid);
        assertEq(uint8(r), uint8(LXTypes.LiquidationReason.Overdue));
        (,, uint256 debt) = loans.owed(lid);
        (uint256 expL, uint256 expB) = _refSplit(debt, coll, uint256(PRICE), 500);
        vm.expectEmit(true, true, false, true, address(engine));
        emit ILiquidationEngine.Liquidated(lid, keeper, LXTypes.LiquidationReason.Overdue, debt, uint256(PRICE), expL, expB);
        vm.prank(keeper);
        engine.liquidate(lid);
        assertEq(cm.freeCollateral(lender), expL);
        assertEq(cm.freeCollateral(borrower), expB);
        // Debt + 5% bonus
        assertEq(expL, _ceilDiv(debt * WAD, uint256(PRICE)) * 10_500 / 10_000);
    }

    function test_liquidate_bonus_capped_at_collateral() public {
        uint256 coll = _coll(1_000e18, 20_000);
        uint256 lid = _open(M, 1_000e18, 500, 30 days, coll);
        _setPrice(40_000e18); // collateral worth $800 < debt
        (uint256 debt, uint256 pL, uint256 pB) = engine.previewLiquidation(lid);
        assertEq(debt, 1_000e18);
        assertEq(pL, coll);
        assertEq(pB, 0);
        vm.prank(lender);
        engine.liquidate(lid);
        assertEq(cm.freeCollateral(lender), coll);
        assertEq(cm.freeCollateral(borrower), 0);
    }

    function test_unauthorized_liquidator() public {
        uint256 lid = _open(M, 1_000e18, 500, 30 days, _coll(1_000e18, 20_000));
        _setPrice(50_000e18);
        vm.prank(stranger);
        vm.expectRevert(ILiquidationEngine.NotAuthorized.selector);
        engine.liquidate(lid);
        vm.prank(borrower);
        vm.expectRevert(ILiquidationEngine.NotAuthorized.selector);
        engine.liquidate(lid);
    }

    function test_stale_price_blocks_liquidation() public {
        uint256 lid = _open(M, 1_000e18, 500, 1 days, _coll(1_000e18, 20_000));
        uint256 t = block.timestamp;
        vm.warp(t + 3 days); // overdue but stale
        (uint256 cr, LXTypes.LiquidationReason r, bool ok) = engine.health(lid);
        assertFalse(ok);
        assertEq(cr, 0);
        assertEq(uint8(r), uint8(LXTypes.LiquidationReason.Overdue));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracleAdapter.StalePrice.selector, t, 3600));
        engine.liquidate(lid);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracleAdapter.StalePrice.selector, t, 3600));
        engine.previewLiquidation(lid);
        // Repayment still works with a stale oracle.
        vm.prank(borrower);
        loans.repay(lid, type(uint256).max);
    }

    function test_double_liquidation_and_closed_loans() public {
        uint256 lid = _open(M, 1_000e18, 500, 30 days, _coll(1_000e18, 20_000));
        _setPrice(50_000e18);
        vm.prank(lender);
        engine.liquidate(lid);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.NotLiquidatable.selector, lid));
        engine.liquidate(lid);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ILoanManager.LoanNotActive.selector, lid));
        loans.repay(lid, 1);
        vm.prank(address(engine));
        vm.expectRevert(abi.encodeWithSelector(ILoanManager.LoanNotActive.selector, lid));
        loans.settleLiquidation(lid, 0);
        (uint256 cr, LXTypes.LiquidationReason r,) = engine.health(lid);
        assertEq(cr, type(uint256).max);
        assertEq(uint8(r), uint8(LXTypes.LiquidationReason.None));
    }

    function test_repaid_loan_not_liquidatable() public {
        uint256 lid = _open(M, 1_000e18, 500, 30 days, _coll(1_000e18, 20_000));
        vm.prank(borrower);
        loans.repay(lid, type(uint256).max);
        _setPrice(1e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILiquidationEngine.NotLiquidatable.selector, lid));
        engine.liquidate(lid);
    }

    function test_liquidation_includes_interest_in_debt() public {
        uint256 coll = _coll(1_000e18, 20_000);
        _deposit(lender, M, 1_000e18);
        uint256 oid = _offerFull(lender, M, 1_000e18, 10_000, 365 days, 0, uint64(block.timestamp + 1 days));
        uint256 rid = _request(borrower, M, 1_000e18, 10_000, 365 days, coll); // 100% APR
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, 1_000e18);
        vm.warp(block.timestamp + 73 days); // +20% interest => debt 1,200
        _setPrice(PRICE);
        // CR = 2000/1200 = 166%: healthy. Drop price so that principal-only CR is ok but debt CR < 120%.
        _setPrice(70_000e18); // coll $1,400 / 1,200 = 116.6%; principal-only = 140%
        (, LXTypes.LiquidationReason r,) = engine.health(lid);
        assertEq(uint8(r), uint8(LXTypes.LiquidationReason.Undercollateralized));
        vm.prank(lender);
        engine.liquidate(lid);
    }

    function test_liquidation_6_decimals() public {
        address U = address(usdc);
        uint256 coll = _coll(1_000e18, 20_000);
        uint256 lid = _open(U, 1_000e6, 500, 30 days, coll);
        _setPrice(55_000e18);
        (uint256 debt, uint256 pL, uint256 pB) = engine.previewLiquidation(lid);
        assertEq(debt, 1_000e6);
        (uint256 eL, uint256 eB) = _refSplit(1_000e18, coll, 55_000e18, 500);
        assertEq(pL, eL);
        assertEq(pB, eB);
        vm.prank(lender);
        engine.liquidate(lid);
        assertEq(vault.lent(lender, U), 0);
    }

    function test_liquidation_works_while_paused() public {
        uint256 lid = _open(M, 1_000e18, 500, 30 days, _coll(1_000e18, 20_000));
        vm.prank(admin);
        config.pause();
        _setPrice(50_000e18);
        vm.prank(lender);
        engine.liquidate(lid);
    }

    function test_keeper_role_admin_only() public {
        bytes32 k = engine.KEEPER_ROLE();
        assertEq(k, keccak256("KEEPER_ROLE"));
        vm.prank(stranger);
        vm.expectRevert();
        engine.grantRole(k, stranger);
    }

    function test_constructor_zero() public {
        vm.expectRevert(LiquidationEngine.ZeroAddress.selector);
        new LiquidationEngine(config, oracle, loans, address(0));
    }
}
