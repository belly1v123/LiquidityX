// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Settable Chainlink AggregatorV3 mock. When `live` is true, updatedAt == block.timestamp
///  (used by the local anvil deployment so the price never goes stale). answeredInRound is always 0,
///  matching Mezo's precompile.
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public live;
    bool public reverts;
    uint80 public roundId = 1;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
        roundId++;
    }

    function setAnswerAndTime(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
        roundId++;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setLive(bool v) external {
        live = v;
    }

    function setReverts(bool v) external {
        reverts = v;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverts, "MockAggregator: revert");
        uint256 t = live ? block.timestamp : updatedAt;
        return (roundId, answer, t, t, 0);
    }
}
