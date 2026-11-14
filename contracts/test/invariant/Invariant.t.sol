// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Handler} from "./Handler.sol";
import {LXTypes} from "../../src/interfaces/ILiquidityXTypes.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {console} from "forge-std/console.sol";

/// @notice Stateful invariant suite. The handler performs random deposits, offers, requests, matches,
///  repayments, liquidations, withdrawals, price moves and time jumps; after every call these must hold.
contract InvariantTest is BaseTest {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        feed.setLive(true); // the handler warps time; keep the mock price fresh
        handler = new Handler(vault, cm, loans, market, engine, feed, musd, usdc);
        targetContract(address(handler));
    }

    function _assets() internal view returns (MockERC20[2] memory) {
        return [musd, usdc];
    }

    /// 1. Vault solvency: token balance covers every withdrawable/reserved unit.
    function invariant_vaultBalanceCoversAvailableAndReserved() public view {
        MockERC20[2] memory a = _assets();
        for (uint256 i; i < 2; ++i) {
            assertGe(
                a[i].balanceOf(address(vault)),
                vault.totalAvailable(address(a[i])) + vault.totalReserved(address(a[i])),
                "vault under-collateralised"
            );
        }
    }

    /// 2. CollateralManager balance is exactly the sum of its buckets.
    function invariant_collateralBalanceExact() public view {
        assertEq(address(cm).balance, cm.totalFree() + cm.totalLockedInRequests() + cm.totalLockedInLoans());
    }

    /// 3. Per-lender lent sums to totalLent, and equals outstanding principal of active loans.
    function invariant_lentAccounting() public view {
        MockERC20[2] memory a = _assets();
        for (uint256 k; k < 2; ++k) {
            uint256 sumLent;
            uint256 sumAvail;
            uint256 sumRes;
            for (uint256 i; i < 3; ++i) {
                sumLent += vault.lent(handler.lenders(i), address(a[k]));
                sumAvail += vault.available(handler.lenders(i), address(a[k]));
                sumRes += vault.reserved(handler.lenders(i), address(a[k]));
            }
            assertEq(sumLent, vault.totalLent(address(a[k])), "sum lent");
            assertEq(sumAvail, vault.totalAvailable(address(a[k])), "sum available");
            assertEq(sumRes, vault.totalReserved(address(a[k])), "sum reserved");

            uint256 outstanding;
            uint256 n = loans.loanCount();
            for (uint256 id = 1; id <= n; ++id) {
                LXTypes.Loan memory l = loans.getLoan(id);
                if (l.status == LXTypes.LoanStatus.Active && l.asset == address(a[k])) outstanding += l.outstandingPrincipal;
            }
            assertEq(outstanding, vault.totalLent(address(a[k])), "lent != active principal");
        }
    }

    /// 4. Offers: remaining <= amount; Open offers are fully reserved; Filled => remaining 0.
    function invariant_offers() public view {
        uint256 n = market.offerCount();
        uint256[2] memory openRemaining;
        MockERC20[2] memory a = _assets();
        for (uint256 id = 1; id <= n; ++id) {
            LXTypes.Offer memory o = market.getOffer(id);
            assertLe(o.remaining, o.amount, "offer overfilled");
            if (o.status != LXTypes.OfferStatus.Open) assertEq(o.remaining, 0, "closed offer has remaining");
            else openRemaining[o.asset == address(a[0]) ? 0 : 1] += o.remaining;
        }
        assertEq(openRemaining[0], vault.totalReserved(address(a[0])), "reserved != open offers");
        assertEq(openRemaining[1], vault.totalReserved(address(a[1])), "reserved != open offers");
    }

    /// 5. Requests: filled <= amount; Filled <=> filled == amount; lock matches collateralRemaining.
    function invariant_requests() public view {
        uint256 n = market.requestCount();
        uint256 locked;
        for (uint256 id = 1; id <= n; ++id) {
            LXTypes.Request memory r = market.getRequest(id);
            assertLe(r.filled, r.amount, "request overfilled");
            assertLe(r.collateralRemaining, r.collateral);
            assertEq(cm.requestCollateral(id), r.collateralRemaining, "request lock mismatch");
            if (r.status == LXTypes.RequestStatus.Filled) {
                assertEq(r.filled, r.amount);
                assertEq(r.collateralRemaining, 0);
            }
            if (r.status == LXTypes.RequestStatus.Open) assertLt(r.filled, r.amount);
            if (r.status == LXTypes.RequestStatus.Cancelled) assertEq(r.collateralRemaining, 0);
            locked += r.collateralRemaining;
        }
        assertEq(locked, cm.totalLockedInRequests());
    }

    /// 6. Repaid loans have no outstanding principal or interest. 7. Closed loans hold no collateral;
    /// active loans hold exactly their recorded collateral.
    function invariant_loans() public view {
        uint256 n = loans.loanCount();
        uint256 lockedLoans;
        for (uint256 id = 1; id <= n; ++id) {
            LXTypes.Loan memory l = loans.getLoan(id);
            if (l.status == LXTypes.LoanStatus.Repaid) {
                assertEq(l.outstandingPrincipal, 0, "repaid loan has principal");
                assertEq(l.accruedInterest, 0);
                assertEq(l.principalRepaid, l.principal);
            }
            if (l.status != LXTypes.LoanStatus.Active) {
                assertEq(cm.loanCollateral(id), 0, "closed loan holds collateral");
                assertGt(l.closedAt, 0);
            } else {
                assertEq(cm.loanCollateral(id), l.collateral, "active loan collateral mismatch");
                assertEq(l.principalRepaid + l.outstandingPrincipal, l.principal);
            }
            lockedLoans += cm.loanCollateral(id);
        }
        assertEq(lockedLoans, cm.totalLockedInLoans());
    }

    /// The marketplace never holds BTC or stablecoins.
    function invariant_marketplaceHoldsNothing() public view {
        assertEq(address(market).balance, 0);
        assertEq(address(loans).balance, 0);
        assertEq(musd.balanceOf(address(market)), 0);
        assertEq(musd.balanceOf(address(loans)), 0);
    }

    /// Depth check (not an invariant): drive the handler with pseudo-random seeds and confirm the
    /// action mix actually reaches matches, repayments and liquidations.
    function test_handler_reaches_deep_paths() public {
        for (uint256 i; i < 600; ++i) {
            uint256 r = uint256(keccak256(abi.encode(i, "seed")));
            uint256 op = r % 14;
            uint256 x = r >> 8;
            uint256 y = r >> 72;
            uint256 z = r >> 136;
            if (op == 0) handler.deposit(x, y, z);
            else if (op == 1) handler.withdraw(x, y, z);
            else if (op == 2) handler.createOffer(x, y, z, r >> 200, r);
            else if (op == 3) handler.cancelOffer(x);
            else if (op == 4) handler.fundRequest(x, y, z);
            else if (op == 5) handler.createRequest(x, y, z, r >> 200, r >> 40, r >> 100);
            else if (op == 6) handler.cancelRequest(x);
            else if (op == 7) handler.borrowFromOffer(x, y, z, r >> 200);
            else if (op == 8) handler.matchOfferAndRequest(x, y, z, r & 1 == 1);
            else if (op == 9) handler.repay(x, y, r & 1 == 1);
            else if (op == 10) handler.liquidate(x);
            else if (op == 11) handler.withdrawCollateral(x, y, r & 1 == 1);
            else if (op == 12) handler.movePrice(x);
            else handler.warp(x);
            // invariants hold at every step
            invariant_collateralBalanceExact();
            invariant_vaultBalanceCoversAvailableAndReserved();
        }
        invariant_lentAccounting();
        invariant_offers();
        invariant_requests();
        invariant_loans();
        console.log("matches", handler.successfulMatches());
        console.log("repays", handler.successfulRepays());
        console.log("liquidations", handler.successfulLiquidations());
        assertGt(handler.successfulMatches(), 10);
        assertGt(handler.successfulRepays(), 5);
        assertGt(handler.successfulLiquidations(), 0);
    }
}
