# Ecosystems Gateway

Ecosystems Gateway is a NestJS service that exposes a gRPC API for publishing,
updating, querying, and consuming Gaia-X-related service offerings across
supported ecosystems.

It currently integrates with:

- [Pontus-X](https://portal.euprogigant.io/search?sortOrder=desc&text=&sort=nft.created)
- [XFSC Catalog](https://gitlab.eclipse.org/eclipse/xfsc/cat/fc-service)
- [Gaia-X Credential Event Service](https://gitlab.com/gaia-x/lab/credentials-events-service/-/tree/main?ref_type=heads)

The protobuf API definition is maintained in
[src/\_proto/spp_v2.proto](./src/_proto/spp_v2.proto). The project can also
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
- Redis for compute-to-data job queues and cached results
- Docker and Docker Compose for containerized development

## API Surface

The protobuf service is named `eupg.ecosystemsgateway.ecosystemsgateway`.

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
  -d '{"offerings":[{"pontusxOffering":{"did":"did:op:..."}}]}'
```

## Prerequisites

- Node.js 22
- npm
- Docker and Docker Compose, if you want to run the containerized setup
- Redis
- A Pontus-X wallet private key for Pontus-X publishing and consumption
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

| Key                      | Value                             | Description                                                                                 |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `REDIS_ADDRESS`          | `host:port`                       | Redis endpoint for compute-to-data queues and cached results. Defaults to `127.0.0.1:6379`. |
| `ENABLE_GRPC_SERVER`     | `true` or `false`                 | Enables the gRPC server. Defaults to `true`.                                                |
| `GRPC_BIND`              | `host:port`                       | Address the gRPC server listens on. Defaults to `0.0.0.0:5002`.                             |
| `ENABLE_GRPC_REFLECTION` | `true` or `false`                 | Enables gRPC reflection for tools such as Postman or `grpcurl`. Defaults to `false`.        |
| `ENABLE_GRPC_GATEWAY`    | `true` or `false`                 | Enables the HTTP gateway and Swagger UI. Defaults to `false`.                               |
| `GRPC_GATEWAY_BIND`      | `host:port`                       | Address the HTTP gateway listens on. Defaults to `0.0.0.0:3000`.                            |
| `NESTJS_LOG_LEVELS`      | Comma-separated NestJS log levels | Example: `log,error,warn,debug,verbose`. Defaults to `log`.                                 |

Boolean options accept values such as `true`, `1`, `yes`, and `on`.

### Pontus-X

| Key                  | Value                                        | Description                                                                                 |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `NETWORK`            | `PONTUSXDEV` or `PONTUSXTEST`                | Pontus-X network selection. Required for Pontus-X functionality.                            |
| `PRIVATE_KEY`        | ECDSA private key                            | Wallet private key used to sign Pontus-X transactions. Required for Pontus-X functionality. |
| `PROVIDER_URL`       | URL                                          | Optional custom Ocean Provider URL.                                                         |
| `PROVIDER_ADDRESS`   | Ethereum address                             | Optional custom Ocean Provider address.                                                     |
| `NAUTILUS_LOG_LEVEL` | `none`, `error`, `warn`, `log`, or `verbose` | Nautilus log level. Defaults to `log`.                                                      |

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

Generated TypeScript protobuf types and OpenAPI output are created with `buf`:

```bash
npm run proto:gen
```

Important generated outputs include:

- [src/generated/spp_v2.ts](./src/generated/spp_v2.ts)
- [src/openapi/spp_v2.swagger.json](./src/openapi/spp_v2.swagger.json)

The runtime proto used by the NestJS gRPC server is maintained manually at
[src/\_proto_runtime/spp_v2.runtime.proto](./src/_proto_runtime/spp_v2.runtime.proto).
It mirrors the service and message definitions needed at runtime without the
OpenAPI annotations that cause loader issues.

After changing [src/\_proto/spp_v2.proto](./src/_proto/spp_v2.proto), run
`npm run proto:gen` and update
[src/\_proto_runtime/spp_v2.runtime.proto](./src/_proto_runtime/spp_v2.runtime.proto)
where the runtime service definition needs to change.

## Testing And Quality

```bash
# unit tests
npm run test

# end-to-end tests
npm run test:e2e

# coverage
npm run test:cov

# lint
npm run lint

# formatting check
npm run format-check
```

## Development Notes

- Compute-to-data result data is cached in Redis for one hour.
- Pontus-X write operations are serialized with a mutex because they use the
  configured wallet key.
- `GetComputeToDataResult` can return either a provider result URL or base64
  encoded cached data, depending on `computeToDataReturnType`.
- gRPC reflection is useful during development but should be enabled deliberately.
- The HTTP gateway is disabled by default and must be enabled explicitly with
  `ENABLE_GRPC_GATEWAY=true`.

## Current Limitations

- XFSC lifecycle updates are not implemented.
- XFSC access through `AccessService` is not implemented.
- XFSC query support is not implemented.
- Pontus-X currently supports `PONTUSXDEV` and `PONTUSXTEST`.
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
