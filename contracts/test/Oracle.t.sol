// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {PriceOracleAdapter} from "../src/PriceOracleAdapter.sol";
import {IPriceOracleAdapter} from "../src/interfaces/ILiquidityX.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract OracleTest is BaseTest {
    function test_getPrice_18dec() public view {
        (uint256 p, uint256 t) = oracle.getPrice();
        assertEq(p, uint256(PRICE));
        assertEq(t, block.timestamp);
        assertEq(oracle.feedDecimals(), 18);
        assertEq(oracle.maxStaleness(), 3600);
        assertEq(oracle.feed(), address(feed));
    }

    function test_scales_8_decimals() public {
        MockAggregator f8 = new MockAggregator(8, 65_000e8);
        PriceOracleAdapter o = new PriceOracleAdapter(address(f8), 3600, admin);
        (uint256 p,) = o.getPrice();
        assertEq(p, 65_000e18);
    }

    function test_scales_24_decimals_down() public {
        MockAggregator f = new MockAggregator(24, 65_000e24);
        PriceOracleAdapter o = new PriceOracleAdapter(address(f), 3600, admin);
        (uint256 p,) = o.getPrice();
        assertEq(p, 65_000e18);
    }

    function test_rejects_zero_and_negative() public {
        feed.setAnswer(0);
        vm.expectRevert(IPriceOracleAdapter.InvalidPrice.selector);
        oracle.getPrice();
        (bool ok,,) = oracle.tryGetPrice();
        assertFalse(ok);
        feed.setAnswer(-1);
        vm.expectRevert(IPriceOracleAdapter.InvalidPrice.selector);
        oracle.getPrice();
        (ok,,) = oracle.tryGetPrice();
        assertFalse(ok);
    }

    function test_stale() public {
        uint256 t = block.timestamp;
        vm.warp(t + 3600);
        oracle.getPrice(); // exactly at the bound: fresh
        vm.warp(t + 3601);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracleAdapter.StalePrice.selector, t, 3600));
        oracle.getPrice();
        (bool ok, uint256 p, uint256 upd) = oracle.tryGetPrice();
        assertFalse(ok);
        assertEq(p, uint256(PRICE));
        assertEq(upd, t);
    }

    function test_future_updatedAt_is_fresh() public {
        feed.setAnswerAndTime(PRICE, block.timestamp + 60); // small clock skew
        (uint256 p,) = oracle.getPrice();
        assertEq(p, uint256(PRICE));
        (bool ok,,) = oracle.tryGetPrice();
        assertTrue(ok);
    }

    function test_far_future_updatedAt_is_stale() public {
        feed.setAnswerAndTime(PRICE, block.timestamp + 1 days); // beyond MAX_FUTURE_SKEW (audit 2026-11-12)
        vm.expectRevert();
        oracle.getPrice();
        (bool ok,,) = oracle.tryGetPrice();
        assertFalse(ok);
    }

    function test_answeredInRound_zero_accepted() public view {
        // MockAggregator always returns answeredInRound = 0 (as Mezo does).
        (bool ok,,) = oracle.tryGetPrice();
        assertTrue(ok);
    }

    function test_feed_revert() public {
        feed.setReverts(true);
        vm.expectRevert(IPriceOracleAdapter.InvalidPrice.selector);
        oracle.getPrice();
        (bool ok, uint256 p,) = oracle.tryGetPrice();
        assertFalse(ok);
        assertEq(p, 0);
    }

    function test_tryGetPrice_never_reverts_on_codeless_feed() public {
        // Force the stored feed to an EOA via storage write (setFeed would refuse it).
        PriceOracleAdapter o = new PriceOracleAdapter(address(feed), 3600, admin);
        vm.etch(address(feed), "");
        (bool ok,,) = o.tryGetPrice();
        assertFalse(ok);
    }

    function test_setFeed() public {
        MockAggregator f8 = new MockAggregator(8, 50_000e8);
        vm.prank(admin);
        oracle.setFeed(address(f8));
        assertEq(oracle.feedDecimals(), 8);
        (uint256 p,) = oracle.getPrice();
        assertEq(p, 50_000e18);
    }

    function test_setFeed_invalid() public {
        vm.startPrank(admin);
        vm.expectRevert(IPriceOracleAdapter.InvalidFeed.selector);
        oracle.setFeed(address(0));
        vm.expectRevert(IPriceOracleAdapter.InvalidFeed.selector);
        oracle.setFeed(makeAddr("eoa"));
        MockAggregator f = new MockAggregator(37, 1);
        vm.expectRevert(IPriceOracleAdapter.InvalidFeed.selector);
        oracle.setFeed(address(f));
        vm.stopPrank();
    }

    function test_setMaxStaleness_bounds() public {
        vm.startPrank(admin);
        oracle.setMaxStaleness(30);
        oracle.setMaxStaleness(1 days);
        vm.expectRevert(abi.encodeWithSelector(PriceOracleAdapter.InvalidMaxStaleness.selector, 29));
        oracle.setMaxStaleness(29);
        vm.expectRevert(abi.encodeWithSelector(PriceOracleAdapter.InvalidMaxStaleness.selector, 1 days + 1));
        oracle.setMaxStaleness(1 days + 1);
        vm.stopPrank();
    }

    function test_admin_only() public {
        bytes32 r = oracle.DEFAULT_ADMIN_ROLE();
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, r));
        oracle.setFeed(address(feed));
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, r));
        oracle.setMaxStaleness(100);
        vm.stopPrank();
    }

    function test_constructor_rejects_zero_admin() public {
        vm.expectRevert(PriceOracleAdapter.ZeroAddress.selector);
        new PriceOracleAdapter(address(feed), 3600, address(0));
    }
}
