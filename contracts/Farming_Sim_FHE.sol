pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FarmingSimFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error InvalidState();
    error TooFrequent();
    error BatchClosed();
    error BatchFull();
    error InvalidBatch();
    error StaleWrite();
    error NotTrustedRelayer();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkCooldown(uint256 interval) {
        if (block.timestamp < lastActionAt[msg.sender] + interval) {
            revert TooFrequent();
        }
        _;
    }

    address public owner;
    bool public paused;
    uint256 public constant MIN_INTERVAL = 5 seconds;
    uint256 public cooldownInterval = 10 seconds;
    uint256 public batchSizeLimit = 5;
    uint256 public currentModelVersion;
    mapping(address => bool) public providers;
    mapping(address => uint256) public lastActionAt;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(uint256 => mapping(uint256 => euint32)) public batchAccumulators;
    mapping(uint256 => mapping(uint256 => uint256)) public batchSizes;
    mapping(uint256 => mapping(uint256 => uint256)) public batchVersions;

    struct Batch {
        bool exists;
        bool closed;
        uint256 createdAt;
        uint256 closedAt;
        uint256 modelVersion;
    }

    struct DecryptionContext {
        uint256 batchId;
        uint256 modelVersion;
        bytes32 stateHash;
        bool processed;
        address requester;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownUpdated(uint256 oldInterval, uint256 newInterval);
    event BatchSizeLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event BatchOpened(uint256 indexed batchId, uint256 modelVersion);
    event BatchClosed(uint256 indexed batchId);
    event CropSubmitted(address indexed provider, uint256 indexed batchId, uint256 modelVersion);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, address indexed requester);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 totalScore);
    event ModelVersionUpdated(uint256 oldVersion, uint256 newVersion);

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        currentModelVersion = 1;
        emit ProviderAdded(owner);
        emit ModelVersionUpdated(0, currentModelVersion);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!providers[provider]) {
            providers[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (providers[provider]) {
            providers[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused != paused) {
            paused = _paused;
            if (_paused) {
                emit Paused(msg.sender);
            } else {
                emit Unpaused(msg.sender);
            }
        }
    }

    function setCooldownInterval(uint256 newInterval) external onlyOwner {
        uint256 oldInterval = cooldownInterval;
        cooldownInterval = newInterval;
        emit CooldownUpdated(oldInterval, newInterval);
    }

    function setBatchSizeLimit(uint256 newLimit) external onlyOwner {
        require(newLimit > 0, "Invalid limit");
        uint256 oldLimit = batchSizeLimit;
        batchSizeLimit = newLimit;
        emit BatchSizeLimitUpdated(oldLimit, newLimit);
    }

    function incrementModelVersion() external onlyOwner {
        uint256 oldVersion = currentModelVersion;
        currentModelVersion++;
        emit ModelVersionUpdated(oldVersion, currentModelVersion);
    }

    function openBatch() external onlyProvider whenNotPaused checkCooldown(cooldownInterval) {
        uint256 batchId = uint256(keccak256(abi.encodePacked(address(this), currentModelVersion, block.timestamp)));
        require(!batches[batchId].exists, "Batch exists");
        batches[batchId] = Batch({
            exists: true,
            closed: false,
            createdAt: block.timestamp,
            closedAt: 0,
            modelVersion: currentModelVersion
        });
        lastActionAt[msg.sender] = block.timestamp;
        emit BatchOpened(batchId, currentModelVersion);
    }

    function closeBatch(uint256 batchId) external onlyProvider whenNotPaused {
        Batch storage batch = batches[batchId];
        require(batch.exists, "Batch not found");
        require(!batch.closed, "Batch closed");
        batch.closed = true;
        batch.closedAt = block.timestamp;
        emit BatchClosed(batchId);
    }

    function submitCrop(
        uint256 batchId,
        euint32 yield_,
        euint32 resistance_,
        euint32 growthRate_
    ) external onlyProvider whenNotPaused checkCooldown(cooldownInterval) {
        Batch storage batch = batches[batchId];
        require(batch.exists, "Batch not found");
        require(!batch.closed, "Batch closed");
        require(batch.modelVersion == currentModelVersion, "Stale batch");

        uint256 currentSize = batchSizes[batchId][currentModelVersion];
        require(currentSize < batchSizeLimit, "Batch full");

        euint32 memory totalScore = yield_.add(resistance_).add(growthRate_);
        euint32 storage acc = batchAccumulators[batchId][currentModelVersion];
        if (!FHE.isInitialized(acc)) {
            acc = FHE.asEuint32(0);
        }
        acc = acc.add(totalScore);
        batchAccumulators[batchId][currentModelVersion] = acc;
        batchSizes[batchId][currentModelVersion] = currentSize + 1;
        batchVersions[batchId][currentModelVersion] = currentModelVersion;

        lastActionAt[msg.sender] = block.timestamp;
        emit CropSubmitted(msg.sender, batchId, currentModelVersion);
    }

    function requestBatchDecryption(uint256 batchId) external whenNotPaused checkCooldown(cooldownInterval) {
        Batch storage batch = batches[batchId];
        require(batch.exists, "Batch not found");
        require(batch.closed, "Batch not closed");
        require(batch.modelVersion == currentModelVersion, "Stale batch");

        euint32 storage acc = batchAccumulators[batchId][currentModelVersion];
        _requireInitialized(acc, "Accumulator not initialized");

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(acc);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.onBatchDecrypted.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            modelVersion: currentModelVersion,
            stateHash: stateHash,
            processed: false,
            requester: msg.sender
        });

        lastActionAt[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, msg.sender);
    }

    function onBatchDecrypted(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];
        require(!ctx.processed, "Request processed");
        require(ctx.requester != address(0), "Invalid context");

        Batch storage batch = batches[ctx.batchId];
        require(batch.exists, "Batch not found");
        require(batch.closed, "Batch not closed");
        require(batch.modelVersion == ctx.modelVersion, "Version mismatch");

        euint32 storage acc = batchAccumulators[ctx.batchId][ctx.modelVersion];
        _requireInitialized(acc, "Accumulator not initialized");

        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = FHE.toBytes32(acc);
        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        require(currentStateHash == ctx.stateHash, "State hash mismatch");

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32 totalScore = abi.decode(cleartexts, (uint32));
        ctx.processed = true;

        emit DecryptionCompleted(requestId, ctx.batchId, totalScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal pure returns (euint32) {
        if (!FHE.isInitialized(x)) {
            return FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) internal pure {
        if (!FHE.isInitialized(x)) {
            revert InvalidState();
        }
    }
}