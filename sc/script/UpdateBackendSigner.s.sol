// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {GameSettlement} from "../src/GameSettlement.sol";

contract UpdateBackendSigner is Script {
    function run() external {
        uint256 privateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        address settlementAddress = vm.envAddress("GAME_SETTLEMENT_ADDRESS");
        address newBackendSigner = vm.envAddress("NEW_BACKEND_SIGNER");

        if (privateKey == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(privateKey);
        }

        GameSettlement settlement = GameSettlement(settlementAddress);
        address previousSigner = settlement.backendSigner();
        settlement.setBackendSigner(newBackendSigner);

        vm.stopBroadcast();

        console2.log("Settlement:", settlementAddress);
        console2.log("Previous backend signer:", previousSigner);
        console2.log("New backend signer:", newBackendSigner);
    }
}
