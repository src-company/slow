// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {Script, console2} from "@forge/Script.sol";
import {SlowArrival} from "../src/SlowArrival.sol";
import {SlowRelay} from "../src/SlowRelay.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes memory initCode)
        external
        payable
        returns (address);
}

/// @title DeployBridge
/// @notice Puts `SlowArrival` and `SlowRelay` at ONE address on Ethereum, Base
///         and Robinhood Chain.
///
/// @dev WHY ONE ADDRESS IS NOT A CONVENIENCE HERE. `SlowRelay.receiveRelay`
///      accepts a cross-chain proof only when the recovered origin equals
///      `address(this)`. That is what lets a message from the relay on another
///      chain be recognised without a registry, an owner or an oracle — so if
///      the addresses diverge, the relay silently stops settling. The same-address
///      property is a correctness requirement, not a nicety, and this script
///      asserts it rather than assuming it.
///
/// @dev WHY CONSTRUCTOR ARGUMENTS DO NOT BREAK IT. A CREATE3 address is
///      `keccak256(0xd694 ++ proxy ++ 0x01)`, where the proxy comes from
///      CREATE2 over a FIXED initcode. The child's own initcode never enters the
///      derivation, so `SlowRelay` can take a different messenger set on each
///      chain and still land at the same address. That is the only reason the
///      chain-specific trust this contract needs is affordable.
///
/// @dev THE TWO CreateX TRAPS, both already paid for in `scripts/address.mjs`
///      and repeated here because getting either wrong is unrecoverable:
///
///        1. CreateX does not use the salt directly — `deployCreate3` runs it
///           through `_guard()` first. The address must be derived from the
///           GUARDED salt.
///        2. Byte 20 of the salt is CreateX's redeploy-protection flag, and
///           setting it mixes `block.chainid` into the guard. It must be 0x00,
///           or every chain gets a different address and the relay is inert.
///
///      The salt used here is sender-prefixed with byte 20 = 0x00: permissioned,
///      so nobody else can burn it, and chain-independent, which is the point.
///
/// @dev USAGE
///
///        forge script script/DeployBridge.s.sol --rpc-url <chain> --broadcast \
///          --sig "run(address,uint64)" <slow> <saltNonce>
///
///      Run it once per chain with the SAME sender and the SAME `saltNonce`.
///      Any divergence in either produces a different address, which the final
///      assertion catches before the transaction is worth anything.
contract DeployBridge is Script {
    /// @dev CreateX, verified live at 11,838 bytes on chains 1, 8453 and 4663.
    address internal constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;

    /// @dev The CREATE3 proxy initcode. Its runtime, `0x363d3d37363d34f0`, is a
    ///      bare CREATE forwarder.
    bytes32 internal constant PROXY_INITCODE_HASH =
        keccak256(hex"67363d3d37363d34f03d5260086018f3");

    // ── The contracts that DELIVER a cross-chain message, per chain ─────────
    //
    // Not the contracts that SEND one, which is the distinction that matters:
    // `proveFill` leaves through `L2CrossDomainMessenger.sendMessage` or
    // `ArbSys.sendTxToL1`, and what arrives on the far side is whoever executes
    // it. On OP Stack that is the L1CrossDomainMessenger; on Nitro it is the
    // BRIDGE, because `Outbox.executeTransaction` routes through
    // `bridge.executeCall`.

    /// @dev Base's L1CrossDomainMessenger. Verified: its `portal()` returns
    ///      0x49048044…E97e, Base's OptimismPortal.
    address internal constant BASE_L1_MESSENGER = 0x866E82a600A1414e583f7F13623F1aC5d58b0Afa;

    /// @dev Robinhood Chain's Bridge, reached from the Inbox's `bridge()`.
    ///      Holds 235,938 ETH; its `activeOutbox()` reads zero at rest, which is
    ///      what makes it usable as a proof of context.
    address internal constant ROBINHOOD_BRIDGE = 0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3;

    /// @dev Where a forward may send value ON to, from L1. These are the SEND
    ///      side, unlike the messengers above which are the receive side: Base's
    ///      OptimismPortal and Robinhood's Delayed Inbox, the same two the page
    ///      already builds its own deposits against.
    address internal constant BASE_PORTAL = 0x49048044D57e1C92A77f79988d21Fa8fAF74E97e;
    address internal constant ROBINHOOD_INBOX = 0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D;

    /// @dev Generous on purpose. The onward call is an `arrive`, which costs
    ///      about 285,000 for an ordinary recipient — but the recipient's
    ///      ERC-1155 hook spends from the same budget, and buying too little
    ///      here strands a transfer that has already waited five days.
    uint64 internal constant FORWARD_GAS = 1_000_000;
    uint128 internal constant FORWARD_MAX_FEE = 1 gwei;

    error NotCreateX();
    error BadSalt();
    error AddressMismatch(address predicted, address actual);

    function run(address slow, uint64 saltNonce) external {
        require(CREATEX.code.length != 0, NotCreateX());

        address deployer = msg.sender;
        bytes32 salt = _salt(deployer, saltNonce);

        (uint256[] memory ids, SlowArrival.Route[] memory routes) = _forwardRoutes();
        bytes memory arrivalInit =
            abi.encodePacked(type(SlowArrival).creationCode, abi.encode(slow, ids, routes));
        bytes memory relayInit = abi.encodePacked(
            type(SlowRelay).creationCode, abi.encode(slow, _messengers())
        );

        address predictedArrival = predict(deployer, salt);
        address predictedRelay = predict(deployer, _salt(deployer, saltNonce + 1));

        console2.log("chain            ", block.chainid);
        console2.log("deployer         ", deployer);
        console2.log("SLOW             ", slow);
        console2.log("SlowArrival (exp)", predictedArrival);
        console2.log("SlowRelay   (exp)", predictedRelay);

        vm.startBroadcast();
        address arrival = ICreateX(CREATEX).deployCreate3(salt, arrivalInit);
        address relay =
            ICreateX(CREATEX).deployCreate3(_salt(deployer, saltNonce + 1), relayInit);
        vm.stopBroadcast();

        require(arrival == predictedArrival, AddressMismatch(predictedArrival, arrival));
        require(relay == predictedRelay, AddressMismatch(predictedRelay, relay));

        // Post-conditions, so a deployment that lands cannot also be wrong.
        require(SlowArrival(payable(arrival)).slow() == slow, AddressMismatch(slow, address(0)));
        require(SlowRelay(payable(relay)).slow() == slow, AddressMismatch(slow, address(0)));
        address[] memory expected = _messengers();
        for (uint256 i; i != expected.length; ++i) {
            require(
                SlowRelay(payable(relay)).trustedMessenger(expected[i]),
                AddressMismatch(expected[i], address(0))
            );
        }

        console2.log("SlowArrival      ", arrival);
        console2.log("SlowRelay        ", relay);
        console2.log("messengers       ", expected.length);
    }

    /// @notice Where `SlowArrival.forward` may push value on to from this chain.
    /// @dev Only L1 has any, and that is not an omission either. Forwarding
    ///      exists to turn an L2-to-L2 send into one action, and both legs of
    ///      that pass through L1 — there is no canonical path from one L2
    ///      straight to another, so an L2 has nowhere to forward to.
    ///
    ///      This is the one set of addresses this contract trusts with VALUE, so
    ///      unlike the relay's untrusted `pushProof` entry it is fixed at
    ///      construction and there is no setter.
    function _forwardRoutes()
        internal
        view
        returns (uint256[] memory ids, SlowArrival.Route[] memory routes)
    {
        if (block.chainid != 1) {
            return (new uint256[](0), new SlowArrival.Route[](0));
        }
        ids = new uint256[](2);
        routes = new SlowArrival.Route[](2);
        ids[0] = 8453;
        routes[0] = SlowArrival.Route(BASE_PORTAL, 1, FORWARD_GAS, FORWARD_MAX_FEE);
        ids[1] = 4663;
        routes[1] = SlowArrival.Route(ROBINHOOD_INBOX, 2, FORWARD_GAS, FORWARD_MAX_FEE);
    }

    /// @notice Which contracts may deliver a proof to the relay on THIS chain.
    /// @dev Empty on both L2s, and that is not an omission. A message from the
    ///      relay on L1 arrives at `applyAlias(address(this))`, and forging that
    ///      would mean deploying code at one specific address nobody can reach —
    ///      so the L2 side needs no allowlist at all. Only L1, which receives
    ///      through general-purpose bridge contracts, needs to name them.
    function _messengers() internal view returns (address[] memory out) {
        if (block.chainid == 1) {
            out = new address[](2);
            out[0] = BASE_L1_MESSENGER;
            out[1] = ROBINHOOD_BRIDGE;
        } else {
            out = new address[](0);
        }
    }

    /// @notice Sender-prefixed, byte 20 zeroed, counter in the tail.
    /// @dev Permissioned (only `deployer` can use it) AND chain-independent
    ///      (byte 20 keeps `block.chainid` out of the guard). Both halves are
    ///      required: the first stops anyone else burning the address, the
    ///      second is what makes it the same address everywhere.
    function _salt(address deployer, uint64 n) public pure returns (bytes32) {
        return bytes32(
            (uint256(uint160(deployer)) << 96) // bytes 0..19
                | uint256(n) // bytes 24..31; byte 20 stays 0x00
        );
    }

    /// @notice Where `deployCreate3(salt, …)` sent by `deployer` actually lands.
    function predict(address deployer, bytes32 salt) public pure returns (address) {
        require(bytes20(salt) == bytes20(deployer), BadSalt());
        require(uint8(salt[20]) == 0x00, BadSalt());

        // CreateX `_guard`, sender-prefixed branch with the flag clear.
        bytes32 guarded = keccak256(abi.encode(deployer, salt));

        address proxy = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), CREATEX, guarded, PROXY_INITCODE_HASH)
                    )
                )
            )
        );
        // rlp([proxy, 1]) == 0xd6 0x94 ++ proxy ++ 0x01
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes2(0xd694), proxy, bytes1(0x01)))))
        );
    }
}
