// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LiquidityXVault} from "../../src/LiquidityXVault.sol";
import {CollateralManager} from "../../src/CollateralManager.sol";
import {LoanManager} from "../../src/LoanManager.sol";
import {LoanMarketplace} from "../../src/LoanMarketplace.sol";
import {LiquidationEngine} from "../../src/LiquidationEngine.sol";
import {LXTypes} from "../../src/interfaces/ILiquidityXTypes.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Drives random sequences of every user-facing action. Calls that would revert are either
///  bounded away or wrapped in try/catch so the fuzzer explores deep state.
contract Handler is Test {
    LiquidityXVault public vault;
    CollateralManager public cm;
    LoanManager public loans;
    LoanMarketplace public market;
    LiquidationEngine public engine;
    MockAggregator public feed;
    MockERC20[2] public assets;

    address[3] public lenders;
    address[3] public borrowers;

    mapping(bytes32 => uint256) public calls;
    uint256 public successfulMatches;
    uint256 public successfulRepays;
    uint256 public successfulLiquidations;

    constructor(
        LiquidityXVault v,
        CollateralManager c,
        LoanManager l,
        LoanMarketplace m,
        LiquidationEngine e,
        MockAggregator f,
        MockERC20 a0,
        MockERC20 a1
    ) {
        vault = v;
        cm = c;
        loans = l;
        market = m;
        engine = e;
        feed = f;
        assets[0] = a0;
        assets[1] = a1;
        for (uint256 i; i < 3; ++i) {
            lenders[i] = makeAddr(string.concat("invLender", vm.toString(i)));
            borrowers[i] = makeAddr(string.concat("invBorrower", vm.toString(i)));
            address[2] memory who = [lenders[i], borrowers[i]];
            for (uint256 j; j < 2; ++j) {
                vm.deal(who[j], 10_000 ether);
                a0.mint(who[j], 1e30);
                a1.mint(who[j], 1e18);
                vm.startPrank(who[j]);
                a0.approve(address(v), type(uint256).max);
                a1.approve(address(v), type(uint256).max);
                vm.stopPrank();
            }
        }
    }

    function _asset(uint256 seed) internal view returns (MockERC20) {
        return assets[seed % 2];
    }

    function _unit(MockERC20 a) internal view returns (uint256) {
        return 10 ** a.decimals();
    }

    // ------------------------------------------------------------------ lender actions

    function deposit(uint256 who, uint256 assetSeed, uint256 amount) external {
        calls["deposit"]++;
        MockERC20 a = _asset(assetSeed);
        amount = bound(amount, 1, 50_000 * _unit(a));
        vm.prank(lenders[who % 3]);
        vault.deposit(address(a), amount);
    }

    function withdraw(uint256 who, uint256 assetSeed, uint256 amount) external {
        calls["withdraw"]++;
        address l = lenders[who % 3];
        MockERC20 a = _asset(assetSeed);
        uint256 avail = vault.available(l, address(a));
        if (avail == 0) return;
        amount = bound(amount, 1, avail);
        vm.prank(l);
        vault.withdraw(address(a), amount);
    }

    function createOffer(uint256 who, uint256 assetSeed, uint256 amount, uint256 apr, uint256 minCr) external {
        calls["createOffer"]++;
        address l = lenders[who % 3];
        MockERC20 a = _asset(assetSeed);
        uint256 avail = vault.available(l, address(a));
        if (avail < _unit(a)) return;
        amount = bound(amount, _unit(a), avail < 1_000_000 * _unit(a) ? avail : 1_000_000 * _unit(a));
        apr = bound(apr, 1, 10_000);
        minCr = minCr % 3 == 0 ? 0 : bound(minCr, 15_000, 30_000);
        vm.prank(l);
        market.createOffer(address(a), amount, uint16(apr), 30 days, uint16(minCr), uint64(block.timestamp + 10 days));
    }

    function cancelOffer(uint256 idSeed) external {
        calls["cancelOffer"]++;
        uint256 n = market.offerCount();
        if (n == 0) return;
        LXTypes.Offer memory o = market.getOffer(idSeed % n + 1);
        if (o.status != LXTypes.OfferStatus.Open) return;
        vm.prank(o.lender);
        market.cancelOffer(o.id);
    }

    function fundRequest(uint256 who, uint256 reqSeed, uint256 amount) external {
        calls["fundRequest"]++;
        uint256 n = market.requestCount();
        if (n == 0) return;
        LXTypes.Request memory r = market.getRequest(reqSeed % n + 1);
        if (r.status != LXTypes.RequestStatus.Open) return;
        address l = lenders[who % 3];
        uint256 unfilled = r.amount - r.filled;
        amount = bound(amount, 1, unfilled);
        uint256 avail = vault.available(l, r.asset);
        if (avail < amount) return;
        vm.prank(l);
        try market.fundRequest(r.id, amount, 1) {
            successfulMatches++;
        } catch {}
    }

    // ------------------------------------------------------------------ borrower actions

    function createRequest(uint256 who, uint256 assetSeed, uint256 amount, uint256 crBps, uint256 apr, uint256 extra)
        external
    {
        calls["createRequest"]++;
        MockERC20 a = _asset(assetSeed);
        amount = bound(amount, _unit(a), 200_000 * _unit(a));
        crBps = bound(crBps, 15_000, 40_000);
        apr = bound(apr, 1, 10_000);
        (uint256 price,) = market.oracle().getPrice();
        uint256 usd = amount * 10 ** (18 - a.decimals());
        uint256 coll = (usd * crBps * 1e18 - 1) / (10_000 * price) + 1;
        if (coll > 10 ether) return;
        extra = bound(extra, 0, 1 ether);
        vm.prank(borrowers[who % 3]);
        market.createRequest{value: coll + extra}(address(a), amount, uint16(apr), 7 days, coll, uint64(block.timestamp + 10 days));
    }

    function cancelRequest(uint256 idSeed) external {
        calls["cancelRequest"]++;
        uint256 n = market.requestCount();
        if (n == 0) return;
        LXTypes.Request memory r = market.getRequest(idSeed % n + 1);
        if (r.status != LXTypes.RequestStatus.Open) return;
        vm.prank(r.borrower);
        market.cancelRequest(r.id);
    }

    function borrowFromOffer(uint256 who, uint256 offerSeed, uint256 amount, uint256 crBps) external {
        calls["borrowFromOffer"]++;
        uint256 n = market.offerCount();
        if (n == 0) return;
        LXTypes.Offer memory o = market.getOffer(offerSeed % n + 1);
        if (o.status != LXTypes.OfferStatus.Open || block.timestamp >= o.expiry) return;
        address b = borrowers[who % 3];
        if (b == o.lender) return;
        amount = bound(amount, 1, o.remaining);
        crBps = bound(crBps, o.minCrBps, 40_000);
        uint256 coll = market.minCollateral(o.asset, amount, uint16(crBps));
        if (coll == 0 || coll > 10 ether) return;
        vm.prank(b);
        try market.borrowFromOffer{value: coll}(o.id, amount, 1 days, coll) {
            successfulMatches++;
        } catch {}
    }

    function matchOfferAndRequest(uint256 offerSeed, uint256 reqSeed, uint256 amount, bool byLender) external {
        calls["match"]++;
        uint256 no = market.offerCount();
        uint256 nr = market.requestCount();
        if (no == 0 || nr == 0) return;
        LXTypes.Offer memory o = market.getOffer(offerSeed % no + 1);
        LXTypes.Request memory r = market.getRequest(reqSeed % nr + 1);
        if (o.status != LXTypes.OfferStatus.Open || r.status != LXTypes.RequestStatus.Open) return;
        uint256 unfilled = r.amount - r.filled;
        uint256 cap = unfilled < o.remaining ? unfilled : o.remaining;
        amount = bound(amount, 1, cap);
        vm.prank(byLender ? o.lender : r.borrower);
        try market.matchOfferAndRequest(o.id, r.id, amount) {
            successfulMatches++;
        } catch {}
    }

    function repay(uint256 loanSeed, uint256 amount, bool full) external {
        calls["repay"]++;
        uint256 n = loans.loanCount();
        if (n == 0) return;
        LXTypes.Loan memory l = loans.getLoan(loanSeed % n + 1);
        if (l.status != LXTypes.LoanStatus.Active) return;
        (,, uint256 total) = loans.owed(l.id);
        amount = full ? type(uint256).max : bound(amount, 1, total);
        MockERC20 a = MockERC20(l.asset);
        a.mint(l.borrower, total); // make sure the borrower can pay interest
        vm.prank(l.borrower);
        loans.repay(l.id, amount);
        successfulRepays++;
    }

    function liquidate(uint256 loanSeed) external {
        calls["liquidate"]++;
        uint256 n = loans.loanCount();
        if (n == 0) return;
        LXTypes.Loan memory l = loans.getLoan(loanSeed % n + 1);
        if (l.status != LXTypes.LoanStatus.Active) return;
        (, LXTypes.LiquidationReason reason, bool ok) = engine.health(l.id);
        if (!ok || reason == LXTypes.LiquidationReason.None) return;
        vm.prank(l.lender);
        engine.liquidate(l.id);
        successfulLiquidations++;
    }

    function withdrawCollateral(uint256 who, uint256 amount, bool isLender) external {
        calls["withdrawCollateral"]++;
        address a = isLender ? lenders[who % 3] : borrowers[who % 3];
        uint256 free = cm.freeCollateral(a);
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(a);
        cm.withdrawCollateral(amount);
    }

    // ------------------------------------------------------------------ environment

    function movePrice(uint256 price) external {
        calls["movePrice"]++;
        price = bound(price, 30_000e18, 200_000e18);
        feed.setAnswer(int256(price));
    }

    function warp(uint256 dt) external {
        calls["warp"]++;
        dt = bound(dt, 1, 5 days);
        vm.warp(block.timestamp + dt);
    }
}
