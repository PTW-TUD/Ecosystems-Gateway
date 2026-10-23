# Ecosystems Gateway

Ecosystems Gateway is a NestJS service that exposes a gRPC API for publishing,
updating, querying, and consuming Gaia-X-related service offerings across
supported ecosystems.

It currently integrates with:

- [Pontus-X](https://portal.euprogigant.io/search?sortOrder=desc&text=&sort=nft.created)
- [XFSC Catalog](https://gitlab.eclipse.org/eclipse/xfsc/cat/fc-service)
- [Gaia-X Credential Event Service](https://gitlab.com/gaia-x/lab/credentials-events-service/-/tree/main?ref_type=heads)

The protobuf API definition is maintained in
[src/\_proto/spp_v3.proto](./src/_proto/spp_v3.proto). The project can also
expose an HTTP gateway for tools and clients that do not call gRPC directly.

## Features

- Publish Pontus-X assets and XFSC self-descriptions.
- Update existing offerings and optionally publish credential/compliance update
  events to the Credential Event Service.
- Update Pontus-X lifecycle states.
- Retrieve and query offerings.
- Request access URLs for Pontus-X access services.
- Start Pontus-X compute-to-data jobs, poll their status, and fetch result URLs
  or cached result data.
- Expose gRPC reflection for development tooling.
- Expose an optional HTTP gateway and Swagger UI generated from the protobuf
  OpenAPI output.

## Tech Stack

- Node.js 22
- NestJS 11
- gRPC with `@grpc/grpc-js`
- `buf` and `ts-proto` for protobuf generation
- Vitest for unit and end-to-end tests
- Redis for compute-to-data job queues and cached results
- Docker and Docker Compose for containerized development

## API Surface

The protobuf service is named `eupg.ecosystemsgateway.v3.ecosystemsgateway`
(spp v3).

Available RPC methods:

| Method                    | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `CreateOffering`          | Publish one or more Pontus-X or XFSC offerings.           |
| `UpdateOffering`          | Update an existing Pontus-X or XFSC offering.             |
| `UpdateOfferingLifecycle` | Change the lifecycle state of an offering.                |
| `GetOffering`             | Retrieve offerings by ecosystem-specific lookup criteria. |
| `QueryOfferings`          | Search offerings. Pontus-X querying is implemented.       |
| `AccessService`           | Request a consumable access URL for a Pontus-X service.   |
| `RunComputeToDataJob`     | Start a Pontus-X compute-to-data job.                     |
| `GetComputeToDataStatus`  | Retrieve the current state of a compute-to-data job.      |
| `GetComputeToDataResult`  | Retrieve a compute-to-data result URL or cached data.     |

When the HTTP gateway is enabled, calls are available under:

- `GET /grpc/list`
- `POST /grpc/:method`
- `GET /docs`
- `GET /openapi.json`

For example:

```bash
curl http://localhost:3000/grpc/list
```

```bash
curl -X POST http://localhost:3000/grpc/GetOffering \
  -H "Content-Type: application/json" \
  -d '{"offerings":[{"pontusxOffering":{"did":"did:ope:..."}}]}'
```

### Changes From spp v2

spp v3 replaces spp v2; the gateway no longer serves v2. The methods, the HTTP
routes and most messages are the same, so a v2 client needs these changes:

- The package is `eupg.ecosystemsgateway.v3`, so the gRPC paths are
  `/eupg.ecosystemsgateway.v3.ecosystemsgateway/<Method>`. The HTTP routes
  (`/grpc/<Method>`) are unchanged.
- Renamed fields: `Metadata.licence` is `license`, `XfscOffering.VP` and
  `XfscUpdateOffering.VP` are `vp`, and `DebugInformation` is
  `debugInformation`. All field numbers start at 1 again, without the
  reserved v1 ranges.
- `Pricing.fixedRate` (an integer) is `Pricing.price`, a decimal string such as
  `"0.5"`, with at most the decimals of the payment token (6 for EURAU).
- `ComputeOptions.trustedAlgorithms` and `trustedPublishers` are messages:
  `{ "all": true }` trusts everything, otherwise the lists `algorithms`
  (`{ did, serviceIds }`) and `addresses` apply. Given on an update, they
  replace the stored ones instead of adding to them; not given, the stored ones
  are kept. The checksum fields of a trusted algorithm are gone: nautilus reads
  them from the algorithm's DDO.

New in v3:

- `Metadata`: `providedBy` (DDO v5; defaults to `PROVIDED_BY`, else the
  author), `displayTitle`, `copyrightHolder`, `language`, `categories` and
  `links` (label to URL).
- `CreateComputeToDataRequest`: the dataset's `serviceId`, the algorithm's
  `algorithmServiceId`, `algorithmUserdata` for the consumer parameters of the
  algorithm's service, `algorithmParameters` for those of the algorithm itself
  (`Metadata.algorithm.consumerParameters`), `computeEnv`, `resources`,
  `maxJobDuration` and `free` for the environment's free tier.

`QueryOfferings` now answers over gRPC as well; in v2 its handler was
registered under a misspelled service name.

## Prerequisites

- Node.js 22.12 or later
- npm
- Docker and Docker Compose, if you want to run the containerized setup
- Redis
- A wallet private key for publishing and consumption, funded on the selected
  chain (OP Sepolia ETH for gas, devEURAU for paid assets and compute)
- An IPFS or S3 store for publishing and updating Pontus-X offerings
- XFSC Catalog credentials if XFSC publishing is used

## Installation

```bash
npm install
```

## Configuration

Copy the example environment file and adjust it for your environment:

```bash
cp .env.example .env
```

The application reads configuration from environment variables through
`@nestjs/config`.

### General

| Key                      | Value                             | Description                                                                                                                                |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `REDIS_ADDRESS`          | `host:port`                       | Redis endpoint for compute-to-data queues and cached results. Defaults to `127.0.0.1:6379`.                                                |
| `ENABLE_GRPC_SERVER`     | `true` or `false`                 | Enables the gRPC server. Defaults to `true`.                                                                                               |
| `GRPC_BIND`              | `host:port`                       | Address the gRPC server listens on. Defaults to `0.0.0.0:5002`.                                                                            |
| `ENABLE_GRPC_REFLECTION` | `true` or `false`                 | Enables gRPC reflection for tools such as Postman or `grpcurl`. Defaults to `false`.                                                       |
| `ENABLE_GRPC_GATEWAY`    | `true` or `false`                 | Enables the HTTP gateway and Swagger UI. Defaults to `false`.                                                                              |
| `GRPC_GATEWAY_BIND`      | `host:port`                       | Address the HTTP gateway listens on. Defaults to `0.0.0.0:3000`.                                                                           |
| `NESTJS_LOG_LEVELS`      | Comma-separated NestJS log levels | `verbose`, `debug`, `log`, `warn`, `error`, `fatal`, e.g. `log,warn,debug`. Defaults to `log,warn`; `error` and `fatal` are always logged. |
| `LOG_FORMAT`             | `text` or `json`                  | `json` writes one JSON object per line, e.g. for a log collector. Defaults to `text`.                                                      |

Boolean options accept values such as `true`, `1`, `yes`, and `on`.

### Pontus-X

Pontus-X is integrated through [nautilus](https://github.com/deltaDAO/nautilus)
v2 (`2.0.0-beta.3`), which works against a single ocean-node instead of the
separate Aquarius and Provider services of v1, and publishes DDO v5 assets
(`did:ope:` DIDs).

The gateway runs on OP Sepolia (`OPSEPOLIA`, chain 11155420) by default,
against the ocean-node `https://node.demo.pontus-x.eu`. Its contract
addresses are the ones ocean.js ships for the chain, and
fixed prices are paid in devEURAU
([`0xD351…a588`](https://sepolia-optimism.etherscan.io/token/0xd35141583f374d401fee1bfddc35910e1d33a588),
6 decimals), which the demo node also charges compute fees in. The Pontus-X
devnet and testnet (`PONTUSXDEV`, `PONTUSXTEST`) are still supported, but no
public ocean-node serves them yet: they need `OCEAN_NODE_URI`.

| Network       | Chain    | Pricing types                                       |
| ------------- | -------- | --------------------------------------------------- |
| `OPSEPOLIA`   | 11155420 | `FREE`, `FIXED_EURAU`                               |
| `PONTUSXDEV`  | 32456    | `FREE`, `FIXED_OCEAN`, `FIXED_EUROE`, `FIXED_EURAU` |
| `PONTUSXTEST` | 32457    | `FREE`, `FIXED_OCEAN`, `FIXED_EUROE`, `FIXED_EURAU` |

| Key                    | Value                                                  | Description                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETWORK`              | `OPSEPOLIA`, `PONTUSXDEV` or `PONTUSXTEST`             | Network selection. Defaults to `OPSEPOLIA`.                                                                                                                                                                                                                                  |
| `PRIVATE_KEY`          | ECDSA private key                                      | Wallet private key used to sign Pontus-X transactions. Required for Pontus-X functionality.                                                                                                                                                                                  |
| `OCEAN_NODE_URI`       | URL                                                    | ocean-node for metadata, access and compute. Must be `https://` except on localhost. Defaults to `https://node.demo.pontus-x.eu` on `OPSEPOLIA`; required on the Pontus-X networks.                                                                                          |
| `RPC_URL`              | URL                                                    | Optional chain RPC override. Defaults to `https://sepolia.optimism.io`, or `https://rpc.{dev,test}.pontus-x.eu`.                                                                                                                                                             |
| `VERIFICATION_RPC_URL` | URL                                                    | Optional second RPC of the same chain. Lets nautilus safely resend an order or payment refused for its nonce; without it such a transaction is never sent again.                                                                                                             |
| `PROVIDED_BY`          | String                                                 | Optional organisation providing the assets (DDO v5 `providedBy`). Defaults to the offering's author.                                                                                                                                                                         |
| `DDO_STORE`            | `ipfs` or `s3`                                         | Where the node-encrypted DDO is stored. Required to create and update offerings; reading and consuming work without it.                                                                                                                                                      |
| `IPFS_UPLOAD_URL`      | URL                                                    | For `ipfs`: an upload endpoint taking a multipart file, e.g. Kubo `/api/v0/add` or Pinata `pinFileToIPFS`.                                                                                                                                                                   |
| `IPFS_JWT`             | String                                                 | Optional, sent as `Authorization: Bearer`.                                                                                                                                                                                                                                   |
| `IPFS_GATEWAY_URL`     | URL                                                    | Gateway the stored DDO is read back from before it is referenced on chain. Required for anything but Kubo, unless `IPFS_VERIFY=false`.                                                                                                                                       |
| `S3_*`                 | See [.env.example](./.env.example)                     | For `s3`: endpoint, bucket, and a write and a separate read-only key pair. The read key is written, node-encrypted, into every on-chain pointer.                                                                                                                             |
| `MAX_PROVIDER_FEE`     | `<token>:<amount>`, comma separated                    | Most provider fee paid per access or compute input, in the token's smallest unit. Unset: only zero fees are paid.                                                                                                                                                            |
| `MAX_ESCROW_PAYMENT`   | `<token>:<amount>`, comma separated                    | Most a compute job may lock in escrow, in the token's smallest unit. Unset: a job that needs an escrow payment is refused before anything is spent.                                                                                                                          |
| `ESCROW_ADDRESS`       | Ethereum address                                       | The chain's EnterpriseEscrow contract, the only one paid compute funds. Unset, nautilus uses the EnterpriseEscrow of Ocean's address data, which on OP Sepolia is the demo node's (`0xfa48…7B02`). Needed for paid compute on Pontus-X, for which the address data has none. |
| `COMPUTE_ENV`          | String                                                 | Optional compute environment id. Defaults to the ocean-node's first environment.                                                                                                                                                                                             |
| `NAUTILUS_LOG_LEVEL`   | `silent`, `error`, `warn`, `info`, `debug`, or `trace` | Nautilus log level; its events, redacted by nautilus, are logged through the NestJS logger with the context `Nautilus:<component>`. Defaults to the most verbose of `NESTJS_LOG_LEVELS`. The v1 values `none`, `log` and `verbose` still work.                               |
| `NAUTILUS_DEBUG`       | `sensitive` or `secrets`                               | Nautilus' debug channel with the raw data it otherwise redacts, written to stderr apart from the logs. `NAUTILUS_DEBUG_TOPICS` narrows it, e.g. `policy,wallet`. Never in production.                                                                                        |

### Credential Event Service

The Credential Event Service integration is used during `UpdateOffering` calls
that include `publishInfo`. In that case, the gateway wraps the supplied
credential data in a CloudEvent and publishes it to `CES_URL`, returning the
created event location in the update response.

| Key       | Value | Description                              |
| --------- | ----- | ---------------------------------------- |
| `CES_URL` | URL   | Credential Event Service publish target. |

### XFSC Catalog

The XFSC Catalog integration uses OAuth 2.0 password flow.

| Key                         | Value  | Description                             |
| --------------------------- | ------ | --------------------------------------- |
| `XFSC_CAT_HOST_SD_ENDPOINT` | URL    | XFSC Catalog self-description endpoint. |
| `XFSC_CAT_TOKEN_ENDPOINT`   | URL    | OIDC token endpoint.                    |
| `CLIENT_ID`                 | String | OAuth client ID.                        |
| `CLIENT_SECRET`             | String | OAuth client secret.                    |
| `XFSC_USERNAME`             | String | XFSC user name.                         |
| `XFSC_PASSWORD`             | String | XFSC user password.                     |

## Running Locally

Start the application directly:

```bash
npm run start
```

Start in watch mode:

```bash
npm run start:dev
```

Build and run the compiled application:

```bash
npm run build
npm run start:prod
```

By default, only the gRPC server is enabled. To use the HTTP gateway and Swagger
UI, set:

```bash
ENABLE_GRPC_GATEWAY=true
```

Then open:

- gRPC: `localhost:5002`
- HTTP gateway: `http://localhost:3000/grpc`
- Swagger UI: `http://localhost:3000/docs`

## Running With Docker

The development Compose file builds the gateway from the local checkout and
starts Redis as the backing service:

```bash
docker compose -f docker-compose_dev.yml up --build
```

It exposes:

- `5002` for gRPC
- `3000` for the HTTP gateway, if enabled
- `6379` for Redis
- `8081` for Redis Commander

The repository also contains [docker-compose.yml](./docker-compose.yml), which
includes example Pontus-X development environment values and Traefik labels.
Treat the embedded values as examples and replace them before using the file in
your own environment.

Build the Docker image manually:

```bash
docker build -t ecosystems-gateway .
```

Run it with your `.env` file:

```bash
docker run --env-file .env -p 5002:5002 -p 3000:3000 ecosystems-gateway
```

## Protobuf, Runtime Proto, And OpenAPI

The API is defined in [src/\_proto/spp_v3.proto](./src/_proto/spp_v3.proto),
the only file to edit. `npm run proto:gen` generates from it:

- [src/generated/spp_v3.ts](./src/generated/spp_v3.ts), the TypeScript types
  (`buf` with ts-proto),
- [src/openapi/spp_v3.swagger.json](./src/openapi/spp_v3.swagger.json), the
  OpenAPI document (`buf` with grpc-gateway's openapiv2 plugin),
- [src/\_proto_runtime/spp_v3.runtime.proto](./src/_proto_runtime/spp_v3.runtime.proto),
  which the gRPC server and the HTTP gateway load
  ([scripts/generate-runtime-proto.mjs](./scripts/generate-runtime-proto.mjs)).
  It is the proto without its `protoc-gen-openapiv2` annotations, which
  `@grpc/proto-loader` cannot load.

```bash
npm run proto:gen       # generated types, OpenAPI document and runtime proto
npm run proto:lint      # buf lint
npm run proto:breaking  # wire-incompatible changes against the main branch
```

The generated files are committed, and the Docker build uses them as they are.
CI runs the lint and breaking checks and fails when regenerating changes
`src/generated`, `src/openapi` or `src/_proto_runtime`;
[src/proto-sync.spec.ts](./src/proto-sync.spec.ts) also checks that the runtime
proto is current. The breaking check starts once the proto files exist on the
main branch. Both `buf` plugins are pinned in [buf.gen.yaml](./buf.gen.yaml)
and the dependencies in `buf.lock`, so the output only changes with the proto.
The plugins run remotely on the Buf Schema Registry, so generating needs
network access. The lint configuration in [buf.yaml](./buf.yaml) leaves out the
naming rules the API does not follow: field names are camelCase without
underscores, as in v2.

Unset `optional` fields are missing from the requests the server decodes, and
unset message fields are `null`; the service code checks for both.

## Testing And Quality

```bash
# unit tests
npm run test

# end-to-end tests
npm run test:e2e

# coverage
npm run test:cov

# unit tests in watch mode
npm run test:watch

# lint
npm run lint

# formatting check
npm run format-check
```

## Development Notes

- Compute-to-data result data is cached in Redis for one hour. With
  compute-to-data v2 the result is the job's `outputs.tar`, a tar archive of
  the algorithm's output folder, so `C2D_DATA` returns that archive base64
  encoded.
- Compute job ids are ocean-node ids (`<environmentHash>-<jobId>`). Jobs of
  nautilus v1 still queued in Redis are dropped by the result poller.
- Access is gated by the offering's wallet address lists (`credentials`), which
  the ocean-node, or its policy server, checks before anything is ordered or
  paid. In nautilus v2 an empty or missing allow list denies everyone, so an
  offering without allow addresses is published with `allow: ['*']`.
  `UpdateOffering` with `credentials` replaces the stored address lists (an
  empty allow list opens the offering to everyone again); without
  `credentials` they are kept. Access lists and SSI policies set by other tools
  are kept either way.
- A refusal by the policy server is returned as `PERMISSION_DENIED`, with the
  failed policy names in the error details; a service whose SSI policy the
  policy server cannot read, or that requires verifiable credentials, as
  `FAILED_PRECONDITION`: the gateway has no wallet to present credentials from.
- DDO v5 only allows primitive values in `additionalInformation`, so nested
  values such as `gaiaXInformation` are stored as JSON strings.
- The gateway is an ES module package (`"type": "module"`), as nautilus v2 is:
  relative imports carry a `.js` extension, and ts-proto generates them that way
  (`importSuffix=.js` in [buf.gen.yaml](./buf.gen.yaml)). The tests run on Vitest
  ([vitest.config.ts](./vitest.config.ts), projects `unit` and `e2e`), which
  loads ES modules natively; specs import `describe`, `it`, `expect` and `vi`
  from `vitest`.
- Requests are logged at `verbose` level with data source headers, `userdata`
  and other credentials masked. Errors caused by a request are logged as
  warnings, others as errors with their stack; a failed nautilus call carries
  the id of its operation (`x-nautilus-op-id` in the gRPC error metadata, and in
  the log line), which nautilus' own log lines of that call show too. A lost
  Redis connection is logged once per outage, not once per reconnect attempt.
- Pontus-X write operations are serialized with a mutex because they use the
  configured wallet key.
- `GetComputeToDataResult` can return either an ocean-node result URL or base64
  encoded cached data, depending on `computeToDataReturnType`.
- gRPC reflection is useful during development but should be enabled deliberately.
- The HTTP gateway is disabled by default and must be enabled explicitly with
  `ENABLE_GRPC_GATEWAY=true`.

## Current Limitations

- XFSC lifecycle updates are not implemented.
- XFSC access through `AccessService` is not implemented.
- XFSC query support is not implemented.
- Supported networks are `OPSEPOLIA` (the default), `PONTUSXDEV` and
  `PONTUSXTEST`. `QueryOfferings` only returns offerings of the selected chain.
- Pontus-X support is based on the nautilus v2 beta, whose API may still change.
- `QueryOfferings` sends an Elasticsearch query; ocean-nodes using Typesense
  are not supported.
- Changing the payment token of a Pontus-X service is not supported, only its
  price.
- File services currently assume URL-based files.

## License

```text
Copyright (C) 2025 PTW | TU Darmstadt, Posedio GmbH, Brinkhaus GmbH

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```
