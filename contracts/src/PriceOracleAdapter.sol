// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceOracleAdapter, IAggregatorV3} from "./interfaces/ILiquidityX.sol";

/// @title PriceOracleAdapter
/// @notice Reads a Chainlink-style BTC/USD aggregator and returns the price scaled to 18 decimals.
///  Mezo testnet precompile 0x7b7c…0015 returns answeredInRound = 0, so that field is deliberately NOT checked.
///  Validity rules: answer > 0, and block.timestamp - updatedAt <= maxStaleness. An updatedAt in the future
///  (clock skew between the feed and the block) is treated as fresh.
contract PriceOracleAdapter is IPriceOracleAdapter, AccessControl, ReentrancyGuard {
    uint256 public constant MIN_STALENESS = 30;
    uint256 public constant MAX_STALENESS = 1 days;
    /// @notice A feed timestamp more than this far ahead of the block clock is treated as stale (audit 2026-11-12).
    uint256 public constant MAX_FUTURE_SKEW = 5 minutes;

    /// @dev Not part of the frozen interface: setMaxStaleness / constructor bound violation.
    error InvalidMaxStaleness(uint256 value);
    /// @dev Not part of the frozen interface: zero admin in the constructor.
    error ZeroAddress();

    address public override feed;
    uint8 public override feedDecimals;
    uint256 public override maxStaleness;

    constructor(address feed_, uint256 maxStaleness_, address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setFeed(feed_);
        _setMaxStaleness(maxStaleness_);
    }

    // ------------------------------------------------------------------ reads

    /// @inheritdoc IPriceOracleAdapter
    function getPrice() external view override returns (uint256 price, uint256 updatedAt) {
        (bool callOk, int256 answer, uint256 upd) = _read();
        if (!callOk || answer <= 0) revert InvalidPrice();
        bool scaleOk;
        (scaleOk, price) = _scale(uint256(answer));
        if (!scaleOk || price == 0) revert InvalidPrice();
        if (_isStale(upd)) revert StalePrice(upd, maxStaleness);
        return (price, upd);
    }

    /// @inheritdoc IPriceOracleAdapter
    function tryGetPrice() external view override returns (bool ok, uint256 price, uint256 updatedAt) {
        (bool callOk, int256 answer, uint256 upd) = _read();
        if (!callOk || answer <= 0) return (false, 0, upd);
        (bool scaleOk, uint256 p) = _scale(uint256(answer));
        if (!scaleOk || p == 0) return (false, 0, upd);
        if (_isStale(upd)) return (false, p, upd);
        return (true, p, upd);
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IPriceOracleAdapter
    function setFeed(address newFeed) external override onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        _setFeed(newFeed);
    }

    /// @inheritdoc IPriceOracleAdapter
    function setMaxStaleness(uint256 newMaxStaleness) external override onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        _setMaxStaleness(newMaxStaleness);
    }

    // ------------------------------------------------------------------ internals

    function _setFeed(address newFeed) internal {
        if (newFeed == address(0) || newFeed.code.length == 0) revert InvalidFeed();
        (bool ok, bytes memory data) = newFeed.staticcall(abi.encodeCall(IAggregatorV3.decimals, ()));
        if (!ok || data.length < 32) revert InvalidFeed();
        uint256 d = abi.decode(data, (uint256));
        if (d > 36) revert InvalidFeed();
        feed = newFeed;
        feedDecimals = uint8(d);
        emit FeedUpdated(newFeed, uint8(d));
    }

    function _setMaxStaleness(uint256 v) internal {
        if (v < MIN_STALENESS || v > MAX_STALENESS) revert InvalidMaxStaleness(v);
        maxStaleness = v;
        emit MaxStalenessUpdated(v);
    }

    /// @dev Low-level staticcall so that a reverting feed, a feed without code, or malformed return data
    ///  never bubbles up (tryGetPrice must never revert). Fields are decoded as full words so the
    ///  decoder cannot revert on dirty high bits.
    function _read() internal view returns (bool ok, int256 answer, uint256 updatedAt) {
        (bool success, bytes memory data) = feed.staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (!success || data.length < 160) return (false, 0, 0);
        (, answer,, updatedAt,) = abi.decode(data, (uint256, int256, uint256, uint256, uint256));
        return (true, answer, updatedAt);
    }

    function _scale(uint256 answer) internal view returns (bool ok, uint256 price) {
        uint8 d = feedDecimals;
        if (d == 18) return (true, answer);
        if (d < 18) {
            uint256 factor = 10 ** (18 - d);
            if (answer > type(uint256).max / factor) return (false, 0);
            return (true, answer * factor);
        }
        return (true, answer / 10 ** (d - 18));
    }

    function _isStale(uint256 updatedAt) internal view returns (bool) {
        if (updatedAt > block.timestamp + MAX_FUTURE_SKEW) return true; // far-future timestamp: not trusted
        if (updatedAt >= block.timestamp) return false; // small clock skew: fresh
        return block.timestamp - updatedAt > maxStaleness;
    }
}
