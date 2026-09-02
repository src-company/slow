// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

/// @title SLOW onchain page (ERC-8244 / ERC-5219 / ERC-4804)
/// @notice Serves the SLOW dapp as one self-contained HTML document, stored as
///         the runtime bytecode of a list of data contracts.
///
/// @dev WHY THIS IS NOT THE PROTOCOL CONTRACT.
///      SLOW itself already implements `html()`, from two `immutable` chunk
///      pointers set in its constructor. That put the page's ceiling in the
///      constructor's arity rather than in EIP-170, and the ceiling was reached
///      with 47 bytes to spare — measured on chain, where the two chunks hold
///      24,551 and 24,552 payload bytes against a 24,575-byte limit each.
///
///      The protocol contract is audited, deployed and holding funds. Nothing
///      about a frontend fix justifies moving it. So the page lives here, in a
///      contract that owns none of the protocol and only names it: `SLOW` below
///      is the address every transaction in the page is built against, and it
///      is the already-deployed one. This is the same shape the ERC-8244
///      reference dapps use — Fwa8244 points at an FWA core contract it does
///      not control — and it makes the page's budget a function of how many
///      chunks are deployed rather than of how many slots someone typed.
///
/// @dev WHY THE CHUNK LIST IS A DYNAMIC ARRAY.
///      `address[] storage` costs one cold SLOAD per chunk inside `html()`, a
///      view function reached by `eth_call`, where nobody pays gas. In exchange
///      the page can grow to any size without editing this file. Fixed slots
///      buy nothing here and cap the document.
///
/// @dev WHY THE CONSTRUCTOR COMMITS TO A HASH.
///      A missing chunk, a reordered list, or one chunk from a stale build all
///      produce a different document. Reassembling during construction and
///      reverting unless it hashes to `PAGE_HASH` means such a deployment
///      cannot exist — the gas estimate succeeding is already proof that the
///      chunks add up to exactly the intended page, before the transaction is
///      ever broadcast.
///
/// @dev DEPLOY THROUGH CREATE3.
///      The page embeds its own address so its footer can name the contract
///      that served it, and CREATE2 cannot supply that: under CREATE2 the
///      address depends on the initcode, the initcode carries the chunk
///      addresses, the chunk addresses depend on the page, and the page
///      contains the address. CREATE3 derives the address from the deployer and
///      the salt alone, so the salt is mined once, before any content exists,
///      and the page is written around an address that is already known.
///
/// HOW TO READ THE DAPP
///   cast call <addr> "html()(string)" --rpc-url <rpc> > slow.html
///
/// HOW TO BROWSE IT
///   - ERC-8244: https://<addr>.w4eth.io/
///   - ERC-4804: https://<addr>.1.w3link.io/   (through the ERC-5219 request())
///   - Or any browser with web3:// protocol support.
contract SlowPage {
    string public constant NAME = "slow.wei";

    /// @notice The SLOW protocol contract this page drives. Not owned, not
    ///         upgraded, not proxied — only named, so a reader can check that
    ///         the page they are looking at builds transactions against the
    ///         contract they audited.
    address public immutable SLOW;

    /// @notice keccak256 of the page, committed to at construction.
    bytes32 public immutable PAGE_HASH;

    /// @notice The page's byte length, summed from the chunks at construction.
    /// @dev Held so `html()` allocates once instead of measuring first.
    uint256 public immutable PAGE_LENGTH;

    /// @dev The ordered chunk addresses. Written once, in the constructor.
    address[] private _chunks;

    /// @dev A missing, reordered or duplicated chunk would permanently serve
    ///      broken HTML.
    error InvalidData();

    /// @dev The chunks do not reassemble to the document being committed to.
    error PageHashMismatch(bytes32 expected, bytes32 actual);

    struct KeyValue {
        string key;
        string value;
    }

    // ─────────────────────────────────────────────────────────────── LINEAGE
    //
    // `html()` is immutable and stays that way. The successor pointer below is
    // a CLAIM ABOUT LINEAGE, never a redirect: this contract serves its own
    // chunks forever, whatever is deployed later. Forwarding `html()` to a
    // successor would have been the smaller change and it would have cost the
    // one property this design exists for — an address whose bytes cannot move
    // under an auditor, a bookmark, or a cache that was told they are fixed.
    //
    // A client wanting the newest build walks `successor` until it reaches
    // zero. A client wanting the bytes it audited stops where it is.

    /// @notice The account permitted to deploy this version's successor.
    /// @dev Not immutable: a steward is a person or a multisig and both change,
    ///      while the lineage is meant to outlive all of it. What is not
    ///      relaxed is anything a reader depends on — `PREVIOUS` and
    ///      `successor` are write-once and checked before they are set, so the
    ///      chain a reader walks cannot be restated by a steward, new or old.
    ///      This variable decides only WHO MAY APPEND.
    address public steward;

    /// @notice The account offered the role, until it accepts.
    /// @dev Two steps, not one. A single-call transfer to a mistyped address
    ///      ends the lineage as surely as renouncing it, silently and with no
    ///      way back. The deliberate ending has its own function.
    address public pendingSteward;

    /// @notice The version that deployed this one; zero for the first.
    address public immutable PREVIOUS;

    /// @notice The next version, once the steward has deployed it. Write-once:
    ///         a rewritable pointer is not lineage, it is a mutable redirect.
    address public successor;

    /// @notice When `successor` was set, as a unix timestamp; zero until then.
    /// @dev The one fact only the chain knows. A reader following this pointer
    ///      cannot otherwise tell whether it appeared a year ago or in the
    ///      block they are reading. It cannot be backdated.
    uint96 public succeededAt;

    error NotSteward();
    error NotPendingSteward();
    error AlreadySucceeded();
    error DeployFailed();
    error NotASuccessor();

    event Succeeded(address indexed successor, uint256 indexed generation);
    event StewardshipOffered(address indexed from, address indexed to);
    event StewardshipTransferred(address indexed from, address indexed to);

    /// @param slow           The SLOW protocol contract the page transacts with.
    /// @param initialSteward Account permitted to deploy the successor; zero
    ///                       freezes the lineage at this version from birth.
    /// @param previous       The version deploying this one; zero for the first.
    /// @param chunks         Ordered STOP-prefixed data contracts holding the page.
    /// @param pageHash       keccak256 of the document they must reassemble to.
    /// @dev `previous` cannot be misstated: any non-zero value must equal
    ///      `msg.sender`, and a successor is only ever created by `deployNext`,
    ///      so the deployer IS the predecessor at construction time. No version
    ///      NUMBER is stored — it is derived by walking, so there is no counter
    ///      to pass in wrongly, skip, or repeat.
    constructor(
        address slow,
        address initialSteward,
        address previous,
        address[] memory chunks,
        bytes32 pageHash
    ) {
        if (slow == address(0)) revert InvalidData();
        if (previous != address(0) && msg.sender != previous) revert InvalidData();

        SLOW = slow;
        steward = initialSteward;
        PREVIOUS = previous;

        uint256 n = chunks.length;
        // A page made of no chunks is not a page.
        if (n == 0) revert InvalidData();

        uint256 total;
        for (uint256 i; i != n; ++i) {
            // One byte is the STOP prefix, so a chunk holding nothing but its
            // prefix carries no page and is a deploy that went wrong.
            uint256 size = chunks[i].code.length;
            if (size < 2) revert InvalidData();
            for (uint256 j = i + 1; j != n; ++j) {
                if (chunks[i] == chunks[j]) revert InvalidData();
            }
            unchecked {
                total += size - 1;
            }
        }

        bytes32 actual = keccak256(bytes(_assemble(chunks, total)));
        if (actual != pageHash) revert PageHashMismatch(pageHash, actual);

        _chunks = chunks;
        PAGE_HASH = pageHash;
        PAGE_LENGTH = total;
        emit StewardshipTransferred(address(0), initialSteward);
    }

    // ───────────────────────────────────────────────────────────── THE PAGE

    /// @notice The page, as one string. This is the ERC-8244 entry point.
    function html() external view returns (string memory) {
        return _assemble(_chunks, PAGE_LENGTH);
    }

    /// @notice ERC-5219 request handler. Any path returns the page with
    ///         `Content-Type: text/html` and a permanent cache hint: the
    ///         response is byte-identical forever, since the bytecode is
    ///         immutable. Path and query are ignored — the dapp is one document
    ///         served from every URL on this contract.
    function request(string[] memory, /*resource*/ KeyValue[] memory /*params*/ )
        external
        view
        returns (uint16 statusCode, string memory body, KeyValue[] memory headers)
    {
        statusCode = 200;
        body = _assemble(_chunks, PAGE_LENGTH);
        headers = new KeyValue[](2);
        headers[0] = KeyValue("Content-Type", "text/html");
        headers[1] = KeyValue("Cache-Control", "public, max-age=31536000, immutable");
    }

    /// @notice ERC-4804 / ERC-6860 resolution mode. Gateways should route
    ///         through `request()` rather than attempt auto-mode dispatch.
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// @notice How many data contracts the page is stored in.
    function chunkCount() external view returns (uint256) {
        return _chunks.length;
    }

    /// @notice One data contract from the ordered chunk list.
    /// @dev Chunk-level access lets a verifier check the page against the
    ///      runtime code at each address without pulling the whole document
    ///      through a single `eth_call`.
    function chunkAt(uint256 index) external view returns (address) {
        return _chunks[index];
    }

    // ───────────────────────────────────────────────────────────── LINEAGE

    /// @notice Offer the steward role to `to`; it moves when `to` accepts.
    /// @dev Offering the zero address withdraws a standing offer. It does NOT
    ///      renounce — giving up the role is a different intent with its own
    ///      function, so neither can be reached by getting this one wrong.
    function transferStewardship(address to) external {
        address cur = steward;
        if (msg.sender != cur || cur == address(0)) revert NotSteward();
        pendingSteward = to;
        emit StewardshipOffered(cur, to);
    }

    /// @notice Accept an offered steward role.
    function acceptStewardship() external {
        address to = pendingSteward;
        if (msg.sender != to || to == address(0)) revert NotPendingSteward();
        address from = steward;
        steward = to;
        pendingSteward = address(0);
        emit StewardshipTransferred(from, to);
    }

    /// @notice Give up the role, freezing the lineage at whatever this version
    ///         has already appended. Irreversible.
    /// @dev A standing offer is cleared in the same call, so an offer made
    ///      before the decision cannot be accepted after it.
    function renounceStewardship() external {
        address cur = steward;
        if (msg.sender != cur || cur == address(0)) revert NotSteward();
        steward = address(0);
        pendingSteward = address(0);
        emit StewardshipTransferred(cur, address(0));
    }

    /// @notice Deploy the next version, at an address known before it exists.
    /// @dev CREATE2 from THIS contract, so the successor's constructor sees
    ///      `msg.sender == address(this)` and its `previous` check passes only
    ///      for the real predecessor. That is what makes the backward pointer
    ///      unforgeable rather than merely recorded.
    /// @param initcode Creation code for the successor, constructor args
    ///                 appended. Its `previous` argument must be this address.
    /// @param salt     CREATE2 salt, so the address is checkable beforehand.
    function deployNext(bytes calldata initcode, bytes32 salt) external returns (address next) {
        if (msg.sender != steward || steward == address(0)) revert NotSteward();
        if (successor != address(0)) revert AlreadySucceeded();
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, initcode.offset, initcode.length)
            next := create2(0, p, initcode.length, salt)
        }
        if (next == address(0)) revert DeployFailed();
        // A codeless deploy, or something that is not one of these, naming this
        // contract as its predecessor. `staticcall` rather than a typed call so
        // a missing function is a revert here and not a decode panic: an
        // address with no code answers successfully with empty returndata.
        (bool ok, bytes memory ret) = next.staticcall(abi.encodeWithSelector(bytes4(keccak256("PREVIOUS()"))));
        if (!ok || ret.length != 32 || abi.decode(ret, (address)) != address(this)) {
            revert NotASuccessor();
        }
        // The forward half of the same check. `latest()` walks by calling
        // `successor()` on each link, so a successor that does not answer it
        // breaks the walk for this contract and every predecessor. It must also
        // be zero: a version born already succeeded is not a new tip.
        (ok, ret) = next.staticcall(abi.encodeWithSelector(bytes4(keccak256("successor()"))));
        if (!ok || ret.length != 32 || abi.decode(ret, (address)) != address(0)) {
            revert NotASuccessor();
        }
        successor = next;
        succeededAt = uint96(block.timestamp);
        emit Succeeded(next, generation() + 1);
    }

    /// @notice How many versions deep this one is; the first is 1.
    /// @dev Derived by walking backwards rather than stored. Bounded, so a long
    ///      chain degrades to an underestimate instead of running out of gas.
    function generation() public view returns (uint256 n) {
        address cur = address(this);
        for (n = 1; n != 33; ++n) {
            address prev = SlowPage(cur).PREVIOUS();
            if (prev == address(0)) return n;
            cur = prev;
        }
    }

    /// @notice The newest version reachable from here, walking `successor`.
    /// @dev Returns this contract when nothing has succeeded it, so a caller
    ///      never has to special-case the tip.
    function latest() external view returns (address tip) {
        tip = address(this);
        for (uint256 i; i != 32; ++i) {
            address next = SlowPage(tip).successor();
            if (next == address(0)) return tip;
            tip = next;
        }
    }

    // ─────────────────────────────────────────────────────────────── INTERNAL

    /// @dev Reassembles the page in one pass: each chunk is copied directly
    ///      after the previous one at the string body, so there is no
    ///      intermediate copy and no concatenation. Copying starts at offset
    ///      one because byte zero of every chunk is the STOP prefix.
    /// @param chunks The ordered chunk addresses, already in memory.
    /// @param total  Their payload lengths summed; the document's byte length.
    function _assemble(address[] memory chunks, uint256 total) private view returns (string memory s) {
        assembly ("memory-safe") {
            s := mload(0x40)
            mstore(s, total)
            let at := add(s, 0x20)
            let n := mload(chunks)
            let item := add(chunks, 0x20)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let a := mload(add(item, shl(5, i)))
                let size := sub(extcodesize(a), 1)
                extcodecopy(a, at, 1, size)
                at := add(at, size)
            }
            mstore(0x40, add(add(s, 0x20), and(add(total, 0x1f), not(0x1f))))
        }
    }
}
