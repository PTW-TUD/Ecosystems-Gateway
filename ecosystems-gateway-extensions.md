# Ecosystems Gateway: Extension Requirements for the C2D Benchmark

Status: requirements draft · Target: [PTW-TUD/Ecosystems-Gateway](https://github.com/PTW-TUD/Ecosystems-Gateway), feature branch off `nautilus_v2` · Consumer: the federated tool-wear C2D benchmark (see [pontus-x-c2d-benchmark-plan.md](pontus-x-c2d-benchmark-plan.md))

## 1. Context

The benchmark publishes datasets, algorithms and model artifacts on Pontus-X (OP Sepolia, one Ocean Node) and runs federated-learning rounds as Compute-to-Data jobs. Its main measurements are **feasibility, transaction count and cost, and time per step**. All operations go through **one gateway instance** that signs with **one or two wallets**.

The gateway on `nautilus_v2` (Nautilus `2.0.0-beta.3`) already covers publishing, updating, querying, starting C2D jobs and fetching results. The benchmark needs the following additional capabilities. Nautilus v2 already provides all of them; the gateway only has to pass them through:

| ID | Requirement | Priority | Needed for |
|---|---|---|---|
| GW-1 | Multiple wallets in one gateway instance | Required for the two-wallet setup | Separating the data side from the aggregator |
| GW-2 | Compute jobs with several input datasets | **Required** | Aggregation, cross-validation, evaluation, cyclic and FedAvg jobs |
| GW-3 | Transaction and payment details of a started compute job | **Required** | Transaction count and cost per job |
| GW-4 | Transaction details of publish and update calls | **Required** | Transaction count and time per publication |
| GW-5 | Full job details in the status response | Required | Time per phase (queue, run, results), escrow payment transactions |
| GW-6 | Listing the node's compute environments | Recommended | Choosing the environment and resources; recording its limits and prices |
| GW-7 | Additional compute options pass-through | Optional | Queue behaviour; result viewers; algorithm environment variables |

## 2. General rules

These apply to every requirement.

1. **Additive proto changes only.** New fields get the next free field number of their message; no field is renamed, renumbered or removed. `npm run proto:breaking` against `main` must stay green.
2. **Defaults keep today's behaviour.** A client that sends none of the new fields gets exactly the current behaviour and responses, apart from additional response fields.
3. **Single source of truth.** Edit only `src/_proto/spp_v3.proto` and regenerate with `npm run proto:gen`. Commit the regenerated `src/generated`, `src/openapi` and `src/_proto_runtime`, as CI requires.
4. **Validation errors are `INVALID_ARGUMENT`** and name the offending field, following the style of the existing price and job-ID checks.
5. **No secrets in responses or logs.** Private keys never appear in a response, log line or error. Responses identify a wallet only by its alias and address.
6. **Tests.** Each requirement gets unit tests in `src/pontusx/pontusx.service.spec.ts` (Nautilus mocked, as in the existing `requestComputeToData` and `publishAsset` suites) and, where the HTTP gateway is affected, a case in `test/app.e2e-spec.ts`.
7. **Documentation.** Update the API table and configuration tables in `README.md`, add the new fields to the "New in v3" list, and extend the Postman collection in `.postman/`.

## 3. Requirements

### GW-1 — Multiple wallets in one gateway instance

**Current state.** The service creates one `Wallet` from `PRIVATE_KEY` and one `Nautilus` instance in `onModuleInit`. Pending compute jobs and cached results live under the network-scoped Redis keys `<network>:ctd:pending` and `<network>:ctd:result:<jobId>`. A single gateway-wide `Mutex` serializes publishing, updating, access and compute submission.

**Requirement.**

1. **Configuration.** A new variable `WALLETS` holds a comma-separated list of `alias=privateKey` pairs, for example `WALLETS=data=0x…,aggregator=0x…`. Aliases match `[a-z0-9_-]{1,32}` and must be unique.
   - If `WALLETS` is unset, `PRIVATE_KEY` defines a single wallet with the alias `default`, exactly as today.
   - If both are set, startup fails with a clear configuration error.
   - The first wallet listed is the default wallet.
2. **One Nautilus instance per wallet.** Each wallet gets its own `Nautilus.create(...)` with the shared network config, remote store, fee and escrow limits and verification provider. This keeps Nautilus' escrow lock and nonce handling per signer.
3. **Wallet selection per request.** Add `optional string wallet = <next>;` (the alias) to:
   - `CreateOfferingRequest`, `UpdateOfferingRequest`, `UpdateOfferingLifecycleRequest`
   - `AccessServiceRequest`
   - `CreateComputeToDataRequest`
   - `ComputeToDataStatusRequest`, `CreateComputeToDataResultRequest`

   If the field is unset, the default wallet is used. An unknown alias returns `INVALID_ARGUMENT` that lists the configured aliases.
4. **Job ownership is remembered.** When a job starts, the gateway stores `jobId → wallet alias` in Redis (key `<network>:ctd:owner:<jobId>`, with the same expiry as the job). Status and result calls without `wallet` use the stored owner, so a client does not have to track which wallet started a job. If a given `wallet` differs from the stored owner, the call returns `PERMISSION_DENIED`.
5. **Background fetcher.** `__periodicallyFetchComputeJobs` fetches each pending job with the Nautilus instance of its owner.
6. **Locking per wallet.** Replace the gateway-wide `Mutex` with one mutex per wallet. Operations of the same wallet stay serialized, which protects the nonce. Operations of different wallets can run concurrently.
7. **Visibility.** The startup log lists every alias with its address. A new RPC `ListWallets` (no request fields) returns `repeated {alias, address, isDefault}` and never the keys.

**Acceptance criteria.**
- With only `PRIVATE_KEY` set, all existing tests pass unchanged.
- With two wallets configured, an offering created with `wallet: "aggregator"` has the aggregator's address as owner, and one created without `wallet` has the default wallet's address.
- A job started with `wallet: "data"` can be polled and its result fetched without passing `wallet`; passing `wallet: "aggregator"` for it returns `PERMISSION_DENIED`.
- Two compute submissions from different wallets overlap in time (verified with a mocked Nautilus that delays); two from the same wallet do not.

### GW-2 — Compute jobs with several input datasets

**Current state.** `CreateComputeToDataRequest` carries exactly one dataset (`did`, `serviceId`, `userdata`). Nautilus v2 accepts `additionalDatasets: ComputeAssetRef[]` and sends all datasets to the node as one array.

**Requirement.**

1. **Proto.**

   ```proto
   message ComputeDataset {
       // DID of the additional dataset
       string did = 1;
       // Compute service of the dataset; defaults to its first compute service
       optional string serviceId = 2;
       // Values for the consumer parameters of that service
       map<string, string> userdata = 3;
   }

   message CreateComputeToDataRequest {
       // ... existing fields 1-11 ...
       // Further datasets the algorithm runs on, after `did`
       repeated ComputeDataset additionalDatasets = 12;
   }
   ```

2. **Resolution.** Each additional dataset is resolved exactly like the primary one: the given compute service, else its first compute service. `userdata` is converted with `toUserdata` against that service's consumer parameters. Errors name the dataset's index and DID.
3. **Order.** The primary `did` stays the first dataset, and the additional datasets follow in request order. Nautilus passes them to the node in this order. The algorithm still identifies inputs by DID, not by position.
4. **Duplicates.** The same `(did, serviceId)` pair may not appear twice: `INVALID_ARGUMENT`.
5. **Free and paid.** `additionalDatasets` is passed to both `nautilus.compute` and `nautilus.freeCompute`.
6. **Limits.** The gateway sets no limit of its own. A limit enforced by the node surfaces as the node's error, mapped through `toRpcException`.

**Acceptance criteria.**
- A request with three additional datasets calls Nautilus with `additionalDatasets` holding three `ComputeAssetRef` with the resolved service IDs and converted userdata.
- A request without `additionalDatasets` produces the same Nautilus config as today.
- An additional dataset without a compute service returns `INVALID_ARGUMENT` naming its index and DID.
- End-to-end on OP Sepolia (manual check, not CI): one aggregation algorithm runs on three model-artifact assets in a single job, and all three DIDs appear under the job's inputs.

### GW-3 — Transaction and payment details of a started compute job

**Current state.** `RunComputeToDataJob` returns only `jobId`. Nautilus' `ComputeResult` also carries `orders` (order transaction hashes keyed by `<did>#<serviceId>`), `environment` and `initializeResults` (provider fees, escrow payment). These are dropped.

**Requirement.**

1. **Proto.**

   ```proto
   message ComputeOrder {
       // Input the order is for, in the form <did>#<serviceId>
       string input = 1;
       // Order transaction hash; reused orders return the hash of the earlier order
       string txHash = 2;
       // true when Nautilus reused a still-valid earlier order instead of sending a new one
       optional bool reused = 3;
   }

   message ComputeToDataResponse {
       repeated string jobId = 1;
       // Wallet alias and address that started the job (GW-1)
       optional string wallet = 2;
       optional string consumerAddress = 3;
       // Compute environment the job runs in
       optional string computeEnv = 4;
       // Order transactions of the algorithm and every dataset; empty for free jobs
       repeated ComputeOrder orders = 5;
       // Escrow payment planned by initializeCompute: token, amount (smallest unit), payee
       optional google.protobuf.Struct escrowPayment = 6;
       // Provider fees per input, as initializeCompute returned them
       optional google.protobuf.Struct providerFees = 7;
       // Gateway-side timestamps (ISO 8601) of the submission call
       optional string submittedAt = 8;
       optional string startedAt = 9;
   }
   ```

   - `submittedAt` is when the gateway received the request.
   - `startedAt` is when Nautilus returned (node accepted the job).
   - Their difference is the full submission block (initialize, escrow, orders, start).

2. **Escrow transactions.** If Nautilus exposes the escrow deposit and authorization transactions of a job (receipts or hashes), return them as further `ComputeOrder` entries with `input` set to `escrow:deposit` and `escrow:authorize`. If it does not, document that in the README; the benchmark reconciles them from the chain.
3. **Free jobs** return `orders` empty and `escrowPayment` and `providerFees` unset.
4. **Redaction.** Struct fields carry only addresses, amounts, token addresses and hashes, never signatures or node-internal URLs.

**Acceptance criteria.**
- With a mocked Nautilus returning two orders and an escrow plan, the response contains both orders, the environment ID and the escrow amount.
- A free job returns an empty `orders` list.
- The existing `jobId` field is unchanged.

### GW-4 — Transaction details of publish and update calls

**Current state.** A successful `CreateOffering` returns only the DIDs (`debugInformation` unset). Nautilus' `PublishResponse` carries the NFT address, one `PublishedService` per service with the datatoken address and its creation receipt, and `setMetadataTxReceipt`. Today the transaction hash is reported only in the error path (asset on chain but not indexed).

**Requirement.**

1. **Proto.**

   ```proto
   message TxReceipt {
       // What the transaction did, e.g. "datatoken:<serviceId>", "setMetadata", "setMetadataState"
       string purpose = 1;
       string txHash = 2;
       optional uint64 blockNumber = 3;
       // Decimal strings, in wei
       optional string gasUsed = 4;
       optional string effectiveGasPrice = 5;
   }

   message PublishReceipt {
       string did = 1;
       string nftAddress = 2;
       // Datatoken address per service id
       map<string, string> datatokens = 3;
       repeated TxReceipt transactions = 4;
       // Gateway-side timestamps (ISO 8601): request received, metadata tx mined, node indexed
       optional string submittedAt = 5;
       optional string metadataMinedAt = 6;
       optional string indexedAt = 7;
   }
   ```

2. **Where they are returned.**
   - `CreateOfferingResponse` gets `repeated PublishReceipt receipts = <next>;`, one per published Pontus-X offering, in request order.
   - `UpdateOfferingResponse` gets the same field for updated Pontus-X offerings. Updates usually have only the `setMetadata` transaction.
   - `UpdateOfferingLifecycle` returns its existing `txHash` also as a `TxReceipt` with purpose `setMetadataState`.
3. **Timestamps.** `metadataMinedAt` is taken when the metadata receipt is available, and `indexedAt` when `waitForIndexer` returns. With `WAIT_FOR_INDEXER=false`, `indexedAt` stays unset.
4. **L1 data fee.** OP Stack receipts carry the L1 data fee in a non-standard field (`l1Fee`). If the receipt object exposes it, add `optional string l1Fee = 6;` to `TxReceipt`. Otherwise the benchmark reads it from the RPC by hash.
5. **XFSC responses** are unchanged.

**Acceptance criteria.**
- With a mocked Nautilus returning an NFT address, two published services and a metadata receipt, `receipts[0]` contains the DID, NFT address, both datatoken addresses and three transactions.
- `ids` is unchanged.
- The existing error path (on chain but not indexed) is unchanged.

### GW-5 — Full job details in the status response

**Current state.** `GetComputeToDataStatus` returns only `status` and `description`. The node's `NodeComputeJob`, as Nautilus returns it from `getComputeStatus`, also carries:
- `dateCreated`, `dateFinished`, `algoStartTimestamp`, `algoStopTimestamp`, `algoDuration`
- `environment`, `resources`, `isFree`, `maxJobDuration`, `queueMaxWaitTime`, `expireTimestamp`
- `payment` (`lockTx`, `claimTx`, `cancelTx`, `cost`, `token`)
- `results` (file names, types, sizes)
- `terminationDetails` (`exitCode`, `OOMKilled`)
- `runtimeMetrics`
- `inputDID`, `algoDID`

**Requirement.**

1. **Proto.**

   ```proto
   message ComputeToDataStatusRequest {
       string jobId = 1;
       optional string wallet = 2;          // GW-1
       // Return the job details below; defaults to false
       optional bool details = 3;
   }

   message ComputeJobResult {
       string filename = 1;
       string type = 2;          // e.g. "output", "algorithmLog", "configurationLog"
       optional uint64 filesize = 3;
       uint32 index = 4;         // usable as jobIndex in GetComputeToDataResult
   }

   message ComputeJobPayment {
       optional string token = 1;
       optional string cost = 2;
       optional string lockTx = 3;
       optional string claimTx = 4;
       optional string cancelTx = 5;
   }

   message ComputeToDataStatusResponse {
       int32 status = 1;
       string description = 2;
       // Set when details was requested
       optional string dateCreated = 3;
       optional string dateFinished = 4;
       optional string algoStartTimestamp = 5;
       optional string algoStopTimestamp = 6;
       optional double algoDuration = 7;
       optional string computeEnv = 8;
       repeated ComputeResource resources = 9;
       optional bool isFree = 10;
       optional ComputeJobPayment payment = 11;
       repeated ComputeJobResult results = 12;
       optional int32 exitCode = 13;
       optional bool oomKilled = 14;
       repeated string inputDids = 15;
       optional string algorithmDid = 16;
       // Container metrics as the node reports them
       optional google.protobuf.Struct runtimeMetrics = 17;
   }
   ```

2. **Timestamp format.** Node timestamps are passed through unchanged as strings. The README states their format, which may be Unix seconds or ISO 8601 depending on the node. The gateway does not reinterpret them.
3. **Log retrieval.** `GetComputeToDataResult` with `C2D_URI` and `jobIndex` set to a result's `index` already returns that file's URL. Document that this is how the algorithm log is fetched.
4. **Default off.** Without `details: true`, the response is exactly as today.

**Acceptance criteria.**
- With a mocked job that carries all fields, `details: true` returns them mapped.
- Without `details`, only `status` and `description` are set.
- A job without `payment` (free) leaves `payment` unset.

### GW-6 — Listing the node's compute environments

**Current state.** The environment is chosen by `computeEnv`, `COMPUTE_ENV`, or the node's first environment. Its resources, limits, free tier and prices are not visible through the gateway. Nautilus offers `getComputeEnvironments()`.

**Requirement.** A new RPC `GetComputeEnvironments` (empty request) returns, per environment:
- `id`, `description`
- `resources` (`id`, `min`, `max`, `inUse` where reported)
- `maxJobDuration`
- the free tier (its resources and maximum duration, if offered)
- per-chain fees (token and price per resource and minute) for the gateway's network
- the number of running and queued jobs, where the node reports them

Use `google.protobuf.Struct` for nested node-specific data that has no stable schema.

**Acceptance criteria.**
- With a mocked Nautilus returning two environments, the RPC returns both with their IDs, resources and fees.
- The RPC is listed by `GET /grpc/list`.

### GW-7 — Additional compute options pass-through (optional)

Add to `CreateComputeToDataRequest`:

| Field | Maps to | Purpose |
|---|---|---|
| `optional uint32 queueMaxWaitTime` | `ComputeConfig.queueMaxWaitTime` | Let a job wait in the node's queue instead of failing when resources are busy |
| `repeated string additionalViewers` | `ComputeConfig.additionalViewers` | Let a second address read the results, e.g. machine owners reading aggregation results |
| `map<string, string> algorithmEnvs` | `ComputeAlgorithmRef.envs` | Pass fixed environment variables (e.g. `OMP_NUM_THREADS`) into the container |

`additionalViewers` entries must be valid addresses (`INVALID_ARGUMENT` otherwise).

## 4. Out of scope

- Presenting verifiable credentials for assets behind an SSI policy. The benchmark uses address allow-lists instead.
- Multi-node operation. All calls go to the configured `OCEAN_NODE_URI`.
- Changes to the XFSC or Credential Event Service integrations.
- Changing the 30-second result fetcher. The benchmark fetches results through `C2D_URI` directly.

## 5. Delivery order

1. **GW-2** — unblocks every aggregation job.
2. **GW-3** and **GW-4** — unblock the transaction measurements.
3. **GW-5** — phase timing.
4. **GW-1** — only needed for the two-wallet setup; the one-wallet setup runs without it.
5. **GW-6**, then **GW-7**.

Each requirement is its own merge request with its tests and README changes, so the benchmark can pin the gateway commit it ran with.
