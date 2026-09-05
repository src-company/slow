// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test} from "@forge/Test.sol";
import {SlowPage} from "../src/SlowPage.sol";

/// @dev A STOP-prefixed data contract, exactly as `scripts/chunk.mjs` emits.
///      Byte zero is 0x00 so a chunk can never be mistaken for callable code,
///      and `_assemble` skips it.
library Chunk {
    function make(bytes memory payload) internal returns (address a) {
        bytes memory runtime = abi.encodePacked(hex"00", payload);
        bytes memory init = abi.encodePacked(
            hex"61", uint16(runtime.length), hex"80600a5f395ff3", runtime
        );
        assembly { a := create(0, add(init, 0x20), mload(init)) }
        require(a != address(0), "chunk deploy failed");
    }
}

/// @notice `SlowPage` had no Solidity test file. It is the contract that serves
///         the dapp, it goes to an address that can never change, and the parts
///         with no coverage were exactly the parts that decide whether a wrong
///         page can be committed and who can append to the lineage.
contract SlowPageTest is Test {
    using Chunk for bytes;

    address internal slow = address(0x5107);
    address internal steward = address(0x57E1);
    address internal stranger = address(0x5721);
    address internal heir = address(0x8E12);

    bytes internal constant PART1 = "<!doctype html><html><body>";
    bytes internal constant PART2 = "hello slow</body></html>";

    function _chunks() internal returns (address[] memory c) {
        c = new address[](2);
        c[0] = Chunk.make(PART1);
        c[1] = Chunk.make(PART2);
    }

    function _page() internal pure returns (bytes memory) {
        return bytes.concat(PART1, PART2);
    }

    function _deploy() internal returns (SlowPage) {
        return new SlowPage(slow, steward, address(0), _chunks(), keccak256(_page()));
    }

    // ───────────────────────────────── the commitment the constructor makes

    /// @notice The whole safety story: a page that does not hash to `pageHash`
    ///         cannot become a deployed contract at all, so the gas estimate
    ///         succeeding is already proof the chunks are the intended document.
    function test_aPageThatDoesNotMatchItsHashCannotBeDeployed() public {
        address[] memory c = _chunks();
        bytes32 wrong = keccak256("some other document");
        vm.expectRevert(
            abi.encodeWithSelector(SlowPage.PageHashMismatch.selector, wrong, keccak256(_page()))
        );
        new SlowPage(slow, steward, address(0), c, wrong);
    }

    function test_aReorderedChunkListIsADifferentDocumentAndIsRefused() public {
        address[] memory c = _chunks();
        (c[0], c[1]) = (c[1], c[0]);
        vm.expectRevert();
        new SlowPage(slow, steward, address(0), c, keccak256(_page()));
    }

    function test_aPageMadeOfNoChunksIsNotAPage() public {
        vm.expectRevert(SlowPage.InvalidData.selector);
        new SlowPage(slow, steward, address(0), new address[](0), keccak256(""));
    }

    /// @dev One byte is the STOP prefix, so a chunk holding nothing but its
    ///      prefix carries no page and is a deploy that went wrong.
    function test_aChunkHoldingOnlyItsPrefixIsRefused() public {
        address[] memory c = new address[](1);
        c[0] = Chunk.make("");
        vm.expectRevert(SlowPage.InvalidData.selector);
        new SlowPage(slow, steward, address(0), c, keccak256(""));
    }

    function test_aDuplicatedChunkIsRefused() public {
        address[] memory c = new address[](2);
        c[0] = Chunk.make(PART1);
        c[1] = c[0];
        vm.expectRevert(SlowPage.InvalidData.selector);
        new SlowPage(slow, steward, address(0), c, keccak256(bytes.concat(PART1, PART1)));
    }

    function test_aZeroSlowIsRefused() public {
        // Chunks first: `expectRevert` arms the NEXT call, and building them
        // inside the argument list would arm it against a chunk deploy.
        address[] memory c = _chunks();
        vm.expectRevert(SlowPage.InvalidData.selector);
        new SlowPage(address(0), steward, address(0), c, keccak256(_page()));
    }

    /// @dev `previous` cannot be misstated: any non-zero value must equal
    ///      `msg.sender`, and only `deployNext` is ever that.
    function test_aPreviousNobodyIsCannotBeClaimed() public {
        address[] memory c = _chunks();
        vm.expectRevert(SlowPage.InvalidData.selector);
        new SlowPage(slow, steward, address(0xDEAD), c, keccak256(_page()));
    }

    // ──────────────────────────────────────────────────────────── the page

    function test_htmlReassemblesTheDocumentByteForByte() public {
        SlowPage p = _deploy();
        assertEq(bytes(p.html()), _page());
        assertEq(p.PAGE_LENGTH(), _page().length);
        assertEq(p.PAGE_HASH(), keccak256(_page()));
        assertEq(keccak256(bytes(p.html())), p.PAGE_HASH(), "html() always hashes to the commitment");
    }

    function test_theChunkListIsReadableAndOrdered() public {
        address[] memory c = _chunks();
        SlowPage p = new SlowPage(slow, steward, address(0), c, keccak256(_page()));
        assertEq(p.chunkCount(), 2);
        assertEq(p.chunkAt(0), c[0]);
        assertEq(p.chunkAt(1), c[1]);
        vm.expectRevert();
        p.chunkAt(2);
    }

    function test_itNamesTheProtocolContractWithoutOwningIt() public {
        assertEq(_deploy().SLOW(), slow);
    }

    // ───────────────────────── ERC-4804 / ERC-5219, the web-facing hooks

    function test_resolveModeIs5219SoAGatewayUsesRequest() public {
        assertEq(_deploy().resolveMode(), bytes32("5219"));
    }

    function test_requestServesThePageWithHeadersABrowserNeeds() public {
        SlowPage p = _deploy();
        (uint16 code, string memory body, SlowPage.KeyValue[] memory h) =
            p.request(new string[](0), new SlowPage.KeyValue[](0));

        assertEq(code, 200);
        assertEq(bytes(body), _page());
        assertEq(h.length, 2);
        assertEq(h[0].key, "Content-Type");
        // Without this a browser downloads the dapp instead of rendering it.
        assertEq(h[0].value, "text/html");
        assertEq(h[1].key, "Cache-Control");
    }

    /// @notice Path and query are ignored on purpose — one document is served
    ///         from every URL on this contract.
    function test_everyPathServesTheSameDocument() public {
        SlowPage p = _deploy();
        string[] memory deep = new string[](2);
        deep[0] = "some";
        deep[1] = "path";
        (uint16 code,, ) = p.request(deep, new SlowPage.KeyValue[](0));
        (, string memory body,) = p.request(deep, new SlowPage.KeyValue[](0));
        assertEq(code, 200);
        assertEq(bytes(body), _page());
    }

    // ───────────────────────────────────────────────────────── stewardship

    function test_stewardshipMovesInTwoSteps() public {
        SlowPage p = _deploy();
        assertEq(p.steward(), steward);

        vm.prank(stranger);
        vm.expectRevert(SlowPage.NotSteward.selector);
        p.transferStewardship(stranger);

        vm.prank(steward);
        p.transferStewardship(heir);
        assertEq(p.steward(), steward, "not until it is accepted");
        assertEq(p.pendingSteward(), heir);

        vm.prank(stranger);
        vm.expectRevert(SlowPage.NotPendingSteward.selector);
        p.acceptStewardship();

        vm.prank(heir);
        p.acceptStewardship();
        assertEq(p.steward(), heir);
        assertEq(p.pendingSteward(), address(0));
    }

    /// @dev A mistyped address must be withdrawable without ending the lineage.
    function test_anOfferCanBeWithdrawn() public {
        SlowPage p = _deploy();
        vm.startPrank(steward);
        p.transferStewardship(address(0xBAD));
        p.transferStewardship(address(0));
        vm.stopPrank();
        assertEq(p.pendingSteward(), address(0));
        assertEq(p.steward(), steward, "and the steward still holds it");
    }

    function test_renouncingEndsTheLineageAndClearsAnyStandingOffer() public {
        SlowPage p = _deploy();
        vm.startPrank(steward);
        p.transferStewardship(heir);
        p.renounceStewardship();
        vm.stopPrank();

        assertEq(p.steward(), address(0));
        assertEq(p.pendingSteward(), address(0), "a standing offer must not outlive the role");

        vm.prank(heir);
        vm.expectRevert(SlowPage.NotPendingSteward.selector);
        p.acceptStewardship();

        // And the page itself is untouched by any of it.
        assertEq(bytes(p.html()), _page());
    }

    // ──────────────────────────────────────────────────────────── lineage

    function test_aFreshPageIsGenerationOneWithNoNeighbours() public {
        SlowPage p = _deploy();
        assertEq(p.PREVIOUS(), address(0));
        assertEq(p.successor(), address(0));
        assertEq(p.succeededAt(), 0);
        assertEq(p.generation(), 1);
        assertEq(p.latest(), address(p), "with no successor, the tip is itself");
    }

    function test_onlyTheStewardMayAppend() public {
        SlowPage p = _deploy();
        vm.prank(stranger);
        vm.expectRevert(SlowPage.NotSteward.selector);
        p.deployNext(hex"6001600101", bytes32(uint256(1)));
    }

    /// @notice The successor must actually name this contract as its
    ///         predecessor, so an unrelated contract cannot be written in.
    function test_aSuccessorThatDoesNotNameUsIsRefused() public {
        SlowPage p = _deploy();
        // An unrelated page, whose PREVIOUS() is the zero address.
        bytes memory init = abi.encodePacked(
            type(SlowPage).creationCode,
            abi.encode(slow, steward, address(0), _chunks(), keccak256(_page()))
        );
        vm.prank(steward);
        vm.expectRevert();
        p.deployNext(init, bytes32(uint256(7)));
    }

    /// @notice Write-once. A rewritable pointer is a mutable redirect, not
    ///         lineage, and a reader walking it could be sent anywhere.
    function test_theSuccessorPointerIsWriteOnce() public {
        SlowPage p = _deploy();
        // Force a successor into place through the only writer, then prove the
        // second attempt is refused whatever it is.
        bytes memory init = abi.encodePacked(
            type(SlowPage).creationCode,
            abi.encode(slow, steward, address(p), _chunks(), keccak256(_page()))
        );
        vm.prank(steward);
        address next = p.deployNext(init, bytes32(uint256(11)));

        assertEq(p.successor(), next);
        assertEq(p.succeededAt(), uint96(block.timestamp));
        assertEq(SlowPage(next).PREVIOUS(), address(p));

        vm.prank(steward);
        vm.expectRevert(SlowPage.AlreadySucceeded.selector);
        p.deployNext(init, bytes32(uint256(12)));
    }

    /// @notice A client wanting the newest build walks `successor`; one wanting
    ///         the bytes it audited stops where it is. Both must work.
    function test_theLineageIsWalkableInBothDirections() public {
        SlowPage v1 = _deploy();
        bytes memory init = abi.encodePacked(
            type(SlowPage).creationCode,
            abi.encode(slow, steward, address(v1), _chunks(), keccak256(_page()))
        );
        vm.prank(steward);
        SlowPage v2 = SlowPage(v1.deployNext(init, bytes32(uint256(21))));

        assertEq(v1.latest(), address(v2), "v1 points forward to the tip");
        assertEq(v2.latest(), address(v2), "and the tip is its own tip");
        assertEq(v2.generation(), 2);
        assertEq(v1.generation(), 1, "a predecessor's own generation never moves");
        assertEq(v2.PREVIOUS(), address(v1));

        // v1 still serves its own bytes, which is the property the whole
        // no-redirect design exists for.
        assertEq(bytes(v1.html()), _page());
    }
}
