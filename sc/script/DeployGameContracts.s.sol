// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {GameUSDC} from "../src/GameUSDC.sol";
import {USDCFaucet} from "../src/USDCFaucet.sol";
import {GameVault} from "../src/GameVault.sol";
import {GameSettlement} from "../src/GameSettlement.sol";

contract DeployGameContracts is Script {
    uint256 internal constant DEFAULT_FAUCET_CLAIM_AMOUNT = 100 * 1e6;
    uint64 internal constant DEFAULT_SESSION_EXPIRY_DELAY = 1 days;

    function run() external returns (GameUSDC token, USDCFaucet faucet, GameVault vault, GameSettlement settlement) {
        uint256 privateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        uint256 claimAmount = vm.envOr("USDC_FAUCET_CLAIM_AMOUNT", DEFAULT_FAUCET_CLAIM_AMOUNT);
        address initialOwner = vm.envOr("INITIAL_OWNER", address(0));
        address backendSigner = vm.envOr("BACKEND_SIGNER", address(0));
        uint64 sessionExpiryDelay = uint64(vm.envOr("SESSION_EXPIRY_DELAY", uint256(DEFAULT_SESSION_EXPIRY_DELAY)));

        if (privateKey == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(privateKey);
        }

        (, address broadcaster,) = vm.readCallers();
        if (initialOwner == address(0)) {
            initialOwner = privateKey == 0 ? broadcaster : vm.addr(privateKey);
        }
        if (backendSigner == address(0)) {
            backendSigner = initialOwner;
        }

        GameUSDC tokenImplementation = new GameUSDC();
        token = GameUSDC(
            address(new ERC1967Proxy(address(tokenImplementation), abi.encodeCall(GameUSDC.initialize, (initialOwner))))
        );

        USDCFaucet faucetImplementation = new USDCFaucet();
        faucet = USDCFaucet(
            address(
                new ERC1967Proxy(
                    address(faucetImplementation),
                    abi.encodeCall(USDCFaucet.initialize, (initialOwner, address(token), claimAmount))
                )
            )
        );

        GameVault vaultImplementation = new GameVault();
        vault = GameVault(
            address(
                new ERC1967Proxy(
                    address(vaultImplementation), abi.encodeCall(GameVault.initialize, (initialOwner, address(token)))
                )
            )
        );

        GameSettlement settlementImplementation = new GameSettlement();
        settlement = GameSettlement(
            address(
                new ERC1967Proxy(
                    address(settlementImplementation),
                    abi.encodeCall(
                        GameSettlement.initialize, (initialOwner, address(vault), backendSigner, sessionExpiryDelay)
                    )
                )
            )
        );

        token.setMinter(address(faucet), true);
        vault.setSettlement(address(settlement));

        vm.stopBroadcast();

        console2.log("Owner:", initialOwner);
        console2.log("Backend signer:", backendSigner);
        console2.log("Session expiry delay:", sessionExpiryDelay);
        console2.log("GameUSDC implementation:", address(tokenImplementation));
        console2.log("USDCFaucet implementation:", address(faucetImplementation));
        console2.log("GameVault implementation:", address(vaultImplementation));
        console2.log("GameSettlement implementation:", address(settlementImplementation));
        console2.log("GameUSDC proxy:", address(token));
        console2.log("USDCFaucet proxy:", address(faucet));
        console2.log("GameVault proxy:", address(vault));
        console2.log("GameSettlement proxy:", address(settlement));
        console2.log("NEXT_PUBLIC_USDC_ADDRESS=%s", address(token));
        console2.log("NEXT_PUBLIC_GAME_VAULT_ADDRESS=%s", address(vault));
        console2.log("NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS=%s", address(settlement));
    }
}
