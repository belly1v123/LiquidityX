// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

/// @notice Mezo's BTC/USD oracle (0x7b7c…0015) is a NATIVE precompile. The bytecode stored at that address is a
///  stub that calls itself; the Mezo node intercepts the call natively. Forge's local simulator has no such
///  precompile, so any call to it recurses until out of gas during `forge script` simulation.
///  Workaround (simulation only): read the real answers from the node with a raw `eth_call` (vm.rpc) and install
///  them with vm.mockCall. Broadcast transactions are unaffected: they execute on the real chain against the real
///  precompile. Scripts using this must be broadcast with `--skip-simulation` (forge's second, on-fork
///  simulation pass would not see the mocks).
abstract contract MezoFeedSim is Script {
    bytes4 internal constant DECIMALS = 0x313ce567; // decimals()
    bytes4 internal constant LATEST_ROUND_DATA = 0xfeaf968c; // latestRoundData()

    function _simulateMezoFeed(address feed) internal {
        if (block.chainid != 31611) return;
        bytes memory dec = _ethCall(feed, DECIMALS);
        bytes memory lrd = _ethCall(feed, LATEST_ROUND_DATA);
        vm.mockCall(feed, abi.encodeWithSelector(DECIMALS), dec);
        vm.mockCall(feed, abi.encodeWithSelector(LATEST_ROUND_DATA), lrd);
        (, int256 answer,, uint256 updatedAt,) = abi.decode(lrd, (uint80, int256, uint256, uint256, uint80));
        console.log("live feed answer (simulation mock)", uint256(answer));
        console.log("live feed updatedAt", updatedAt);
    }

    function _ethCall(address to, bytes4 sel) internal returns (bytes memory) {
        string memory params = string.concat(
            "[{\"to\":\"", vm.toString(to), "\",\"data\":\"", vm.toString(abi.encodePacked(sel)), "\"},\"latest\"]"
        );
        return vm.rpc("eth_call", params);
    }
}
